// The tackle buttons: build the prompt, start `claude` in an embedded terminal, and record the
// session on each card (so it can be resumed) while moving the cards to the board's doing list.
// A session in a terminal or a worktree also gets the app's MCP server (mcp.ts), when it runs:
// its config is a file, passed with `--mcp-config`, and its prompt then says to use the tools.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BOARD_GUIDE_FILE } from '@shared/boardguide'
import { isDivider, slugify } from '@shared/cardfile'
import { discussPrompt, type Purpose, sessionName, tacklePrompt, untanglePrompt } from '@shared/prompts'
import { findCycle, tackleGroups } from '@shared/tackleorder'
import type { Card, PtyInfo, SessionRef, TackleRequest } from '@shared/types'
import {
  continueUrl,
  findDesktopSession,
  importUrl,
  newSessionUrl,
  openUrl,
} from './desktop'
import type { PtyManager } from './pty'
import type { BoardStore } from './store'

/** Test seam: a stand-in for the `claude` executable. */
export const CLAUDE = process.env.CORKBOARD_CLAUDE_BIN || 'claude'
const CLOUD_URL = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_\-/]+/

export type OpenExternal = (url: string) => Promise<void>

/**
 * Starts sessions for `req`'s cards; `boardKey` is the board's key in the window, for its
 * terminals, `mcpConfig` the MCP server's config file, when the server runs, and `pluginDir` the
 * companion mod's folder, when this build ships one.
 */
export async function tackle(
  req: TackleRequest,
  store: BoardStore,
  ptys: PtyManager,
  open: OpenExternal,
  boardKey?: string,
  mcpConfig?: string,
  pluginDir?: string,
): Promise<PtyInfo[]> {
  const board = store.board(req.boardPath)
  const cards = req.cardIds
    .map(id => board.cards.find(c => c.id === id))
    .filter((c): c is Card => !!c && !c.archived && !isDivider(c))
  if (!cards.length) throw new Error('No cards to work on (dividers and archived cards are skipped).')
  const purpose: Purpose = req.purpose ?? 'tackle'
  const discuss = purpose !== 'tackle'
  if (purpose === 'discuss' && (req.mode === 'cloud' || req.mode === 'local-worktree')) {
    throw new Error('A discussion runs in Claude desktop or a terminal.')
  }
  if (purpose === 'untangle') {
    if (req.mode !== 'local') throw new Error('An untangle runs in a terminal.')
    if (!cards.some(c => c.renumbered?.length)) throw new Error('None of these cards was renumbered by a sync.')
  }
  const loop = discuss ? undefined : findCycle(cards)
  if (loop) throw new Error(`These cards wait on each other in a loop: ${[...loop, loop[0]].join(' → ')}. Change one's "after" first.`)
  const cwd = sessionDir(store, req.boardPath)
  // A discussion (or an untangle) of several cards is one conversation: triage needs them side by
  // side. A tackle keeps the cards an order joins in one session, prerequisites first.
  const groups = discuss ? [cards] : tackleGroups(cards, req.split)
  // A group of a split tackle is named after its own cards: its list's title would give every
  // group the same name, and the same worktree.
  const groupTitle = groups.length > 1 ? undefined : (req.listTitle ?? req.boardTitle)
  const opened: PtyInfo[] = []

  for (const group of groups) {
    const ids = group.map(c => c.id)
    const cloud = req.mode === 'cloud'
    // Only a session in a terminal or a worktree can be handed the server or the mod: the cloud
    // can't reach this machine, and a claude:// link carries neither an MCP config nor an argv.
    const here = req.mode === 'local' || req.mode === 'local-worktree'
    const mcp = here ? mcpConfig : undefined
    const mod = here ? pluginDir : undefined
    const prompt = buildPrompt(store, req, group, !!mcp)
    const name = sessionName(group, groupTitle, purpose)
    const recorded = purpose === 'tackle' ? {} : { purpose }
    const started = new Date().toISOString()
    let ref: SessionRef
    let command: string[]
    let worktreeDir: string | undefined

    if (req.mode === 'desktop') {
      // A new session in the Claude desktop app, in the code repo. One folder only: given the board
      // repo as a second, the app ignored both and opened the last folder it used. The session
      // reaches the cards by the paths in the prompt. The link can't pick a branch, and a draft
      // sent without one starts with no folder: the prompt has the session move itself.
      const { url, marker } = newSessionUrl(prompt, cwd)
      await recordSession(store, req.boardPath, group, { kind: 'desktop', started, cwd, cards: ids, name, ...recorded })
      await openUrl(url, open)
      watchForDesktopSession(store, req.boardPath, ids, started, marker)
      continue
    }

    if (cloud) {
      ref = { kind: 'cloud', started, cwd, cards: ids, name }
      command = [CLAUDE, '--cloud', prompt]
    } else {
      const id = randomUUID()
      const worktree = req.mode === 'local-worktree' ? worktreeName(group, groupTitle && req.listTitle, !!store.settings.work) : undefined
      command = localCommand({ claude: CLAUDE, boardRoot: store.root, name, sessionId: id, worktree, mcpConfig: mcp, pluginDir: mod, prompt })
      worktreeDir = worktree ? path.join(cwd, '.claude', 'worktrees', worktree) : undefined
      ref = { id, kind: req.mode, started, cwd: worktreeDir ?? cwd, cards: ids, name, ...recorded }
    }

    const env = envFor(store, req.boardPath, ids, boardKey, !!mod)
    const info = ptys.create({ title: name, cwd, command, env, cardIds: ids, kind: req.mode, worktree: worktreeDir, boardKey })
    opened.push(info)
    await recordSession(store, req.boardPath, group, ref)

    if (cloud) {
      // `claude --cloud` prints the new session's claude.ai/code URL; keep it on the cards.
      let seen = ''
      const stop = ptys.listen(info.id, data => {
        seen = (seen + stripAnsi(data)).slice(-4000)
        const url = CLOUD_URL.exec(seen)?.[0]
        if (!url) return
        stop()
        void recordCloudUrl(store, req.boardPath, ids, started, url)
      })
    }
  }
  return opened
}

