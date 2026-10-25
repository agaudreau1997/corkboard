// Serves the card images of the board repos to the window, on the `card-image:` protocol (see
// src/shared/images.ts for the URL and where the files live). The page's CSP lets it load images
// from that protocol and not from `file:`, so this is the one door to the disk, and it opens on
// image files inside a board repo only: a path that climbs out, a hidden folder (`.git`), a
// symlink that points outside the repo or a file of any other type gets a 404.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { imageType, parseImageUrl } from '@shared/images'

/**
 * The file a path in a board repo names and its content type, when it is an image file that is
 * really inside the repo (symlinks followed); undefined otherwise.
 */
export async function resolveImage(root: string, rel: string): Promise<{ file: string; type: string } | undefined> {
  const type = imageType(rel)
  if (!type || rel.includes('\0')) return undefined
  const base = path.resolve(root)
  const file = path.resolve(base, rel)
  if (!inside(base, file)) return undefined
  if (path.relative(base, file).split(path.sep).some(p => p.startsWith('.'))) return undefined
  try {
    const [realBase, realFile] = await Promise.all([fs.realpath(base), fs.realpath(file)])
    if (!inside(realBase, realFile) || !imageType(realFile)) return undefined
    if (!(await fs.stat(realFile)).isFile()) return undefined
    return { file: realFile, type }
  } catch {
    return undefined
  }
}

/** The protocol's answer to a request, given the board repo of each open project. */
export async function serveImage(url: string, rootOf: (projectId: string) => string | undefined): Promise<Response> {
  const parsed = parseImageUrl(url)
  const root = parsed && rootOf(parsed.projectId)
  const found = parsed && root ? await resolveImage(root, parsed.rel) : undefined
  if (!found) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  const data = await fs.readFile(found.file)
  return new Response(new Uint8Array(data), {
    headers: { 'content-type': found.type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' },
  })
}

function inside(base: string, file: string): boolean {
  const rel = path.relative(base, file)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}
