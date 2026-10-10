// Each board's map undo and redo stacks, kept while the app runs (never saved: an undo after a
// restart would take back a change nobody remembers making). An undo or a redo writes through the
// usual calls, so it is a change like any other: stamped, committed and synced. The merge rules,
// what is put back and what is left alone, are in `@shared/mapundo`.

import { isEmptyStep, replayCard, replayMap, same, type MapStep } from '@shared/mapundo'
import { actions, api, useStore } from './state'

/** Enough for a long session of arranging; the oldest steps go first. */
const LIMIT = 200

const stacks = new Map<string, { undo: MapStep[]; redo: MapStep[] }>()

function stackOf(boardPath: string) {
  let stack = stacks.get(boardPath)
  if (!stack) stacks.set(boardPath, (stack = { undo: [], redo: [] }))
  return stack
}

/** Keeps a step for undo. A new change ends what could be redone. */
export function recordStep(boardPath: string, step: MapStep): void {
  if (isEmptyStep(step)) return
  const stack = stackOf(boardPath)
  stack.undo.push(step)
  if (stack.undo.length > LIMIT) stack.undo.shift()
  stack.redo = []
}

export function undoMap(boardPath: string): void {
  replay(boardPath, 'undo')
}

export function redoMap(boardPath: string): void {
  replay(boardPath, 'redo')
}

function replay(boardPath: string, way: 'undo' | 'redo'): void {
  const stack = stackOf(boardPath)
  const step = (way === 'undo' ? stack.undo : stack.redo).pop()
  if (!step) {
    actions.toast(way === 'undo' ? 'Nothing to undo on this map' : 'Nothing to redo on this map')
    return
  }
  ;(way === 'undo' ? stack.redo : stack.undo).push(step)
  const board = useStore.getState().boards[boardPath]
  if (!board) return
  const left: string[] = []
  let positions = 0
  if (step.map) {
    const [from, to] = way === 'undo' ? [step.map.after, step.map.before] : [step.map.before, step.map.after]
    const { map, skipped } = replayMap(board.map, from, to)
    positions = skipped
    if (!same(map, board.map)) {
      actions.setMapLocal(boardPath, map)
      void api.map.save(boardPath, map)
    }
  }
  for (const change of step.cards) {
    const card = board.cards.find(c => c.id === change.id)
    const [from, to] = way === 'undo' ? [change.after, change.before] : [change.before, change.after]
    const patch = card && replayCard(card, from, to)
    if (!patch) left.push(change.id)
    else if (Object.keys(patch).length) void actions.updateCard(boardPath, change.id, patch)
  }
  const done = `${way === 'undo' ? 'Undid' : 'Redid'}: ${step.label}`
  const since = [
    left.length ? `${left.join(', ')} ${left.length === 1 ? 'was' : 'were'} changed since and stay${left.length === 1 ? 's' : ''} as ${left.length === 1 ? 'it is' : 'they are'}` : '',
    positions ? `${positions} position${positions === 1 ? '' : 's'} changed since stay${positions === 1 ? 's' : ''}` : '',
  ].filter(Boolean)
  actions.toast(since.length ? `${done} · ${since.join('; ')}` : done, since.length ? 'error' : 'info')
}
