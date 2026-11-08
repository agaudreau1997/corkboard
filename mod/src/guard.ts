// The card-id rule, enforced rather than asked for. A session Corkboard started for a card is
// told, in its prompt, to put a `Card: <ID>` trailer on every commit of a personal project and to
// keep every card id out of a work project's repo; this reads the Bash calls it makes and refuses
// the ones that break the rule.
//
// It refuses rather than warns: the model can fix the command and run it again, while a card id
// pushed to a client's repo cannot be taken back. It is not a security boundary — a hook sees its
// own session's tool calls and nothing else, and what it cannot read it lets through.

/** What the guard knows about the session, from the environment (`session.ts`). */
export type GuardSession = {
  /** The cards this session was started for. */
  cards: string[]
  /** The prefix every card id of the board carries: the work rule matches every id, not only this session's. */
  prefix: string
  work: boolean
  /** The Jira keys of the session's cards, when the pane has read them: the refusal names them. */
  keys?: string[]
  /** Where the session runs: the code repo, or a worktree of it. Only commands there are judged. */
  repo?: string
}

/** A path as this comparison needs it: one separator, one case, no trailing one. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `path` is `folder` or somewhere below it. */
export function isInside(path: string, folder: string): boolean {
  const inside = normalizePath(path)
  const outer = normalizePath(folder)
  return !!outer && (inside === outer || inside.startsWith(`${outer}/`))
}

/**
 * The command works on another repo than the session's, so it is none of the guard's business: a
 * `-C`, `--git-dir` or `--work-tree` that does not point inside it. A relative path other than `.`
 * counts as elsewhere, because the guard cannot resolve it.
 */
function elsewhere(tokens: string[], repo?: string): boolean {
  const given = values(tokens, ['-C', '--git-dir', '--work-tree'])
  if (!given.length) return false
  return given.some(path => {
    if (path === '.' || path === './') return false
    if (!repo) return true
    const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
    return absolute ? !isInside(path, repo) : true
  })
}

/** A refusal, with the reason the model reads, or nothing to say. */
export type Verdict = { deny: string } | undefined

/** A `git commit` the guard could not read a message for; it is let through. */
const UNREADABLE = Symbol('unreadable')

/**
 * The files the guard needs read before it can judge: a commit message in a file (`-F`, `-t`) and
 * a pull request's body (`--body-file`). The hook reads them and hands back what it got; a file it
 * could not read leaves that command unreadable, and unreadable is let through.
 */
export function guardFiles(command: string): string[] {
  const files: string[] = []
  for (const tokens of segments(command)) {
    for (const [i, token] of tokens.entries()) {
      const flagged = /^(?:-F|-t|--file|--body-file|--template)=(.+)$/.exec(token)
      if (flagged) files.push(flagged[1])
      else if (['-F', '-t', '--file', '--body-file', '--template'].includes(token) && tokens[i + 1]) files.push(tokens[i + 1])
    }
  }
  return [...new Set(files.filter(file => file !== '-'))]
}

/**
 * Whether the Bash call may run. `files` holds the contents of `guardFiles`'s paths, by path.
 */
export function guard(command: string, session: GuardSession, files: Record<string, string> = {}): Verdict {
  const bodies = heredocs(command)
  for (const tokens of segments(command)) {
    if (elsewhere(tokens, session.repo)) continue
    const verdict = session.work ? judgeWork(tokens, bodies, files, session) : judgeTrailer(tokens, bodies, files, session)
    if (verdict) return verdict
  }
  return undefined
}

/** A personal project: a commit of a card's session carries a `Card: <ID>` trailer. */
function judgeTrailer(
  tokens: string[],
  bodies: string[],
  files: Record<string, string>,
  session: GuardSession,
): Verdict {
  if (!isGit(tokens, 'commit') || !session.cards.length) return undefined
  const message = commitMessage(tokens, bodies, files)
  // A message git writes itself (a merge, a revert, a `rebase --continue`, an `--amend` that keeps
  // the message it has) is not the session's to put a trailer on, and a message the guard cannot
  // read is not its to judge.
  if (message === UNREADABLE) return undefined
  if (session.cards.some(id => namesTrailer(message, id))) return undefined
  const want = session.cards.map(id => `Card: ${id}`).join('\n')
  return {
    deny: `Corkboard: this commit has no card trailer. Add it to the message and commit again:\n${want}`,
  }
}

/** A work project: no card id of the board reaches the code repo, in any of the ways it could. */
function judgeWork(tokens: string[], bodies: string[], files: Record<string, string>, session: GuardSession): Verdict {
  if (!session.prefix) return undefined
  const named = (text: string): string | undefined => boardIds(text, session.prefix)[0]
  const refuse = (id: string, what: string): Verdict => ({
    deny: `Corkboard: ${id} is a card id of the task board and must not reach this repo (${what}). ${instead(session)}`,
  })

  if (isGit(tokens, 'commit')) {
    const message = commitMessage(tokens, bodies, files)
    const id = message === UNREADABLE ? undefined : named(message)
    if (id) return refuse(id, 'a commit message')
  }
  if (isGit(tokens, 'branch') || isGit(tokens, 'checkout') || isGit(tokens, 'switch') || isGit(tokens, 'tag')) {
    const id = named(tokens.filter(token => !token.startsWith('-')).join(' '))
    if (id) return refuse(id, 'a branch or tag name')
  }
  if (isCommand(tokens, 'gh', ['pr', 'create']) || isCommand(tokens, 'gh', ['pr', 'edit'])) {
    const id = named([...values(tokens, ['--title', '-t', '--body', '-b']), ...bodies, ...fileTexts(tokens, files)].join('\n'))
    if (id) return refuse(id, "a pull request's title or body")
  }
  return undefined
}

