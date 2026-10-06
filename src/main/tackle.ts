// The tackle buttons: build the prompt, start `claude` in an embedded terminal, and record the
// session on each card (so it can be resumed) while moving the cards to the board's doing list.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BOARD_GUIDE_FILE } from '@shared/boardguide'
import { isDivider, slugify } from '@shared/cardfile'
import { discussPrompt, sessionName, tacklePrompt } from '@shared/prompts'
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

export async function tackle(
  req: TackleRequest,
  store: BoardStore,
  ptys: PtyManager,
  open: OpenExternal,
): Promise<PtyInfo[]> {
  const board = store.board(req.boardPath)
  const cards = req.cardIds
    .map(id => board.cards.find(c => c.id === id))
    .filter((c): c is Card => !!c && !c.archived && !isDivider(c))
  if (!cards.length) throw new Error('No cards to work on (dividers and archived cards are skipped).')
  const discuss = req.purpose === 'discuss'
  if (discuss && (req.mode === 'cloud' || req.mode === 'local-worktree')) {
    throw new Error('A discussion runs in Claude desktop or a terminal.')
  }
  const cwd = sessionDir(store, req.boardPath)
  // A discussion of several cards is one conversation: triage needs them side by side.
  const groups = req.split === 'each' && !discuss ? cards.map(c => [c]) : [cards]
  const opened: PtyInfo[] = []

  for (const group of groups) {
    const ids = group.map(c => c.id)
    const cloud = req.mode === 'cloud'
    const prompt = buildPrompt(store, req, group)
    const name = sessionName(group, req.listTitle ?? req.boardTitle, discuss ? 'discuss' : 'tackle')
    const purpose = discuss ? ({ purpose: 'discuss' } as const) : {}
    const started = new Date().toISOString()
    let ref: SessionRef
    let command: string[]

    if (req.mode === 'desktop') {
      // A new session in the Claude desktop app, in the code repo. One folder only: given the board
      // repo as a second, the app ignored both and opened the last folder it used. The session
      // reaches the cards by the paths in the prompt. The link can't pick a branch, and a draft
      // sent without one starts with no folder: the prompt has the session move itself.
      const { url, marker } = newSessionUrl(prompt, cwd)
      await recordSession(store, req.boardPath, group, { kind: 'desktop', started, cwd, cards: ids, name, ...purpose })
      await openUrl(url, open)
      watchForDesktopSession(store, req.boardPath, ids, started, marker)
      continue
    }

    if (cloud) {
      ref = { kind: 'cloud', started, cwd, cards: ids, name }
      command = [CLAUDE, '--cloud', prompt]
    } else {
      const id = randomUUID()
      const worktree = req.mode === 'local-worktree' ? worktreeName(group, req.listTitle) : undefined
      command = localCommand({ claude: CLAUDE, boardRoot: store.root, name, sessionId: id, worktree, prompt })
      const sessionCwd = worktree ? path.join(cwd, '.claude', 'worktrees', worktree) : cwd
      ref = { id, kind: req.mode, started, cwd: sessionCwd, cards: ids, name, ...purpose }
    }

    const info = ptys.create({ title: cloud ? `☁ ${name}` : name, cwd, command, cardIds: ids })
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
  return buildPrompt(store, req, cards)
}

function buildPrompt(store: BoardStore, req: TackleRequest, cards: Card[]): string {
  const build = req.purpose === 'discuss' ? discussPrompt : tacklePrompt
  return build(cards, {
    meta: store.board(req.boardPath).meta,
    boardRoot: store.root,
    cardFile: id => store.cardFile(req.boardPath, id),
    linkTitle: id => store.findCard(id)?.card.title,
    cloud: req.mode === 'cloud',
    guide: existsSync(path.join(store.root, BOARD_GUIDE_FILE)),
    listTitle: req.listTitle,
    boardTitle: req.boardTitle,
    workDir: req.mode === 'desktop' ? sessionDir(store, req.boardPath) : undefined,
  })
}

/** Where a board's sessions start: its code repo when that is on this machine, else the board repo. */
function sessionDir(store: BoardStore, boardPath: string): string {
  const board = store.board(boardPath)
  return board.codeRepo && existsSync(board.codeRepo) ? board.codeRepo : store.root
}

/**
 * The argv of a local session. `--add-dir` takes a list of folders and swallows every argument up
 * to the next option, so it comes first: placed last it ate the prompt, and Claude started with
 * no prompt at all. The prompt is last, after options that take exactly one value.
 */
export function localCommand(opts: {
  claude: string
  boardRoot: string
  name: string
  sessionId: string
  worktree?: string
  prompt: string
}): string[] {
  const command = [opts.claude, '--add-dir', opts.boardRoot, '-n', opts.name, '--session-id', opts.sessionId]
  if (opts.worktree) command.push('-w', opts.worktree)
  command.push(opts.prompt)
  return command
}

/**
 * Opens a recorded session again: a desktop one in the desktop app, the others in a terminal.
 * Answers the terminal it opened, or null when the desktop app took it.
 */
export async function resume(
  store: BoardStore,
  ptys: PtyManager,
  boardPath: string,
  ref: SessionRef,
  open: OpenExternal,
): Promise<PtyInfo | null> {
  if (ref.kind === 'desktop') {
    if (ref.desktopId) await openUrl(continueUrl(ref.desktopId), open)
    else if (ref.id) await openUrl(importUrl(ref.id), open)
    else throw new Error('The desktop app has not shown this session yet: send its prompt there first.')
    return null
  }
  const cwd = ref.cwd && existsSync(ref.cwd) ? ref.cwd : sessionDir(store, boardPath)
  const label = ref.cards?.join(' ') ?? 'session'
  if (ref.kind === 'cloud') {
    const target = ref.id ?? ref.url
    if (!target) throw new Error('This cloud session never printed its id or URL.')
    return ptys.create({ title: `☁ ${label}`, cwd, command: [CLAUDE, '--cloud', target], cardIds: ref.cards })
  }
  if (!ref.id) throw new Error('No session id recorded.')
  return ptys.create({ title: `↻ ${label}`, cwd, command: [CLAUDE, '--resume', ref.id], cardIds: ref.cards })
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
  // Only a tackle moves its cards to the doing list; a discussion leaves them where they are.
  const doing = ref.purpose === 'discuss' ? undefined : board.meta.flow?.doing
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

function worktreeName(cards: Card[], listTitle?: string): string {
  if (cards.length === 1) return `card-${cards[0].id.toLowerCase()}`
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')
  return `cards-${slugify(listTitle ?? cards[0].id).slice(0, 24)}-${stamp}`
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, '')
}
