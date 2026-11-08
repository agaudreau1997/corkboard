// A card as the pane shows it, from two places: the app's board tools over the MCP connection the
// session already has, and — with the app closed, when there is no server to ask — the card file
// in the board repo, which the session can always read.
//
// The file is read without a YAML parser: a hooks module has no npm packages, and the pane needs
// four keys and the body. A card file is `---`, front matter, `---`, then the description, written
// by the app's `serializeCard`, so the keys it reads are one per line.

export type Commit = { sha: string; subject: string }

/** A card as the pane draws it. */
export type PaneCard = {
  id: string
  title: string
  /** The title of the list it is in, or '' for a card that only lives on the map. */
  listTitle: string
  description: string
  links: string[]
  jira?: string
  /** The commits that name it, newest first. */
  commits: Commit[]
  /** Where it was read: the app's tools, or the card file with the app closed. */
  from: 'app' | 'file'
}

/** The name the app's MCP server goes by in a session's config. */
export const BOARD_SERVER = 'corkboard'

/**
 * The JSON a board tool answered, out of the MCP result it comes wrapped in
 * (`{ content: [{ type: 'text', text }] }`); undefined for a refusal or anything unexpected, so
 * the caller falls back to the file.
 */
export function toolJson(result: unknown): Record<string, unknown> | undefined {
  const answer = result as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined
  if (!answer || answer.isError) return undefined
  const text = answer.content?.find(part => part.type === 'text')?.text
  if (!text) return undefined
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The file a board's card is in: the board folder holds a `cards/` of `<ID>.md`. */
export function cardFile(boardDir: string, id: string): string {
  const separator = boardDir.includes('\\') && !boardDir.includes('/') ? '\\' : '/'
  return `${boardDir.replace(/[\\/]$/, '')}${separator}cards${separator}${id}.md`
}

/**
 * The host commands that print a file, for a card file `$.fs.readFile` will not open: that one
 * reads inside the project only, and the board repo is somewhere else entirely (a session runs in
 * the code repo). A POSIX shell first, then `cmd.exe`, as for the session's environment; the path
 * is an argument in both, never part of a command line, so a folder with a space in it is fine.
 */
export function fileCommands(file: string): string[][] {
  return [
    ['sh', '-c', 'cat -- "$1"', 'sh', file],
    ['cmd', '/c', 'type', file],
  ]
}

/** A card out of what `get_card` answered. */
export function cardFromTool(json: Record<string, unknown>): PaneCard {
  const text = (key: string): string => (typeof json[key] === 'string' ? (json[key] as string) : '')
  const list = text('listTitle') || text('list')
  return {
    id: text('id'),
    title: text('title'),
    listTitle: list,
    description: text('description'),
    links: Array.isArray(json.links) ? json.links.filter((l): l is string => typeof l === 'string') : [],
    ...(text('jira') ? { jira: text('jira') } : {}),
    commits: [],
    from: 'app',
  }
}

/** A card out of its file, for a session whose app is closed. */
export function cardFromFile(text: string, id: string): PaneCard {
  const body = text.replace(/\r\n/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  const head = front ? front[1] : ''
  const description = front ? body.slice(front[0].length) : body
  const value = (key: string): string => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head)
    return found ? unquote(found[1].trim()) : ''
  }
  const list = value('list')
  return {
    id: value('id') || id,
    title: value('title'),
    // The file has the list's id, not its title: the app's board.json holds the titles.
    listTitle: list && list !== 'null' ? list : '',
    description: description.trim(),
    links: listValue(head, 'links'),
    ...(value('jira') ? { jira: value('jira') } : {}),
    commits: [],
    from: 'file',
  }
}

/**
 * A list of strings in the front matter. The app writes one item per line (`links:` then
 * `  - CORK-1`); a hand-edited file may hold the inline form (`links: [CORK-1, CORK-2]`), so both
 * are read.
 */
function listValue(head: string, key: string): string[] {
  const inline = new RegExp('^' + key + ':[ \\t]*\\[(.*)\\][ \\t]*$', 'm').exec(head)
  if (inline) return items(inline[1].split(','))
  const block = new RegExp('^' + key + ':[ \\t]*\\n((?:[ \\t]+-[^\\n]*\\n?)+)', 'm').exec(head)
  if (!block) return []
  return items(block[1].split('\n').map(line => line.replace(/^[ \t]*-[ \t]*/, '')))
}

function items(raw: string[]): string[] {
  return raw.map(item => unquote(item.trim())).filter(Boolean)
}

function unquote(text: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
  return quoted ? quoted[2].replace(/\\"/g, '"').replace(/''/g, "'") : text
}