/** What to write instead: the Jira keys the session knows, or the rule in general. */
function instead(session: GuardSession): string {
  const keys = (session.keys ?? []).filter(Boolean)
  return keys.length ? `Name the Jira key ${keys.join(' or ')} instead.` : 'Name the card’s Jira key instead.'
}

/** The message a `git commit` would use, or UNREADABLE when the guard cannot know it. */
function commitMessage(
  tokens: string[],
  bodies: string[],
  files: Record<string, string>,
): string | typeof UNREADABLE {
  const texts = values(tokens, ['-m', '--message'])
  const fromFiles = fileTexts(tokens, files)
  const wantsFile = tokens.some(
    token => ['-F', '--file', '-t', '--template'].includes(token) || /^(?:-F|--file|-t|--template)=/.test(token),
  )
  const stdin = tokens.includes('-') || tokens.some(token => /^(?:-F|--file)=-$/.test(token))
  if (texts.some(text => text.includes('$(') || text.includes('`'))) return UNREADABLE
  if (wantsFile && !fromFiles.length && !(stdin && bodies.length)) return UNREADABLE
  const parts = [...texts, ...fromFiles, ...(stdin ? bodies : [])]
  if (!parts.length) return UNREADABLE
  return parts.join('\n\n')
}

/** The contents of the files this command names, as far as they were read. */
function fileTexts(tokens: string[], files: Record<string, string>): string[] {
  return guardFiles(tokens.join(' '))
    .map(file => files[file])
    .filter((text): text is string => typeof text === 'string')
}

/** The values a repeatable option was given (`-m one -m two`, `--title=x`). */
export function values(tokens: string[], flags: string[]): string[] {
  const out: string[] = []
  for (const [i, token] of tokens.entries()) {
    const joined = flags.map(flag => `${flag}=`).find(prefix => token.startsWith(prefix))
    if (joined) out.push(token.slice(joined.length))
    else if (flags.includes(token) && tokens[i + 1] !== undefined) out.push(tokens[i + 1])
  }
  return out
}

/** A `git <verb>` call, whatever options come before the verb (`git -C dir commit`). */
export function isGit(tokens: string[], verb: string): boolean {
  return isCommand(tokens, 'git', [verb])
}

/** A call of `program` whose first non-option words are `words`. */
export function isCommand(tokens: string[], program: string, words: string[]): boolean {
  if (!tokens.length) return false
  const name = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '')
  if (name !== program) return false
  const rest: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    // The options `git` itself takes before its verb, the two of them that take a value included.
    if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
      i++
      continue
    }
    if (token.startsWith('-')) continue
    rest.push(token)
    if (rest.length === words.length) break
  }
  return words.every((word, i) => rest[i] === word)
}

/** The ids of the board a text names, between non-alphanumerics (CORK-10 is not in CORK-101). */
export function boardIds(text: string, prefix: string): string[] {
  if (!prefix) return []
  const found = text.toUpperCase().match(new RegExp(`(?:^|[^A-Z0-9])(${escape(prefix.toUpperCase())}-\\d+)(?![A-Z0-9])`, 'g'))
  return [...new Set((found ?? []).map(hit => hit.replace(/^[^A-Z0-9]+/, '')))]
}

/** A `Card:` trailer line of the message names this card (one trailer may name several). */
export function namesTrailer(message: string, id: string): boolean {
  const wanted = id.trim().toUpperCase()
  for (const line of message.split('\n')) {
    const trailer = /^\s*Card:\s*(.+?)\s*$/i.exec(line)
    if (trailer && trailer[1].split(/[,\s]+/).some(named => named.trim().toUpperCase() === wanted)) return true
  }
  return false
}

/**
 * The simple commands of a shell line, each as its words: split on the operators, with quotes and
 * `$(…)` kept whole. It is a reading, not a shell: what it cannot make sense of ends up as words
 * the rules do not match, which lets the command through.
 */
export function segments(command: string): string[][] {
  const out: string[][] = []
  let tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let depth = 0
  const endToken = () => {
    if (token) tokens.push(token)
    token = ''
  }
  const endSegment = () => {
    endToken()
    if (tokens.length) out.push(tokens)
    tokens = []
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\\' && command[i + 1]) {
      token += command[++i]
      continue
    }
    if (char === '$' && command[i + 1] === '(') depth++
    if (depth) {
      token += char
      if (char === ')') depth--
      continue
    }
    if (char === '&' || char === '|' || char === ';' || char === '\n') {
      endSegment()
      continue
    }
    if (char === '<' && command[i + 1] === '<') {
      // A heredoc's body is not part of the command's words; `heredocs` reads it.
      const rest = command.slice(i)
      const tag = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest)
      if (tag) {
        // The terminator line ends the command as well as the body, so what follows is the next
        // command, not more words of this one.
        const body = new RegExp(`\\n${tag[2]}\\s*(?:\\n|$)`).exec(command.slice(i))
        i += body ? body.index + body[0].length - 1 : rest.length
        endSegment()
        continue
      }
    }
    if (/\s/.test(char)) {
      endToken()
      continue
    }
    token += char
  }
  endSegment()
  return out
}

/** The bodies of the command's heredocs, which is where a message often is. */
export function heredocs(command: string): string[] {
  const bodies: string[] = []
  const starts = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  for (let found = starts.exec(command); found; found = starts.exec(command)) {
    const after = command.slice(found.index + found[0].length)
    const end = new RegExp(`\\n${found[2]}\\s*(?:\\n|$)`).exec(after)
    bodies.push((end ? after.slice(0, end.index) : after).replace(/^\n/, ''))
  }
  return bodies
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
