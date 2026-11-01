// Stand-ins for the tests: localStorage in memory, and a GitHub holding one repo, `me/board`, that
// answers the calls the companion makes (the repo, its tree, GraphQL blob reads, and Contents API
// writes) the way the real one does.

import { serializeCard } from '@shared/cardfile'
import type { Card } from '@shared/types'
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

let shas = 0
export const sha = () => (++shas).toString(16).padStart(40, '0')

export function card(fields: Partial<Card> & { id: string; title: string; list: string | null; pos: number }): string {
  return serializeCard({ labels: [], links: [], after: [], sessions: [], body: '', extra: {}, ...fields })
}

export const meta = (key: string, title: string, lists: object[]) => JSON.stringify({ key, title, lists })

type Write = { path: string; message: string; text: string }

export function github(files: Record<string, string>) {
  const blobs = new Map<string, string>()
  const tree: TreeEntry[] = []
  const put = (path: string, text: string) => {
    const s = sha()
    blobs.set(s, text)
    const at = tree.findIndex(e => e.path === path)
    if (at >= 0) tree[at] = { path, type: 'blob', sha: s }
    else tree.push({ path, type: 'blob', sha: s })
    return s
  }
  for (const [path, text] of Object.entries(files)) put(path, text)
  const asked: string[][] = []
  const writes: Write[] = []
  const hooks: { beforeWrite?: (path: string) => void; afterWrite?: () => void } = {}
  let offline = false

  const api = async (path: string, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch')
    if (path === '/repos/me/board') return Response.json({ default_branch: 'main' })
    if (path === '/repos/me/board/git/trees/main?recursive=1') return Response.json({ sha: sha(), truncated: false, tree })
    if (path === '/graphql') {
      const query = JSON.parse(String(init?.body)).query as string
      const wanted = [...query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)]
      asked.push(wanted.map(m => m[2]))
      const repository = Object.fromEntries(wanted.map(([, alias, s]) => [alias, { text: blobs.get(s), isBinary: false }]))
      return Response.json({ data: { repository } })
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
    writes,
    hooks,
    goOffline: (value = true) => {
      offline = value
    },
  }
}
