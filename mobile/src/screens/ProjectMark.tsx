// How a repo is marked where it is named (its row in the side panel, the board header): its icon
// when `project.json` has one, else its colour swatch, drawn by the desktop's rule (`swatchColors`)
// so a project looks the same on both. A repo whose look isn't known yet keeps the mark's room.

import { swatchColors } from '@shared/theme'
import type { Look } from '../repo/looks'
import './ProjectMark.css'

export function ProjectMark({ look }: { look: Look | undefined }) {
  if (!look) return <span className="mark" aria-hidden />
  if (look.settings.icon) return <img className="mark mark-icon" src={look.settings.icon} alt="" />
  return (
    <span className="mark mark-swatch" aria-hidden>
      {swatchColors(look.theme).map((color, i) => (
        <i key={i} style={{ background: color }} />
      ))}
    </span>
  )
}