/**
 * The prompt a tackle or discussion would start with, without starting anything: for pasting into
 * a session of one's own. The cards make one prompt, as a single session would get.
 */
export function promptFor(req: TackleRequest, store: BoardStore): string {
  const board = store.board(req.boardPath)
  const cards = req.cardIds
    .map(id => board.cards.find(c => c.id === id))
    .filter((c): c is Card => !!c && !c.archived && !isDivider(c))
  if (!cards.length) throw new Error('No cards to write a prompt for (dividers and archived cards are skipped).')
  return buildPrompt(store, req, req.purpose === 'discuss' || req.purpose === 'untangle' ? cards : tackleGroups(cards)[0])
}

function buildPrompt(store: BoardStore, req: TackleRequest, cards: Card[], mcp = false): string {
  const build = req.purpose === 'discuss' ? discussPrompt : req.purpose === 'untangle' ? untanglePrompt : tacklePrompt
  const codeRepo = store.board(req.boardPath).codeRepo
  return build(cards, {
    meta: store.board(req.boardPath).meta,
    boardRoot: store.root,
    cardFile: id => store.cardFile(req.boardPath, id),
    linkTitle: id => store.findCard(id)?.card.title,
    linkKey: id => store.findCard(id)?.card.jira,
    cloud: req.mode === 'cloud',
    guide: existsSync(path.join(store.root, BOARD_GUIDE_FILE)),
    work: !!store.settings.work,
    listTitle: req.listTitle,
    boardTitle: req.boardTitle,
    workDir: req.mode === 'desktop' ? sessionDir(store, req.boardPath) : undefined,
    mcp,
    findCard: id => store.findCard(id)?.card,
    codeRepo: codeRepo && existsSync(codeRepo) ? codeRepo : undefined,
  })
}

/** Where a board's sessions start: its code repo when that is on this machine, else the board repo. */
function sessionDir(store: BoardStore, boardPath: string): string {
  const board = store.board(boardPath)
  return board.codeRepo && existsSync(board.codeRepo) ? board.codeRepo : store.root
}

/**
 * The argv of a local session. `--add-dir` and `--mcp-config` take lists and swallow every
 * argument up to the next option, so they come first: placed last, `--add-dir` ate the prompt,
 * and Claude started with no prompt at all. `--plugin-dir` takes one path but is repeatable, so
 * it keeps their company. The prompt is last, after options that take exactly one value.
 */
