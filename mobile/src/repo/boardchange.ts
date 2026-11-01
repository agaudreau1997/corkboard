// Changing a board's `board.json` from the phone: its title, its lists (add, rename, sort, colour,
// move, archive, restore) and its flow. Each change is one write through the Contents API, one
// commit named by `describeBoardChange`, as the desktop's auto-commit names it.
//
// A change is kept as what was asked ("archive the list doing"), not as the file it made, so that
// when the file changed since it was read (GitHub answers 409: a desktop pushed, or another edit
// from the phone landed), the board is read again and the change made again on the newer file:
// two edits to different lists both survive. The file goes through `patchMeta`, as the desktop's
// store writes it, so its other keys and their order stay. A new list's id is a slug of its title,
// unique among the board's lists as they are when it is written (`newListId`), and a rename never
// changes an id. Colours are written down (`freezeListColors`) before a list is added, moved,
// archived or recoloured, so the others keep the colour they show.

import { describeBoardChange, metaText, newListId, parseMetaText, patchMeta } from '@shared/boardmeta'
import { freezeListColors, reorderLists } from '@shared/cardfile'
import type { BoardMeta, ListDef, ListSort } from '@shared/types'
import { answerJson } from '../github/answer'
import type { RepoCache } from './cache'
import { refresh } from './reader'
import { base64 } from './writer'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export type BoardChange =
  | { kind: 'title'; title: string }
  | { kind: 'addList'; title: string }
  | { kind: 'renameList'; list: string; title: string }
  | { kind: 'sortList'; list: string; sort: ListSort }
  | { kind: 'colorList'; list: string; color: string }
  | { kind: 'moveList'; list: string; by: -1 | 1 }
  | { kind: 'archiveList'; list: string }
  | { kind: 'restoreList'; list: string }
  /** The lists tackling and finishing move cards to; null clears one, undefined leaves it. */
  | { kind: 'flow'; doing?: string | null; done?: string | null }

const TRIES = 5

/** The board's meta with the change made; throws when it names a list the board no longer has. */
export function applyBoardChange(meta: BoardMeta, change: BoardChange): BoardMeta {
  const lists = meta.lists
  const has = (id: string) => {
    if (!lists.some(l => l.id === id)) throw new Error(`The list ${id} is no longer on this board.`)
  }
  const each = (id: string, edit: (l: ListDef) => ListDef, frozen = false) => {
    has(id)
    return patchMeta(meta, { lists: (frozen ? freezeListColors(lists) : lists).map(l => (l.id === id ? edit(l) : l)) })
  }
  switch (change.kind) {
    case 'title':
      return change.title.trim() ? patchMeta(meta, { title: change.title.trim() }) : meta
    case 'addList': {
      const title = change.title.trim()
      if (!title) return meta
      return patchMeta(meta, { lists: freezeListColors([...lists, { id: newListId(title, lists), title }]) })
    }
    case 'renameList':
      return change.title.trim() ? each(change.list, l => ({ ...l, title: change.title.trim() })) : meta
    case 'sortList':
      return each(change.list, l => ({ ...l, sort: change.sort }))
    case 'colorList':
      return each(change.list, l => ({ ...l, color: change.color }), true)
    case 'archiveList':
      return each(change.list, l => ({ ...l, archived: true }), true)
    case 'restoreList':
      return each(change.list, l => {
        const { archived: _, ...rest } = l
        return rest
      }, true)
    case 'moveList': {
      has(change.list)
      const visible = lists.filter(l => !l.archived)
      const other = visible[visible.findIndex(l => l.id === change.list) + change.by]
      const moved = other ? reorderLists(lists, change.list, other.id) : null
      return moved ? patchMeta(meta, { lists: moved }) : meta
    }
    case 'flow': {
      for (const id of [change.doing, change.done]) if (id) has(id)
      const pick = (asked: string | null | undefined, was: string | undefined) => (asked === undefined ? was : (asked ?? undefined))
      const doing = pick(change.doing, meta.flow?.doing)
      const done = pick(change.done, meta.flow?.done)
      const flow = { ...(doing ? { doing } : {}), ...(done ? { done } : {}) }
      return patchMeta(meta, { flow: doing || done ? flow : undefined })
    }
  }
}

/** Writes the change to the board's `board.json`; answers the meta as written. */
export async function changeBoard(
  api: Api,
  cache: RepoCache,
  at: { repo: string; board: string },
  change: BoardChange,
): Promise<BoardMeta> {
  let snapshot = cache.snapshot(at.repo) ?? (await refresh(api, cache, at.repo))
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const file = snapshot.boards.find(b => b.path === at.board)?.meta
    const before = file && parseMetaText(cache.blob(file.sha) ?? '')
    if (!file || !before) throw new Error(`The board ${at.board} is no longer in ${at.repo}.`)
    const next = applyBoardChange(before, change)
    const text = metaText(next)
    if (text === metaText(before)) return next
    const response = await api(`/repos/${at.repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: describeBoardChange(at.board, before, next).join('; '), content: base64(text), sha: file.sha }),
    })
    if (response.status !== 409) {
      const answer = await answerJson<{ content: { sha: string } }>(response, `the change to ${at.board}`)
      cache.putBlobs(new Map([[answer.content.sha, text]]))
      // The kept snapshot names the file as written, so the next change starts from it.
      const boards = snapshot.boards.map(b => (b.path === at.board ? { ...b, meta: { ...b.meta, sha: answer.content.sha } } : b))
      cache.putSnapshot({ ...snapshot, boards })
      return next
    }
    // Changed since it was read: read it again and make the change on the newer file.
    snapshot = await refresh(api, cache, at.repo)
  }
  throw new Error(`${at.board}'s settings kept changing while they were being saved: try again.`)
}
