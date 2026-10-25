// A card's images: the files pasted or dropped into its description live beside its file, in a
// folder named by its id (`cards/<ID>/<hash>.png`), and the description names them relative to the
// card file (`![](<ID>/<hash>.png)`), so a person, a Claude session and the app all find them by the
// same path, and they move with the card to another board without a link changing. The name is a
// hash of the bytes: two machines adding the same picture write the same file, which git merges
// without a conflict, and two different pictures never share a name.
//
// The window shows them through a protocol of the main process (`card-image://<project>/<path in
// the repo>`) rather than `file:`, so the page can load images from the board repos and nothing
// else on the disk. Pure: the renderer and the tests use it too.

/** The protocol the main process serves card images on. */
export const IMAGE_SCHEME = 'card-image'

/** The largest image the app writes: it stays in the repo's history for good. */
export const MAX_IMAGE_BYTES = 1024 * 1024

/** An image scaled down to fit is no wider or taller than this to start with. */
export const MAX_IMAGE_SIDE = 2560

/** The image types the app writes and serves, by extension. SVG is left out: it can hold scripts. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** A file's image type read off its first bytes (never its name or a claimed type), or undefined. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | undefined {
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  return undefined
}

/** The content type of an image path by its extension, or undefined for a file that is no image. */
export function imageType(file: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase()
  return ext ? IMAGE_TYPES[ext] : undefined
}

/**
 * The card id a repo path is an image of (`game/cards/MB-12/3f2a.png` -> `MB-12`), for the commit
 * messages and the sync; undefined for any other file.
 */
export function cardImageOf(file: string): string | undefined {
  const parts = file.split('/')
  if (parts.length < 3 || parts.at(-3) !== 'cards' || !imageType(parts.at(-1)!)) return undefined
  return parts.at(-2)
}

/** Whether a description's image source is a path relative to the card file (not a URL or absolute). */
export function isRelativeImage(src: string): boolean {
  return !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('\\') && !src.startsWith('#')
}

/** The images a description shows from the board repo, as written, in order, each once. */
export function cardImages(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'(][^)]*)?\)/g)) {
    const src = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1]
    if (isRelativeImage(src) && imageType(src.split(/[?#]/)[0]) && !out.includes(src)) out.push(src)
  }
  return out
}

/** The Markdown that shows an image saved for a card. */
export function imageMarkdown(src: string): string {
  return `![](${/[\s()<>]/.test(src) ? `<${src}>` : src})`
}

/**
 * The URL that shows an image a card's description names, for a board key (`<project>:<path>`);
 * undefined for a source that is not a path in the repo, or that climbs out of it.
 */
export function imageUrl(boardKey: string, src: string): string | undefined {
  if (!isRelativeImage(src)) return undefined
  const i = boardKey.indexOf(':')
  if (i < 0) return undefined
  const project = boardKey.slice(0, i)
  const board = boardKey.slice(i + 1)
  const parts: string[] = [...board.split('/').filter(Boolean), 'cards']
  for (const raw of src.split(/[?#]/)[0].split(/[/\\]/)) {
    let seg = raw
    try {
      seg = decodeURIComponent(raw)
    } catch {
      /* a stray % stays as written */
    }
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(seg)
  }
  if (!parts.length) return undefined
  return `${IMAGE_SCHEME}://${encodeURIComponent(project)}/${parts.map(encodeURIComponent).join('/')}`
}

/**
 * A `card-image:` URL back to its project and path in the repo, refusing anything that could name a
 * file outside it or a hidden one (`..`, `.git`, a backslash, an empty or encoded separator).
 */
export function parseImageUrl(url: string): { projectId: string; rel: string } | undefined {
  const m = new RegExp(`^${IMAGE_SCHEME}://([^/?#]+)/([^?#]*)`).exec(url)
  if (!m) return undefined
  try {
    const projectId = decodeURIComponent(m[1])
    const parts = m[2].split('/').map(decodeURIComponent)
    if (!projectId || !parts.length) return undefined
    for (const p of parts) {
      if (!p || p.startsWith('.') || /[\\/\0:]/.test(p)) return undefined
    }
    return { projectId, rel: parts.join('/') }
  } catch {
    return undefined
  }
}

/**
 * The size to draw an image at to make it smaller, at the `step`th try: the longest side brought
 * down to MAX_IMAGE_SIDE, then three quarters of that at every try after the first.
 */
export function scaledSize(width: number, height: number, step: number): { width: number; height: number } {
  const longest = Math.max(width, height, 1)
  const scale = Math.min(1, MAX_IMAGE_SIDE / longest) * 0.75 ** step
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * A description with an image's Markdown put in at a selection, on a line of its own: whatever
 * stood around the cursor stays on either side. Answers the text and where the cursor goes.
 */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  const out = `${before}${lead}${insert}${trail}${after}`
  return { text: out, cursor: before.length + lead.length + insert.length }
}
