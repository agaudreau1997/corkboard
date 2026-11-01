// A repo's look (its `theme.json` colours and `project.json` icon): read with the tree when the
// repo is browsed, for every repo at once for the side panel, kept by sha so an unchanged file is
// never read again; and the colours the phone paints with them, system bars included.

import { describe, expect, it } from 'vitest'
import { swatchColors, THEME_PRESETS } from '@shared/theme'
import { RepoCache } from '../src/repo/cache'
import { lookAt, readLooks, shasQuery } from '../src/repo/looks'
import { refresh } from '../src/repo/reader'
import { isLight, tokens } from '../src/theme'
import { github, MemoryStorage, meta } from './fakes'

const ICON = 'data:image/png;base64,iVBORw0KGgo='
const paper = THEME_PRESETS.find(t => t.name === 'Paper')!

const files = () => ({
  'cork/board.json': meta('CORK', 'Cork', [{ id: 'todo', title: 'To do' }]),
  'theme.json': JSON.stringify({ name: 'Paper', colors: paper.colors }),
  'project.json': JSON.stringify({ icon: ICON, board: 'cork', future: 'kept on the desktop' }),
})

describe('a repo’s look', () => {
  it('is read with the tree, in the same read as the boards', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    await refresh(gh.api, cache, 'me/board')
    expect(gh.asked).toHaveLength(1)
    expect(gh.asked[0]).toHaveLength(3)
    const look = cache.look('me/board')!
    expect(look.theme?.colors.background).toBe('#f4f1ea')
    expect(look.settings).toEqual({ icon: ICON, board: 'cork' })
  })

  it('reads only a changed file on a refresh, and forgets a file that went', async () => {
    const gh = github(files())
    const cache = new RepoCache(new MemoryStorage())
    await refresh(gh.api, cache, 'me/board')
    gh.asked.length = 0
    await refresh(gh.api, cache, 'me/board')
    expect(gh.asked).toHaveLength(0)
    gh.put('theme.json', JSON.stringify({ colors: { accent: '#ff0000' } }))
    await refresh(gh.api, cache, 'me/board')
    expect(gh.asked.flat()).toHaveLength(1)
    expect(cache.look('me/board')?.theme?.colors).toEqual({ accent: '#ff0000' })
    expect(cache.look('me/board')?.settings.icon).toBe(ICON)
  })

  it('reads none when the repo has neither file', () => {
    expect(lookAt({}, undefined, () => undefined)).toEqual({ shas: {}, settings: {} })
    // A broken file reads as none, as on the desktop.
    expect(lookAt({ theme: 'a', project: 'b' }, undefined, () => '{ broken')).toEqual({ shas: { theme: 'a', project: 'b' }, settings: {} })
  })

  it('asks for every repo’s shas in one query, and keeps the looks it can’t refresh', async () => {
    const gh = github(files())
    const storage = new MemoryStorage()
    const cache = new RepoCache(storage)
    cache.putLook('them/other', { shas: { theme: 'x' }, theme: { colors: { accent: '#00ff00' } }, settings: {} })
    const looks = await readLooks(gh.api, cache, ['me/board', 'them/other', 'them/none'])
    expect(gh.looked).toHaveLength(1)
    expect(looks.get('me/board')?.settings.icon).toBe(ICON)
    expect(looks.get('them/other')?.theme?.colors.accent).toBe('#00ff00')
    expect(looks.has('them/none')).toBe(false)
    gh.asked.length = 0
    await readLooks(gh.api, new RepoCache(storage), ['me/board'])
    expect(gh.asked).toHaveLength(0)
  })

  it('names the repos as variables, never in the query text', () => {
    const query = shasQuery(2)
    expect(query).toContain('r1: repository(owner: $o1, name: $n1)')
    expect(query).toContain('object(expression: "HEAD:theme.json")')
  })
})

describe('painting a repo', () => {
  it('turns the system bars’ icons dark on a light theme only', () => {
    expect(isLight(paper)).toBe(true)
    expect(isLight(THEME_PRESETS.find(t => t.name === 'Cork'))).toBe(false)
    expect(isLight()).toBe(false)
  })

  it('sets every token each time, so the app’s own colours come back after a theme', () => {
    expect(Object.keys(tokens(paper))).toEqual(Object.keys(tokens()))
    expect(tokens()['color-scheme']).toBe('dark')
  })

  it('draws a swatch the desktop’s way', () => {
    expect(swatchColors(paper)).toEqual(['#f4f1ea', '#ffffff', '#c7852a'])
    expect(swatchColors(undefined)[0]).toBe('#15171c')
  })
})
