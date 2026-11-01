// Card images on the phone: the files a description names (`![](<ID>/<hash>.png)`) and the `cover:`
// on a card's face. GraphQL's `Blob.text` doesn't give binary files, so an image is read on its own
// through REST (`git/blobs/<sha>`, base64), when a card or a list shows it. Its sha comes from the
// tree in the snapshot, by the path the description names relative to the card file, and names its
// content, so a kept image is never stale.
//
// Images are kept in IndexedDB, not localStorage beside the text: localStorage holds about 5 MB,
// which a list of covers would fill. The store is capped (IMAGE_CAP), the least recently shown
// dropped first. The storage sits behind `ImageStorage`, so the tests keep it in memory.

import { IMAGE_TYPES, imagePath, sniffImage } from '@shared/images'
import { answerJson } from '../github/answer'
import type { Snapshot } from './cache'

type Api = (path: string, init?: RequestInit) => Promise<Response>

/** What the phone keeps of images at most, in bytes. */
export const IMAGE_CAP = 60 * 1024 * 1024

/** How many images are read from GitHub at once (a list of covers would otherwise ask for all). */
export const IMAGE_READS = 4

export type StoredImage = { sha: string; type: string; bytes: Uint8Array }

/** An image's bookkeeping, without its bytes: what the cap counts and drops by. */
export type ImageEntry = { sha: string; size: number; used: number }

/** Where images are kept: IndexedDB on the phone, memory in the tests. */
export interface ImageStorage {
  get(sha: string): Promise<StoredImage | undefined>
  put(image: StoredImage, used: number): Promise<void>
  /** Marks an image as just shown. */
  touch(sha: string, used: number): Promise<void>
  entries(): Promise<ImageEntry[]>
  remove(shas: string[]): Promise<void>
}

/** The images kept on the phone, by sha, under a cap that drops the least recently shown first. */
export class ImageCache {
  constructor(
    private readonly storage: ImageStorage,
    private readonly cap = IMAGE_CAP,
    private readonly now = () => Date.now(),
  ) {}

  async get(sha: string): Promise<StoredImage | undefined> {
    const image = await this.storage.get(sha)
    if (image) await this.storage.touch(sha, this.now())
    return image
  }

  /** Keeps an image, then drops the least recently shown until all fit under the cap. */
  async put(image: StoredImage): Promise<void> {
    if (image.bytes.byteLength > this.cap) return
    await this.storage.put(image, this.now())
    const entries = await this.storage.entries()
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    if (total <= this.cap) return
    const drop: string[] = []
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total <= this.cap) break
      if (entry.sha === image.sha) continue
      drop.push(entry.sha)
      total -= entry.size
    }
    await this.storage.remove(drop)
  }
}

/** Reads an image's blob from GitHub: undefined when its bytes aren't an image type the desktop keeps. */
export async function readImage(api: Api, repo: string, sha: string): Promise<StoredImage | undefined> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a blob sha: ${sha}`)
  const blob = await answerJson<{ content: string; encoding: string }>(await api(`/repos/${repo}/git/blobs/${sha}`), 'an image')
  if (blob.encoding !== 'base64') return undefined
  const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), c => c.charCodeAt(0))
  const kind = sniffImage(bytes)
  return kind ? { sha, type: IMAGE_TYPES[kind], bytes } : undefined
}

/** Why an image isn't shown: not in the repo (or not an image), or not read yet and no connection. */
export type ImageAnswer = { image: StoredImage } | { missing: 'absent' | 'offline' }

/**
 * Finds and reads the images of a repo's cards: the sha by path in the snapshot, then the kept copy,
 * or GitHub's (when signed in), a few at a time, each sha asked once however many cards show it.
 */
export class ImageLoader {
  private readonly pending = new Map<string, Promise<StoredImage | undefined>>()
  private running = 0
  private readonly queue: (() => void)[] = []

  constructor(
    private readonly cache: ImageCache,
    private readonly snapshot: Pick<Snapshot, 'repo' | 'images'>,
    private readonly api: Api | undefined,
    private readonly reads = IMAGE_READS,
  ) {}

  /** The image a card of `board` names as `src`, relative to its card file. */
  async load(board: string, src: string): Promise<ImageAnswer> {
    const path = imagePath(board, src)
    const sha = path === undefined ? undefined : this.snapshot.images?.[path]
    if (!sha) return { missing: 'absent' }
    const kept = await this.cache.get(sha)
    if (kept) return { image: kept }
    if (!this.api) return { missing: 'offline' }
    let read = this.pending.get(sha)
    if (!read) {
      read = this.read(sha).finally(() => this.pending.delete(sha))
      this.pending.set(sha, read)
    }
    const image = await read
    return image ? { image } : { missing: 'absent' }
  }

  private async read(sha: string): Promise<StoredImage | undefined> {
    // A read that finishes hands its turn to the next one waiting.
    if (this.running < this.reads) this.running++
    else await new Promise<void>(go => this.queue.push(go))
    try {
      const image = await readImage(this.api!, this.snapshot.repo, sha)
      if (image) await this.cache.put(image)
      return image
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.running--
    }
  }
}

/** The phone's image storage: an IndexedDB database of the bytes, and of each one's bookkeeping. */
export function indexedDbImages(name = 'corkboard-images'): ImageStorage {
  let db: Promise<IDBDatabase> | undefined
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('bytes', { keyPath: 'sha' })
        request.result.createObjectStore('entries', { keyPath: 'sha' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }))
  const run = async <T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | void) => {
    const tx = (await open()).transaction(stores, mode)
    const request = work(tx)
    return new Promise<T | undefined>((resolve, reject) => {
      tx.oncomplete = () => resolve(request ? request.result : undefined)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  return {
    get: sha => run<StoredImage>(['bytes'], 'readonly', tx => tx.objectStore('bytes').get(sha)),
    async put(image, used) {
      await run(['bytes', 'entries'], 'readwrite', tx => {
        tx.objectStore('bytes').put(image)
        tx.objectStore('entries').put({ sha: image.sha, size: image.bytes.byteLength, used } satisfies ImageEntry)
      })
    },
    async touch(sha, used) {
      await run(['entries'], 'readwrite', tx => {
        const entries = tx.objectStore('entries')
        const read = entries.get(sha)
        read.onsuccess = () => read.result && entries.put({ ...read.result, used })
      })
    },
    async entries() {
      return (await run<ImageEntry[]>(['entries'], 'readonly', tx => tx.objectStore('entries').getAll())) ?? []
    },
    async remove(shas) {
      if (!shas.length) return
      await run(['bytes', 'entries'], 'readwrite', tx => {
        for (const sha of shas) {
          tx.objectStore('bytes').delete(sha)
          tx.objectStore('entries').delete(sha)
        }
      })
    },
  }
}
