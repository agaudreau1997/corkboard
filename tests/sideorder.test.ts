import { describe, expect, it } from 'vitest'
import { mainBoardOf } from '@shared/project'
import { inOrder, patchOrder, reordered } from '@shared/sideorder'

const key = (b: { path: string }) => b.path
const boards = ['p:alpha', 'p:beta', 'p:gamma', 'p:delta'].map(path => ({ path }))

describe('the side panel order', () => {
  it('leaves the tree as it is without one', () => {
    expect(inOrder(boards, key, undefined)).toBe(boards)
    expect(inOrder(boards, key, [])).toBe(boards)
  })

  it('puts the ordered ones first, and the others after them in the order they came', () => {
    expect(inOrder(boards, key, ['p:gamma', 'p:alpha']).map(key)).toEqual(['p:gamma', 'p:alpha', 'p:beta', 'p:delta'])
  })

  it('ignores keys of boards that are not in the list', () => {
    expect(inOrder(boards, key, ['p:gone', 'p:delta', 'q:other']).map(key)).toEqual(['p:delta', 'p:alpha', 'p:beta', 'p:gamma'])
  })

  it('moves a rearranged sibling list to the end and drops the keys gone', () => {
    const known = new Set(['p:alpha', 'p:beta', 'q:x', 'q:y'])
    expect(reordered(['q:y', 'p:gone', 'q:x', 'p:beta'], ['p:beta', 'p:alpha'], known)).toEqual(['q:y', 'q:x', 'p:beta', 'p:alpha'])
    expect(reordered(undefined, ['q:x'], known)).toEqual(['q:x'])
  })

  it('patches one part of the config, clearing an empty one', () => {
    expect(patchOrder({ projects: ['a'], boards: ['p:x'] }, { boards: ['p:y'] })).toEqual({ projects: ['a'], boards: ['p:y'] })
    expect(patchOrder({ projects: ['a'] }, { projects: [] })).toEqual({})
    expect(patchOrder(undefined, { projects: ['b', 'a'] })).toEqual({ projects: ['b', 'a'] })
  })

  it("never decides a project's default main board, which stays the first by title", () => {
    // The main board is picked from the store's title order, so a reorder on one machine leaves
    // every machine opening the same board.
    const ordered = inOrder(boards, key, ['p:delta'])
    expect(mainBoardOf({}, boards)).toBe('p:alpha')
    expect(ordered[0].path).toBe('p:delta')
  })
})
