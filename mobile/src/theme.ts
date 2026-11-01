// The companion's colours: the desktop's stylesheet tokens (`--bg`, `--card`, `--accent`, ...),
// made by the same `themeTokens` a project's theme goes through, from the desktop's own base
// colours. So the phone looks like the desktop without a copy of its stylesheet, and painting a
// project's `theme.json` later is a matter of passing it here.

import { DEFAULT_COLORS, themeTokens } from '@shared/theme'
import type { ProjectTheme } from '@shared/types'

/** Every token, from the theme's colours over the desktop's own. */
export function tokens(theme?: ProjectTheme): Record<string, string> {
  return themeTokens({ ...theme, colors: { ...DEFAULT_COLORS, ...theme?.colors } })
}

/** Sets the tokens on an element (the document's root) as custom properties. */
export function applyTokens(element: HTMLElement, theme?: ProjectTheme): void {
  for (const [name, value] of Object.entries(tokens(theme))) element.style.setProperty(name, value)
}
