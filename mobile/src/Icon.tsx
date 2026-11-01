// An icon of the set both apps share (src/shared/icons.ts), as an inline SVG in the text's colour.
// Where it sits sets its size and stroke width in the stylesheet; the desktop's `<Icon>` draws the
// same shapes the same way.

import { iconDef, iconPaint, type IconName, type IconShape } from '@shared/icons'

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const icon = iconDef(name)
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} {...iconPaint(icon)}>
      {icon.shapes.map((shape, i) => (
        <IconPart key={i} shape={shape} />
      ))}
    </svg>
  )
}

function IconPart({ shape }: { shape: IconShape }) {
  if ('circle' in shape) {
    const [cx, cy, r] = shape.circle
    return <circle cx={cx} cy={cy} r={r} />
  }
  if ('rect' in shape) {
    const [x, y, width, height, rx] = shape.rect
    return <rect x={x} y={y} width={width} height={height} rx={rx} />
  }
  return <path d={shape.d} />
}
