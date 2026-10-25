import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cardImageOf,
  cardImages,
  imageMarkdown,
  imageUrl,
  insertAt,
  MAX_IMAGE_SIDE,
  parseImageUrl,
  scaledSize,
  sniffImage,
} from '@shared/images'
import { resolveImage, serveImage } from '../src/main/images'

/** The first bytes of a PNG: enough for the sniffing and the server, which never decode it. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])

describe('card image paths', () => {
  it('tells an image by its bytes, not its name', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('gif')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(sniffImage(new TextEncoder().encode('<html><script>'))).toBeUndefined()
  })

  it('finds the images a description shows from the repo, once each', () => {
    const body = [
      'Before ![](MB-12/3f2a.png) and ![a shot](<MB-12/with space.jpg> "title")',
      '![](https://example.com/x.png) ![](data:image/png;base64,AAAA) ![](/abs/x.png)',
      '![](MB-12/3f2a.png) ![](MB-12/notes.txt) [not an image](MB-12/b.png)',
    ].join('\n')
    expect(cardImages(body)).toEqual(['MB-12/3f2a.png', 'MB-12/with space.jpg'])
  })

  it('writes the Markdown for a saved image, bracketing a path with spaces', () => {
    expect(imageMarkdown('MB-12/3f2a.png')).toBe('![](MB-12/3f2a.png)')
    expect(imageMarkdown('MB-12/a b.png')).toBe('![](<MB-12/a b.png>)')
  })

  it('names the card an image belongs to', () => {
    expect(cardImageOf('game/cards/MB-12/3f2a.png')).toBe('MB-12')
    expect(cardImageOf('cards/MB-12/3f2a.WEBP')).toBe('MB-12')
    expect(cardImageOf('game/cards/MB-12.md')).toBeUndefined()
    expect(cardImageOf('game/cards/MB-12/notes.md')).toBeUndefined()
    expect(cardImageOf('game/assets/MB-12/3f2a.png')).toBeUndefined()
  })

  it('maps a source relative to the card file to a URL of the protocol, and back', () => {
    const url = imageUrl('cork:game/ideas', 'MB-12/3f2a.png')
    expect(url).toBe('card-image://cork/game/ideas/cards/MB-12/3f2a.png')
    expect(parseImageUrl(url!)).toEqual({ projectId: 'cork', rel: 'game/ideas/cards/MB-12/3f2a.png' })
    // Another board's image, named by a relative path that stays in the repo.
    expect(imageUrl('cork:game/ideas', '../../cards/MB-3/a.png')).toBe('card-image://cork/game/cards/MB-3/a.png')
    const spaced = imageUrl('cork:game', 'MB-1/a%20b.png')!
    expect(parseImageUrl(spaced)).toEqual({ projectId: 'cork', rel: 'game/cards/MB-1/a b.png' })
  })

  it('refuses sources and URLs that climb out of the repo or into a hidden folder', () => {
    expect(imageUrl('cork:game', '../../../etc/x.png')).toBeUndefined()
    expect(imageUrl('cork:game', '/etc/x.png')).toBeUndefined()
    expect(imageUrl('cork:game', 'file:///etc/x.png')).toBeUndefined()
    expect(imageUrl('cork:game', 'https://example.com/x.png')).toBeUndefined()
    for (const url of [
      'card-image://cork/../etc/x.png',
      'card-image://cork/game/%2e%2e/%2e%2e/x.png',
      'card-image://cork/game/..%2F..%2Fx.png',
      'card-image://cork/game/..%5C..%5Cx.png',
      'card-image://cork/.git/x.png',
      'card-image://cork/game//x.png',
      'card-image://cork/game/x%00.png',
      'card-image://cork/C:/x.png',
      'card-image://cork/',
      'file:///etc/passwd',
      'card-image://cork/game/%E0%A4%A.png',
    ]) {
      expect(parseImageUrl(url), url).toBeUndefined()
    }
  })

  it('puts an image on a line of its own at the cursor', () => {
    expect(insertAt('', 0, 0, '![](a.png)')).toEqual({ text: '![](a.png)', cursor: 10 })
    expect(insertAt('one two', 3, 3, '![](a.png)')).toEqual({ text: 'one\n![](a.png)\n two', cursor: 14 })
    expect(insertAt('one\n', 4, 4, '![](a.png)').text).toBe('one\n![](a.png)')
    expect(insertAt('one REPLACED two', 4, 12, 'X').text).toBe('one \nX\n two')
  })

  it('scales the longest side down to the cap, then by quarters', () => {
    expect(scaledSize(800, 600, 0)).toEqual({ width: 800, height: 600 })
    expect(scaledSize(800, 600, 1)).toEqual({ width: 600, height: 450 })
    const big = scaledSize(MAX_IMAGE_SIDE * 2, MAX_IMAGE_SIDE, 0)
    expect(big).toEqual({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE / 2 })
    expect(scaledSize(1, 1, 20)).toEqual({ width: 1, height: 1 })
  })
})

describe('the image protocol', () => {
  let dir: string
  let root: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-images-'))
    root = path.join(dir, 'board')
    mkdirSync(path.join(root, 'game/cards/MB-1'), { recursive: true })
    mkdirSync(path.join(root, '.git'), { recursive: true })
    writeFileSync(path.join(root, 'game/cards/MB-1/a.png'), PNG)
    writeFileSync(path.join(root, 'game/cards/MB-1.md'), '---\nid: MB-1\n---\n')
    writeFileSync(path.join(root, '.git/x.png'), PNG)
    writeFileSync(path.join(dir, 'secret.png'), PNG)
    writeFileSync(path.join(dir, 'secret.txt'), 'secret')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('serves an image file of the repo with its type', async () => {
    expect(await resolveImage(root, 'game/cards/MB-1/a.png')).toMatchObject({ type: 'image/png' })
    const res = await serveImage('card-image://cork/game/cards/MB-1/a.png', id => (id === 'cork' ? root : undefined))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('answers 404 for anything else', async () => {
    const rootOf = (id: string) => (id === 'cork' ? root : undefined)
    for (const url of [
      'card-image://cork/game/cards/MB-1.md',
      'card-image://cork/game/cards/MB-1/missing.png',
      'card-image://cork/.git/x.png',
      'card-image://other/game/cards/MB-1/a.png',
      'card-image://cork/game/cards/MB-1',
    ]) {
      expect((await serveImage(url, rootOf)).status, url).toBe(404)
    }
    expect(await resolveImage(root, '../secret.png')).toBeUndefined()
    expect(await resolveImage(root, path.join(dir, 'secret.png'))).toBeUndefined()
    expect(await resolveImage(root, '.git/x.png')).toBeUndefined()
    expect(await resolveImage(root, 'game/cards/MB-1.md')).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('follows no symlink out of the repo', async () => {
    symlinkSync(path.join(dir, 'secret.png'), path.join(root, 'game/cards/MB-1/out.png'))
    symlinkSync(path.join(dir, 'secret.txt'), path.join(root, 'game/cards/MB-1/text.png'))
    symlinkSync(dir, path.join(root, 'game/cards/MB-1/up'))
    symlinkSync(path.join(root, 'game/cards/MB-1/a.png'), path.join(root, 'game/cards/MB-1/in.png'))
    expect(await resolveImage(root, 'game/cards/MB-1/out.png')).toBeUndefined()
    expect(await resolveImage(root, 'game/cards/MB-1/text.png')).toBeUndefined()
    expect(await resolveImage(root, 'game/cards/MB-1/up/secret.png')).toBeUndefined()
    expect(await resolveImage(root, 'game/cards/MB-1/in.png')).toMatchObject({ type: 'image/png' })
  })
})