export function localCommand(opts: {
  claude: string
  boardRoot: string
  name: string
  sessionId: string
  worktree?: string
  /** The MCP server's config (a file), when the session gets it. */
  mcpConfig?: string
  /** The companion mod's folder (mod.ts), when this build has one. */
  pluginDir?: string
  prompt: string
}): string[] {
  const command = [opts.claude, '--add-dir', opts.boardRoot]
  if (opts.mcpConfig) command.push('--mcp-config', opts.mcpConfig)
  if (opts.pluginDir) command.push('--plugin-dir', opts.pluginDir)
  command.push('-n', opts.name, '--session-id', opts.sessionId)
  if (opts.worktree) command.push('-w', opts.worktree)
  command.push(opts.prompt)
  return command
}

/** The argv that opens a recorded session again, with the same server and mod as a new one. */
export function resumeCommand(opts: {
  claude: string
  sessionId: string
  mcpConfig?: string
  pluginDir?: string
}): string[] {
  const command = [opts.claude]
  if (opts.mcpConfig) command.push('--mcp-config', opts.mcpConfig)
  if (opts.pluginDir) command.push('--plugin-dir', opts.pluginDir)
  command.push('--resume', opts.sessionId)
  return command
}

/**
 * The environment a session's terminal gets on top of the app's own: the cards it was started
 * for, the board they are on (the key the board tools take), that board's folder, the prefix
 * every card id of the board carries, and whether the project is a work one. The companion mod
 * reads these (`mod/src/session.ts`); nothing else does, and a session started without the mod
 * gets them all the same.
 *
 * `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` turns on the plugin API the mod is written against: it is
 * early access, and off by default unless Claude Code's own rollout has reached this machine.
 */
export function sessionEnv(opts: {
  cards: string[]
  /** The board's key in the window, `<project id>:<path>`. */
  boardKey?: string
  boardDir: string
  prefix: string
  work: boolean
  /** The mod is being handed to this session. */
  mod: boolean
}): Record<string, string> {
  const env: Record<string, string> = {
    CORKBOARD_CARDS: opts.cards.join(','),
    CORKBOARD_BOARD: opts.boardKey ?? '',
    CORKBOARD_BOARD_DIR: opts.boardDir,
    CORKBOARD_CARD_PREFIX: opts.prefix,
    CORKBOARD_WORK: opts.work ? '1' : '0',
  }
  if (opts.mod) env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'
  return env
}

/** That environment for a board of a store, which knows its folder and its card prefix. */
function envFor(
  store: BoardStore,
  boardPath: string,
  cards: string[],
  boardKey: string | undefined,
  mod: boolean,
): Record<string, string> {
  return sessionEnv({
    cards,
    boardKey,
    boardDir: path.join(store.root, boardPath),
    prefix: store.board(boardPath).meta.key,
    work: !!store.settings.work,
    mod,
  })
}

/**
 * Opens a recorded session again: a desktop one in the desktop app, the others in a terminal.
 * Answers the terminal it opened, or null when the desktop app took it. A local session gets the
 * MCP server again (its prompt may have told it to use the tools), the companion mod, and the
 * same environment a new session gets, so a resumed session needs no way of its own to work out
 * which cards it holds.
 */
export async function resume(
  store: BoardStore,
  ptys: PtyManager,
  boardPath: string,
  ref: SessionRef,
  open: OpenExternal,
  boardKey?: string,
  mcpConfig?: string,
  pluginDir?: string,
): Promise<PtyInfo | null> {
  if (ref.kind === 'desktop') {
    if (ref.desktopId) await openUrl(continueUrl(ref.desktopId), open)
    else if (ref.id) await openUrl(importUrl(ref.id), open)
    else throw new Error('The desktop app has not shown this session yet: send its prompt there first.')
    return null
  }
  const cwd = ref.cwd && existsSync(ref.cwd) ? ref.cwd : sessionDir(store, boardPath)
  const cards = ref.cards ?? []
  const tab = { title: cards.join(' ') || 'session', cwd, cardIds: ref.cards, kind: ref.kind, resumed: true, boardKey }
  if (ref.kind === 'cloud') {
    const target = ref.id ?? ref.url
    if (!target) throw new Error('This cloud session never printed its id or URL.')
    const env = envFor(store, boardPath, cards, boardKey, false)
    return ptys.create({ ...tab, env, command: [CLAUDE, '--cloud', target] })
  }
  if (!ref.id) throw new Error('No session id recorded.')
  const worktree = ref.kind === 'local-worktree' ? ref.cwd : undefined
  const env = envFor(store, boardPath, cards, boardKey, !!pluginDir)
  const command = resumeCommand({ claude: CLAUDE, sessionId: ref.id, mcpConfig, pluginDir })
  return ptys.create({ ...tab, worktree, env, command })
}

