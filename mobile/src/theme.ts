// The companion's colours: the desktop's stylesheet tokens (`--bg`, `--card`, `--accent`, ...),
// made by the same `themeTokens` a project's theme goes through, from the desktop's own base
// colours. So the phone looks like the desktop without a copy of its stylesheet, and a repo's
// `theme.json` paints it the way it paints the desktop. Android's status and navigation bars are
// drawn over the page's background, so their icons follow it: dark on a light theme.

import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { DEFAULT_COLORS, themeTokens } from '@shared/theme'
import type { ProjectTheme } from '@shared/types'

/** Every token, from the theme's colours over the desktop's own. */
export function tokens(theme?: ProjectTheme): Record<string, string> {
  return themeTokens({ ...theme, colors: { ...DEFAULT_COLORS, ...theme?.colors } })
}

/**
 * Sets the tokens on an element (the document's root) as custom properties. Every token is set
 * each time (the app's own colours fill what the theme leaves), so a theme never outlives its repo.
 */
export function applyTokens(element: HTMLElement, theme?: ProjectTheme): void {
  for (const [name, value] of Object.entries(tokens(theme))) element.style.setProperty(name, value)
}

/** Whether a theme is light: its background lighter than its text, as `color-scheme` says. */
export function isLight(theme?: ProjectTheme): boolean {
  return tokens(theme)['color-scheme'] === 'light'
}

/** Paints the app in a theme (none: its own colours), the system bars' icons included. */
export function paint(theme?: ProjectTheme): void {
  applyTokens(document.documentElement, theme)
  if (!Capacitor.isNativePlatform()) return
  const style = isLight(theme) ? SystemBarsStyle.Light : SystemBarsStyle.Dark
  SystemBars.setStyle({ style }).catch(e => console.warn('[theme] system bars', e))
}
