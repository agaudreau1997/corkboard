// Card images: found in the tree by the path the card names relative to its file, read once from
// GitHub's REST blobs as base64, kept by sha under a cap that drops the least recently shown first,
// and shown from the kept copy offline.

import { describe, expect, it } from 'vitest'
import { RepoCache } from '../src/repo/cache'
import { findImages } from '../src/repo/layout'
import { ImageCache, ImageLoader, readImage } from '../src/repo/images'
import { refresh } from '../src/repo/reader'
import { card, github, MemoryImages, MemoryStorage, meta, png, sha } from './fakes'

const files = () => ({
  'game/board.json': meta('MB', 'Moon base', [{ id: 'todo', title: 'To do' }]),
  'game/cards/MB-1.md': card({ id: 'MB-1', title: 'Hangar', list: 'todo', pos: 1024, cover: 'MB-1/a1.png', body: '![](MB-1/a1.png)' }),
  'game/cards/MB-1/a1.png': png(1, 2, 3),
  'game/art/board.json': meta('ART', 'Art', []),
  'game/art/cards/ART-1/b2.png': png(4, 5, 6),
  'game/cards/MB-1/notes.txt': 'not an image',
  'game/cards/MB-1/fake.png': 'not a PNG at all',
  '.github/logo.png': png(7),
})

describe('finding images in the tree', () => {
  it('keeps the image types the desktop keeps, by path, but in hidden folders', () => {
    const images = findImages(Object.keys(files()).map(path => ({ path, type: 'blob', sha: sha() })))
    expect(Object.keys(images).sort()).toEqual(['game/art/cards/ART-1/b2.png', 'game/cards/MB-1/a1.png', 'game/cards/MB-1/fake.png'])
  })
})

describe('reading an image', () => {
  it('decodes GitHub’s base64, wrapped in lines', async () => {
    const big = png(...Array.from({ length: 200 }, (_, i) => i % 256))
    const gh = github({ 'a/cards/X-1/big.png': big })
    const image = await readImage(gh.api, 'me/board', gh.tree[0].sha)
    expect(image).toEqual({ sha: gh.tree[0].sha, type: 'image/png', bytes: big })
  })

  it('refuses bytes that aren’t an image, whatever the name', async () => {
    const gh = github({ 'a/cards/X-1/fake.png': '<svg onload="alert(1)"/>' })
    expect(await readImage(gh.api, 'me/board', gh.tree[0].sha)).toBeUndefined()
    await expect(readImage(gh.api, 'me/board', 'HEAD')).rejects.toThrow()
  })
})

describe('the image loader', () => {
  async function setUp() {
    const gh = github(files())
    const snapshot = await refresh(gh.api, new RepoCache(new MemoryStorage()), 'me/board')
    const storage = new MemoryImages()
    return { gh, snapshot, storage, cache: new ImageCache(storage) }
  }

  it('finds an image relative to the card file, reads it once, and keeps it', async () => {
    const { gh, snapshot, storage, cache } = await setUp()
    const loader = new ImageLoader(cache, snapshot, gh.api)
    const [a, b] = await Promise.all([loader.load('game', 'MB-1/a1.png'), loader.load('game', './MB-1/a1.png')])
    expect(a).toEqual(b)
    expect('image' in a && [...a.image.bytes]).toEqual([...png(1, 2, 3)])
    expect(gh.blobReads).toHaveLength(1)
    expect(storage.images.size).toBe(1)
    // Another board's image, named up and across from the card file.
    expect('image' in (await loader.load('game', '../art/cards/ART-1/b2.png'))).toBe(true)
    expect(gh.blobReads).toHaveLength(2)
  })

  it('shows a kept image offline, and says why it can’t show the others', async () => {
    const { gh, snapshot, cache } = await setUp()
    await new ImageLoader(cache, snapshot, gh.api).load('game', 'MB-1/a1.png')
    const offline = new ImageLoader(cache, snapshot, undefined)
    expect('image' in (await offline.load('game', 'MB-1/a1.png'))).toBe(true)
    expect(await offline.load('game', '../art/cards/ART-1/b2.png')).toEqual({ missing: 'offline' })
    expect(await offline.load('game', 'MB-1/gone.png')).toEqual({ missing: 'absent' })
    expect(await offline.load('game', '../../../x.png')).toEqual({ missing: 'absent' })
    const online = new ImageLoader(cache, snapshot, gh.api)
    expect(await online.load('game', 'MB-1/fake.png')).toEqual({ missing: 'absent' })
  })

  it('reads a few at a time', async () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`b/cards/X-${i}/i.png`, png(i)]))
    const gh = github({ 'b/board.json': meta('X', 'X', []), ...many })
    const snapshot = await refresh(gh.api, new RepoCache(new MemoryStorage()), 'me/board')
    let open = 0
    let most = 0
    const api = async (path: string, init?: RequestInit) => {
      most = Math.max(most, ++open)
      await new Promise(r => setTimeout(r, 1))
      open--
      return gh.api(path, init)
    }
    const loader = new ImageLoader(new ImageCache(new MemoryImages()), snapshot, api, 3)
    const answers = await Promise.all(Object.keys(many).map((_, i) => loader.load('b', `X-${i}/i.png`)))
    expect(answers.every(a => 'image' in a)).toBe(true)
    expect(most).toBe(3)
  })
})

describe('the image cache', () => {
  const image = (n: number, size: number) => ({ sha: sha(), type: 'image/png', bytes: new Uint8Array(size).fill(n) })

  it('drops the least recently shown first, to fit under its cap', async () => {
    let now = 0
    const storage = new MemoryImages()
    const cache = new ImageCache(storage, 100, () => ++now)
    const [a, b, c, d] = [image(1, 40), image(2, 40), image(3, 15), image(4, 30)]
    for (const i of [a, b, c]) await cache.put(i)
    expect(storage.images.size).toBe(3)
    await cache.get(a.sha)
    await cache.put(d)
    // 125 bytes: b, the least recently shown, goes; a was shown since, and c fits beside it.
    expect([...storage.images.keys()].sort()).toEqual([a.sha, c.sha, d.sha].sort())
  })

  it('never keeps an image larger than the cap, nor drops the one just kept', async () => {
    const storage = new MemoryImages()
    const cache = new ImageCache(storage, 50)
    await cache.put(image(1, 60))
    expect(storage.images.size).toBe(0)
    const small = image(2, 20)
    await cache.put(small)
    const fits = image(3, 50)
    await cache.put(fits)
    expect([...storage.images.keys()]).toEqual([fits.sha])
  })
})
