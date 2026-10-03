// The tackle buttons: build the prompt, start `claude` in an embedded terminal, and record the
// session on each card (so it can be resumed) while moving the cards to the board's doing list.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isDivider, slugify } from '@shared/cardfile'
import { sessionName, tacklePrompt } from '@shared/prompts'
import type { Card, PtyInfo, SessionRef, TackleRequest } from '@shared/types'
import type { PtyManager } from './pty'
import type { BoardStore } from './store'

/** Test seam: a stand-in for the `claude` executable. */
export const CLAUDE = process.env.CORKBOARD_CLAUDE_BIN || 'claude'
const CLOUD_URL = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_\-/]+/

export async function tackle(req: TackleRequest, store: BoardStore, ptys: PtyManager): Promise<PtyInfo[]> {
  const board = store.board(req.boardPath)
  const cards = req.cardIds
    .map(id => board.cards.find(c => c.id === id))
    .filter((c): c is Card => !!c && !c.archived && !isDivider(c))
  if (!cards.length) throw new Error('No cards to tackle (dividers and archived cards are skipped).')
  const cwd = board.codeRepo && existsSync(board.codeRepo) ? board.codeRepo : store.root
  const groups = req.split === 'each' ? cards.map(c => [c]) : [cards]
  const opened: PtyInfo[] = []

  for (const group of groups) {
    const ids = group.map(c => c.id)
    const cloud = req.mode === 'cloud'
    const prompt = tacklePrompt(group, {
      meta: board.meta,
      boardRoot: store.root,
      cardFile: id => store.cardFile(req.boardPath, id),
      linkTitle: id => store.findCard(id)?.card.title,
      cloud,
      listTitle: req.listTitle,
    })
    const name = sessionName(group, req.listTitle)
    const started = new Date().toISOString()
    let ref: SessionRef
    let command: string[]

    if (cloud) {
      ref = { kind: 'cloud', started, cwd, cards: ids }
      command = [CLAUDE, '--cloud', prompt]
    } else {
      const id = randomUUID()
      command = [CLAUDE, '-n', name, '--session-id', id, '--add-dir', store.root]
      let sessionCwd = cwd
      if (req.mode === 'local-worktree') {
        const worktree = worktreeName(group, req.listTitle)
        command.push('-w', worktree)
        sessionCwd = path.join(cwd, '.claude', 'worktrees', worktree)
      }
      command.push(prompt)
      ref = { id, kind: req.mode, started, cwd: sessionCwd, cards: ids }
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

/** Opens a terminal that resumes a recorded session. */
export function resume(store: BoardStore, ptys: PtyManager, boardPath: string, ref: SessionRef): PtyInfo {
  const board = store.board(boardPath)
  const fallback = board.codeRepo && existsSync(board.codeRepo) ? board.codeRepo : store.root
  const cwd = ref.cwd && existsSync(ref.cwd) ? ref.cwd : fallback
  const label = ref.cards?.join(' ') ?? 'session'
  if (ref.kind === 'cloud') {
    const target = ref.id ?? ref.url
    if (!target) throw new Error('This cloud session never printed its id or URL.')
    return ptys.create({ title: `☁ ${label}`, cwd, command: [CLAUDE, '--cloud', target], cardIds: ref.cards })
  }
  if (!ref.id) throw new Error('No session id recorded.')
  return ptys.create({ title: `↻ ${label}`, cwd, command: [CLAUDE, '--resume', ref.id], cardIds: ref.cards })
}

async function recordSession(store: BoardStore, boardPath: string, cards: Card[], ref: SessionRef): Promise<void> {
  const board = store.board(boardPath)
  const doing = board.meta.flow?.doing
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
