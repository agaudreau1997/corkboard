// The companion laid out as the desktop: where the app opens and where back goes (src/place.ts),
// the swipes' decisions (src/gestures.ts), and the side panel's rows (src/repo/panel.ts).

import { describe, expect, it } from 'vitest'
import { follow, inPanelEdge, listSwipeStarts, lockAxis, PANEL_EDGE, pushOut, RIGHT_EDGE, settles, stepOf, stepTo } from '../src/gestures'
import { back, lastPlace, savePlace, startPlace, type Place } from '../src/place'
import type { BoardNode } from '../src/repo/layout'
import { boardKey, panelRows, type PanelRow } from '../src/repo/panel'
import { MemoryStorage } from './fakes'

describe('where the app opens', () => {
  it('reopens on the board, without the drawer or the panel', () => {
    const storage = new MemoryStorage()
    savePlace({ repo: 'me/board', board: 'cork', list: 'doing', card: 'CORK-1', panel: true }, storage)
    expect(lastPlace(storage)).toEqual({ repo: 'me/board', board: 'cork', list: 'doing', card: 'CORK-1' })
    expect(startPlace(lastPlace(storage))).toEqual({ repo: 'me/board', board: 'cork', list: 'doing' })
    expect(startPlace({ repo: 'me/board', board: 'cork', adding: true })).toEqual({ repo: 'me/board', board: 'cork' })
  })

  it('opens the panel by itself on a first run', () => {
    expect(startPlace(lastPlace(new MemoryStorage()))).toEqual({ panel: true })
  })

  it('keeps a board’s settings open', () => {
    expect(startPlace({ repo: 'me/board', board: 'cork', settings: true })).toEqual({ repo: 'me/board', board: 'cork', settings: true })
  })
})

describe('Android’s back button', () => {
  const walk = (place: Place) => {
    const seen: Place[] = []
    for (let p: Place | undefined = place; p; p = back(p)) seen.push(p)
    return seen
  }

  it('closes the drawer, then the panel, then leaves', () => {
    const steps = walk({ repo: 'r', board: 'b', card: 'X-1', panel: true })
    expect(steps.map(p => [!!p.card, !!p.panel])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ])
    expect(steps.at(-1)).toMatchObject({ repo: 'r', board: 'b' })
  })

  it('closes the new-card form, and a board’s settings', () => {
    expect(back({ repo: 'r', board: 'b', adding: true })).toEqual({ repo: 'r', board: 'b', adding: undefined })
    expect(back({ repo: 'r', board: 'b', settings: true })).toEqual({ repo: 'r', board: 'b', settings: undefined })
    expect(back({ repo: 'r', board: 'b', list: 'l' })).toBeUndefined()
  })
})

describe('swipes', () => {
  it('decide their direction once past the slop, a slanted scroll staying a scroll', () => {
    expect(lockAxis(5, 3)).toBeUndefined()
    expect(lockAxis(30, 5)).toBe('x')
    expect(lockAxis(-30, 4)).toBe('x')
    expect(lockAxis(5, 30)).toBe('y')
    expect(lockAxis(20, 18)).toBe('y')
  })

  it('leave the edges: the left band opens the panel, and neither edge starts a list swipe', () => {
    expect(inPanelEdge(0)).toBe(true)
    expect(inPanelEdge(PANEL_EDGE - 1)).toBe(true)
    expect(inPanelEdge(PANEL_EDGE)).toBe(false)
    expect(listSwipeStarts(10, 412)).toBe(false)
    expect(listSwipeStarts(PANEL_EDGE, 412)).toBe(true)
    expect(listSwipeStarts(200, 412)).toBe(true)
    expect(listSwipeStarts(412 - RIGHT_EDGE + 1, 412)).toBe(false)
  })

  it('go through past a third, or when flung', () => {
    expect(settles(100, 600, 400)).toBe(false)
    expect(settles(140, 600, 400)).toBe(true)
    expect(settles(-140, 600, 400)).toBe(true)
    expect(settles(60, 80, 400)).toBe(true)
    expect(settles(30, 20, 400)).toBe(false)
  })

  it('step to the next list leftwards and the previous rightwards, not past the ends', () => {
    expect(stepOf(-50)).toBe(1)
    expect(stepOf(50)).toBe(-1)
    expect(stepTo(0, 3, 1)).toBe(1)
    expect(stepTo(2, 3, 1)).toBeUndefined()
    expect(stepTo(0, 3, -1)).toBeUndefined()
    expect(stepTo(-1, 3, 1)).toBeUndefined()
    expect(follow(90, true)).toBe(90)
    expect(follow(90, false)).toBe(30)
  })

  it('push a drawer only the way it closes', () => {
    expect(pushOut('right', 50)).toBe(50)
    expect(pushOut('right', -50)).toBe(0)
    expect(pushOut('left', -50)).toBe(-50)
    expect(pushOut('left', 50)).toBe(0)
  })
})

const node = (path: string, children: BoardNode[] = []): BoardNode => ({ path, title: path, key: path.toUpperCase(), children })

describe('the side panel', () => {
  const tree = [node('cork', [node('cork/art', [node('cork/art/old')]), node('cork/web')]), node('game')]
  const repos = [{ repo: 'me/board', tree, main: 'cork' }, { repo: 'me/new' }]
  const names = (rows: PanelRow[]) => rows.map(r => (r.kind === 'repo' ? r.repo : `${'  '.repeat(r.depth)}${r.node.path}`))

  it('lists each repo with its main board’s children and its other boards, boards shut', () => {
    const rows = panelRows(repos, new Set(), new Set(), {})
    expect(names(rows)).toEqual(['me/board', '  cork/art', '  cork/web', '  game', 'me/new'])
    expect(rows[0]).toMatchObject({ open: true, foldable: true, active: false })
    expect(rows[1]).toMatchObject({ foldable: true, open: false })
    // A repo never read has its row, with nothing to fold.
    expect(rows[4]).toMatchObject({ kind: 'repo', foldable: false, main: undefined })
  })

  it('folds a repo, and opens a board’s children', () => {
    expect(names(panelRows(repos, new Set(['me/board']), new Set(), {}))).toEqual(['me/board', 'me/new'])
    expect(names(panelRows(repos, new Set(), new Set([boardKey('me/board', 'cork/art')]), {}))).toEqual([
      'me/board',
      '  cork/art',
      '    cork/art/old',
      '  cork/web',
      '  game',
      'me/new',
    ])
  })

  it('highlights the open board, its repo’s row for the main board, and shows the boards above it open', () => {
    const onMain = panelRows(repos, new Set(), new Set(), { repo: 'me/board', board: 'cork' })
    expect(onMain.filter(r => r.active).map(r => r.kind)).toEqual(['repo'])
    const deep = panelRows(repos, new Set(), new Set(), { repo: 'me/board', board: 'cork/art/old' })
    expect(names(deep)).toContain('    cork/art/old')
    expect(deep.filter(r => r.active)).toMatchObject([{ kind: 'board', node: { path: 'cork/art/old' } }])
    // The same path in another repo isn't the open one.
    const other = panelRows([{ repo: 'me/other', tree, main: 'cork' }], new Set(), new Set(), { repo: 'me/board', board: 'cork' })
    expect(other.some(r => r.active)).toBe(false)
  })
})
