// The icons both apps draw, as shapes on a 16-unit grid: the desktop's `<Icon>`
// (src/renderer/src/components/Icon.tsx) and the companion's (mobile/src/Icon.tsx) draw them the
// same way, outlined in the text's colour (`currentColor`) with round ends, so an icon looks the
// same in either. Each place sets the size and, where it wants it finer or bolder, the stroke
// width in its stylesheet; a stylesheet's `stroke` and `fill` win over the defaults here.
//
// The card badges (✓ ≡ ⛓ ⧗ ⎇ ▶ ✎ ⏰) are text, not icons of this set, in both apps for now.

export type IconShape =
  | { d: string }
  | { circle: readonly [cx: number, cy: number, r: number] }
  | { rect: readonly [x: number, y: number, width: number, height: number, rx: number] }

export type IconDef = {
  shapes: readonly IconShape[]
  /** Outlined (the default), or filled in the text's colour (dots too small to outline). */
  filled?: boolean
  /** An outline's line ends: round unless said otherwise. */
  cap?: 'butt' | 'round'
}

export const ICONS = {
  /** The terminals toggle: up while the panel is closed, turned down when it opens. */
  'chevron-up': { shapes: [{ d: 'M3.5 10 8 5.5 12.5 10' }] },
  /** The side panel's twisty, turned down when open. */
  'chevron-right': { shapes: [{ d: 'M6 3.5 10.5 8 6 12.5' }] },
  /** Back, on the companion's header. */
  'chevron-left': { shapes: [{ d: 'M10 3.5 5.5 8 10 12.5' }] },
  'arrow-down': { shapes: [{ d: 'M8 2.5v10M3.5 8 8 12.5 12.5 8' }] },
  'arrow-up': { shapes: [{ d: 'M8 13.5v-10M3.5 8 8 3.5 12.5 8' }] },
  /** Settings: eight teeth at 45° steps around (8, 8), so it reads round at 15 px. */
  gear: {
    shapes: [
      {
        d: 'M6.57 3.31 6.74 1.52 9.26 1.52 9.43 3.31 10.3 3.67 11.69 2.53 13.47 4.31 12.33 5.7 12.69 6.57 14.48 6.74 14.48 9.26 12.69 9.43 12.33 10.3 13.47 11.69 11.69 13.47 10.3 12.33 9.43 12.69 9.26 14.48 6.74 14.48 6.57 12.69 5.7 12.33 4.31 13.47 2.53 11.69 3.67 10.3 3.31 9.43 1.52 9.26 1.52 6.74 3.31 6.57 3.67 5.7 2.53 4.31 4.31 2.53 5.7 3.67z',
      },
      { circle: [8, 8, 2.2] },
    ],
  },
  /** A window with a side panel: folds the side panel. Its divider ends square on the frame. */
  sidebar: { cap: 'butt', shapes: [{ rect: [2, 3, 12, 10, 2] }, { d: 'M6 3v10' }] },
  plus: { shapes: [{ d: 'M8 3v10M3 8h10' }] },
  /** Find, beside a board's tabs on the companion. */
  search: { shapes: [{ circle: [7, 7, 4.3] }, { d: 'M10.3 10.3 14 14' }] },
  /** A circle closing clockwise on its arrowhead. */
  refresh: { shapes: [{ d: 'M13.09 9.8A5.4 5.4 0 1 1 11.82 4.18L14.6 6.8M14.6 3.2v3.6H11' }] },
  /** The companion's side panel, at the left of a board's header. */
  menu: { shapes: [{ d: 'M2.5 4h11M2.5 8h11M2.5 12h11' }] },
  /** Closes the companion's card drawer. */
  close: { shapes: [{ d: 'M4 4 12 12M12 4 4 12' }] },
  /** A menu of more actions. */
  more: { filled: true, shapes: [{ circle: [3.5, 8, 1.3] }, { circle: [8, 8, 1.3] }, { circle: [12.5, 8, 1.3] }] },
} as const satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS

/** An icon's definition by name. */
export function iconDef(name: IconName): IconDef {
  return ICONS[name]
}

/**
 * The SVG attributes an icon is painted with, before a stylesheet's own, named as React names
 * them (both apps draw with React).
 */
export function iconPaint(icon: IconDef): {
  fill: string
  stroke: string
  strokeWidth?: number
  strokeLinecap?: 'butt' | 'round'
  strokeLinejoin?: 'round'
} {
  return icon.filled
    ? { fill: 'currentColor', stroke: 'none' }
    : { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: icon.cap ?? 'round', strokeLinejoin: 'round' }
}