/** Opens a terminal session in the Claude desktop app (it imports the CLI session by id). */
export async function openInDesktop(ref: SessionRef, open: OpenExternal): Promise<void> {
  if (!ref.id) throw new Error('No session id recorded.')
  await openUrl(ref.desktopId ? continueUrl(ref.desktopId) : importUrl(ref.id), open)
}

const watchers = new Set<NodeJS.Timeout>()
const DESKTOP_WATCH_MS = 30 * 60_000

/**
 * The desktop app writes its index entry and transcript once the prompt is sent; poll for them
 * and put the session's ids on the cards, so the card can open it again later.
 */
function watchForDesktopSession(
  store: BoardStore,
  boardPath: string,
  ids: string[],
  started: string,
  marker: string,
): void {
  const since = Date.parse(started)
  const timer = setInterval(async () => {
    if (Date.now() - since > DESKTOP_WATCH_MS) return stopWatch(timer)
    const known = new Set(
      store
        .allBoards()
        .flatMap(b => b.cards.flatMap(c => c.sessions.map(s => s.desktopId)))
        .filter((x): x is string => !!x),
    )
    const found = await findDesktopSession({ since, marker, skip: known }).catch(() => undefined)
    if (!found) return
    stopWatch(timer)
    const board = store.board(boardPath)
    for (const id of ids) {
      const card = board.cards.find(c => c.id === id)
      if (!card) continue
      const sessions = card.sessions.map(s =>
        s.kind === 'desktop' && s.started === started ? { ...s, id: found.cliSessionId, desktopId: found.desktopId } : s,
      )
      await store.updateCard(boardPath, id, { sessions })
    }
  }, Number(process.env.CORKBOARD_DESKTOP_POLL_MS ?? 3000))
  timer.unref?.()
  watchers.add(timer)
}

function stopWatch(timer: NodeJS.Timeout): void {
  clearInterval(timer)
  watchers.delete(timer)
}

export function stopDesktopWatches(): void {
  for (const timer of watchers) clearInterval(timer)
  watchers.clear()
}

async function recordSession(store: BoardStore, boardPath: string, cards: Card[], ref: SessionRef): Promise<void> {
  const board = store.board(boardPath)
  // Only a tackle moves its cards to the doing list; a discussion or an untangle leaves them be.
  const doing = ref.purpose ? undefined : board.meta.flow?.doing
  for (const card of cards) {
    const fresh = board.cards.find(c => c.id === card.id) ?? card
    const patch: Partial<Card> = { sessions: [...fresh.sessions, ref] }
    if (doing && fresh.list !== doing && board.meta.lists.some(l => l.id === doing)) patch.list = doing
    await store.updateCard(boardPath, card.id, patch)
  }
}

async function recordCloudUrl(
  store: BoardStore,
  boardPath: string,
  ids: string[],
  started: string,
  url: string,
): Promise<void> {
  const board = store.board(boardPath)
  for (const id of ids) {
    const card = board.cards.find(c => c.id === id)
    if (!card) continue
    const sessions = card.sessions.map(s =>
      s.kind === 'cloud' && s.started === started ? { ...s, url, id: s.id ?? url.split('/').at(-1) } : s,
    )
    await store.updateCard(boardPath, id, { sessions })
  }
}

/**
 * The worktree (and so the branch, `worktree-<name>`) a session gets. A work project's is named
 * after the Jira key as written (`SPDI-42`, not slugified to lower case: the key is what teammates
 * look for), else after the title or the list: a card id would be a branch name in the shared repo.
 */
export function worktreeName(cards: Card[], listTitle?: string, work = false): string {
  const stamp = () => new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')
  if (work) {
    const keys = cards.flatMap(c => (c.jira ? [c.jira.trim()] : []))
    if (keys.length === cards.length) return keys.join('-')
    if (cards.length === 1) return slugify(cards[0].title)
    return `cards-${slugify(listTitle ?? cards[0].title).slice(0, 24)}-${stamp()}`
  }
  if (cards.length === 1) return `card-${cards[0].id.toLowerCase()}`
  return `cards-${slugify(listTitle ?? cards[0].id).slice(0, 24)}-${stamp()}`
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, '')
}
