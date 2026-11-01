// Stand-ins for the tests: localStorage and the image store in memory, and a GitHub holding one
// repo, `me/board`, that answers the calls the companion makes (the repo, its tree, GraphQL blob
// and root file sha reads, REST reads of binary blobs, and Contents API writes) the way the real
// one does.

import { serializeCard } from '@shared/cardfile'
import type { Card } from '@shared/types'
import type { ImageEntry, ImageStorage, StoredImage } from '../src/repo/images'
import type { TreeEntry } from '../src/repo/layout'

export class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.items.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.items.set(k, v)
  }
  removeItem(k: string) {
    this.items.delete(k)
  }
  clear() {
    this.items.clear()
  }
}

/** The image store in memory, with the bookkeeping IndexedDB keeps. */
export class MemoryImages implements ImageStorage {
  readonly images = new Map<string, StoredImage>()
  readonly used = new Map<string, number>()
  async get(sha: string) {
    return this.images.get(sha)
  }
  async put(image: StoredImage, used: number) {
    this.images.set(image.sha, image)
    this.used.set(image.sha, used)
  }
  async touch(sha: string, used: number) {
    if (this.images.has(sha)) this.used.set(sha, used)
  }
  async entries(): Promise<ImageEntry[]> {
    return [...this.images.values()].map(i => ({ sha: i.sha, size: i.bytes.byteLength, used: this.used.get(i.sha)! }))
  }
  async remove(shas: string[]) {
    for (const sha of shas) {
      this.images.delete(sha)
      this.used.delete(sha)
    }
  }
}

/** A PNG's signature and a few bytes: enough for the sniffing, which never decodes it. */
export const png = (...more: number[]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...more])

let shas = 0
export const sha = () => (++shas).toString(16).padStart(40, '0')

export function card(fields: Partial<Card> & { id: string; title: string; list: string | null; pos: number }): string {
  return serializeCard({ labels: [], links: [], after: [], sessions: [], body: '', extra: {}, ...fields })
}

export const meta = (key: string, title: string, lists: object[]) => JSON.stringify({ key, title, lists })

type Write = { path: string; message: string; text: string }

export function github(files: Record<string, string | Uint8Array>) {
  const blobs = new Map<string, string | Uint8Array>()
  const tree: TreeEntry[] = []
  const put = (path: string, text: string | Uint8Array) => {
    const s = sha()
    blobs.set(s, text)
    const at = tree.findIndex(e => e.path === path)
    if (at >= 0) tree[at] = { path, type: 'blob', sha: s }
    else tree.push({ path, type: 'blob', sha: s })
    return s
  }
  for (const [path, text] of Object.entries(files)) put(path, text)
  const asked: string[][] = []
  const looked: string[] = []
  const blobReads: string[] = []
  const writes: Write[] = []
  const hooks: { beforeWrite?: (path: string) => void; afterWrite?: () => void } = {}
  let offline = false

  const api = async (path: string, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch')
    if (path === '/repos/me/board') return Response.json({ default_branch: 'main' })
    if (path === '/repos/me/board/git/trees/main?recursive=1') return Response.json({ sha: sha(), truncated: false, tree })
    if (path === '/graphql') {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> }
      // A file's sha by `HEAD:<path>`, per repo: only `me/board` is here.
      if (query.includes('expression:')) {
        looked.push(query)
        const data: Record<string, unknown> = {}
        for (const [, alias, i] of query.matchAll(/(r(\d+)): repository/g)) {
          const oid = (file: string) => {
            const entry = tree.find(e => e.path === file)
            return entry ? { oid: entry.sha } : null
          }
          const here = variables[`o${i}`] === 'me' && variables[`n${i}`] === 'board'
          data[alias] = here ? { theme: oid('theme.json'), project: oid('project.json') } : null
        }
        return Response.json({ data })
      }
      const wanted = [...query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)]
      asked.push(wanted.map(m => m[2]))
      const repository = Object.fromEntries(
        wanted.map(([, alias, s]) => {
          const blob = blobs.get(s)
          return [alias, typeof blob === 'string' ? { text: blob, isBinary: false } : { text: null, isBinary: true }]
        }),
      )
      return Response.json({ data: { repository } })
    }
    const blob = /^\/repos\/me\/board\/git\/blobs\/([0-9a-f]{40})$/.exec(path)
    if (blob) {
      const bytes = blobs.get(blob[1])
      if (bytes === undefined) return Response.json({ message: 'Not Found' }, { status: 404 })
      const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      blobReads.push(blob[1])
      // GitHub wraps the base64 in lines of 60.
      const content = btoa(String.fromCharCode(...raw)).replace(/.{60}/g, '$&\n')
      return Response.json({ sha: blob[1], size: raw.length, encoding: 'base64', content })
    }
    const contents = /^\/repos\/me\/board\/contents\/(.+)$/.exec(path)
    if (contents && init?.method === 'PUT') {
      const file = contents[1].split('/').map(decodeURIComponent).join('/')
      hooks.beforeWrite?.(file)
      const body = JSON.parse(String(init.body)) as { message: string; content: string; sha?: string }
      if (tree.some(e => e.path === file) && !body.sha) {
        return Response.json({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, { status: 422 })
      }
      const current = tree.find(e => e.path === file)
      if (current && body.sha && body.sha !== current.sha) {
        return Response.json({ message: `${file} does not match ${body.sha}` }, { status: 409 })
      }
      const text = new TextDecoder().decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0)))
      writes.push({ path: file, message: body.message, text })
      const s = put(file, text)
      hooks.afterWrite?.()
      return Response.json({ content: { path: file, sha: s } }, { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }
  return {
    api,
    put,
    asked,
    looked,
    blobReads,
    tree,
    writes,
    hooks,
    goOffline: (value = true) => {
      offline = value
    },
  }
}
