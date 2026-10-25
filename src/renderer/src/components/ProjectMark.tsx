// How a project is marked wherever it is named (its row in the side panel, tab names, terminal tabs,
// the board header and the board dialog): its icon when `project.json` has one, else its colour
// swatch. The icon is picked in the project settings and scaled down here, in the window, so the
// file keeps a small data URI that every machine gets with the repo and the CSP lets show.

import type { ProjectNode } from '@shared/types'
import { ThemeSwatch } from './ThemeEditor'

/** The largest side of an icon as it is kept: twice the largest it is shown, for sharp screens. */
const ICON_SIZE = 64

/**
 * The project's icon, or its swatch. A project with neither shows nothing, unless `always` asks
 * for the app's own colours' swatch (where the mark stands for the project's colours too).
 */
export function ProjectMark({
  project,
  always,
  title,
}: {
  project: Pick<ProjectNode, 'icon' | 'theme'> | undefined
  always?: boolean
  title?: string
}) {
  if (project?.icon) return <img className="project-icon" src={project.icon} alt="" title={title} aria-hidden={!title} />
  if (!project?.theme && !always) return null
  return <ThemeSwatch theme={project?.theme} title={title} />
}

/** An image file as an icon: a PNG data URI at most 64 px a side, its proportions kept. */
export async function iconFromFile(file: File): Promise<string> {
  // Read as a data URI rather than an object URL: the CSP lets `data:` images in, not `blob:`.
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error(`${file.name} is not an image this window can show`))
    image.src = source
  })
  const scale = Math.min(1, ICON_SIZE / Math.max(image.naturalWidth || 1, image.naturalHeight || 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round((image.naturalWidth || ICON_SIZE) * scale))
  canvas.height = Math.max(1, Math.round((image.naturalHeight || ICON_SIZE) * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not scale the image')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
