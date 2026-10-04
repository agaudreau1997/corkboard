// Paints the window in the colours of the project in front: the theme's tokens go on the root
// element over the stylesheet's own, and come off again when another project (or none) is in front.
// The terminals draw on a canvas that CSS never reaches, so they hear about every change.

import { useEffect } from 'react'
import { themeTokens } from '@shared/theme'
import type { ProjectTheme } from '@shared/types'
import { projectIdOf, useStore } from './state'

let applied: string[] = []
const listeners = new Set<() => void>()

function applyTheme(theme: ProjectTheme | null | undefined): void {
  const style = document.documentElement.style
  for (const name of applied) style.removeProperty(name)
  const tokens = themeTokens(theme)
  for (const [name, value] of Object.entries(tokens)) style.setProperty(name, value)
  applied = Object.keys(tokens)
  for (const listener of listeners) listener()
}

/** Calls `cb` after every repaint of the window's colours. */
export function onThemeApplied(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** A stylesheet token's current value, theme included. */
export function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** The theme on screen: the one being edited in the settings, else that of the board in front. */
export function useProjectTheme(): void {
  const theme = useStore(s => {
    if (s.themePreview) return s.themePreview.theme
    const id = s.activeTab ? projectIdOf(s.activeTab) : undefined
    return s.projects.find(p => p.id === id)?.theme
  })
  useEffect(() => applyTheme(theme), [theme])
}
