import { describe, expect, it } from 'vitest'
import { foldTabs, hasPlace, showBoard, type BoardTab } from '@shared/tabs'

const tab = (path: string, view = 'board'): BoardTab => ({ path, view })
const opts = (perProject: boolean, views: Record<string, string> = {}) => ({ views, perProject, fallback: 'board' })

describe('showing a board', () => {
  it("puts it in its project's tab, one tab per project", () => {
    const tabs = [tab('p:a'), tab('q:x', 'map')]
    expect(showBoard(tabs, 'p:b', opts(true))).toEqual([tab('p:b'), tab('q:x', 'map')])
    expect(showBoard(tabs, 'r:z', opts(true))).toEqual([...tabs, tab('r:z')])
  })

  it('adds a tab of its own with the setting off', () => {
    expect(showBoard([tab('p:a')], 'p:b', opts(false))).toEqual([tab('p:a'), tab('p:b')])
  })

  it('in the view it was last shown in, unless one is asked for', () => {
    const views = { 'p:b': 'table' }
    expect(showBoard([tab('p:a', 'map')], 'p:b', opts(true, views))).toEqual([tab('p:b', 'table')])
    expect(showBoard([tab('p:a', 'map')], 'p:b', { ...opts(true, views), view: 'map' })).toEqual([tab('p:b', 'map')])
  })

  it('keeps a board already in a tab where it is, its view changed only when asked', () => {
    const tabs = [tab('p:a', 'map'), tab('p:b')]
    expect(showBoard(tabs, 'p:b', opts(true, { 'p:b': 'table' }))).toEqual(tabs)
    expect(showBoard(tabs, 'p:b', { ...opts(true), view: 'table' })).toEqual([tab('p:a', 'map'), tab('p:b', 'table')])
  })

  it('has a place for any board of a project with a tab, one tab per project', () => {
    expect(hasPlace([tab('p:a')], 'p:b', true)).toBe(true)
    expect(hasPlace([tab('p:a')], 'p:b', false)).toBe(false)
    expect(hasPlace([tab('p:a')], 'q:a', true)).toBe(false)
  })
})

describe('folding the tabs into one per project', () => {
  const tabs = [tab('p:a'), tab('q:x'), tab('p:b', 'map'), tab('p:c'), tab('q:y')]

  it("keeps each project's tab where its first was, on the active board", () => {
    expect(foldTabs(tabs, 'p:b', [])).toEqual([tab('p:b', 'map'), tab('q:y')])
  })

  it('else on the most recently active one, else the one opened last', () => {
    expect(foldTabs(tabs, 'q:x', ['p:c', 'p:a'])).toEqual([tab('p:c'), tab('q:x')])
    expect(foldTabs(tabs, null, ['z:z'])).toEqual([tab('p:c'), tab('q:y')])
  })

  it('leaves one tab per project as it is', () => {
    expect(foldTabs([tab('p:a'), tab('q:x')], null, [])).toEqual([tab('p:a'), tab('q:x')])
  })
})
