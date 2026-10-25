// Images pasted or dropped into a card's description, on their way to the board repo. One that is
// small enough and of a type the app keeps goes as it is; a bigger one (or a type it doesn't keep,
// like a BMP) is drawn again smaller, as WebP, until it fits under MAX_IMAGE_BYTES: the picture
// stays in the repo's history for good, and a screenshot reads just as well at a quarter of the
// bytes. The main process checks the type and the size again before it writes anything.

import { IMAGE_TYPES, imageMarkdown, MAX_IMAGE_BYTES, scaledSize } from '@shared/images'
import { api } from './state'

const KEPT = new Set(Object.values(IMAGE_TYPES))
const TRIES = 8

/** The image files among a paste's or a drop's. */
export function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter(f => f.type.startsWith('image/'))
}

/** An image's bytes as the board repo keeps them, and whether they had to be made smaller. */
export async function prepareImage(blob: Blob): Promise<{ bytes: Uint8Array; scaled: boolean }> {
  if (blob.size <= MAX_IMAGE_BYTES && KEPT.has(blob.type)) {
    return { bytes: new Uint8Array(await blob.arrayBuffer()), scaled: false }
  }
  const bitmap = await createImageBitmap(blob)
  try {
    for (let step = 0; step < TRIES; step++) {
      const size = scaledSize(bitmap.width, bitmap.height, step)
      const canvas = new OffscreenCanvas(size.width, size.height)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height)
      const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
      if (out.size <= MAX_IMAGE_BYTES) return { bytes: new Uint8Array(await out.arrayBuffer()), scaled: true }
    }
  } finally {
    bitmap.close()
  }
  throw new Error('The image is too big to keep, even scaled down.')
}

/** Saves one image beside a card; answers its path as a description names it, and whether it was scaled. */
export async function saveImage(boardPath: string, id: string, file: Blob): Promise<{ src: string; scaled: boolean }> {
  const prepared = await prepareImage(file)
  return { src: await api.cards.addImage(boardPath, id, prepared.bytes), scaled: prepared.scaled }
}

/**
 * Saves images for a card and answers the Markdown that shows them, one per line, and how many
 * were scaled down.
 */
export async function saveImages(boardPath: string, id: string, files: Blob[]): Promise<{ markdown: string; scaled: number }> {
  const lines: string[] = []
  let scaled = 0
  for (const file of files) {
    const saved = await saveImage(boardPath, id, file)
    if (saved.scaled) scaled++
    lines.push(imageMarkdown(saved.src))
  }
  return { markdown: lines.join('\n'), scaled }
}
