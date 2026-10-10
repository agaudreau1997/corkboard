// Paints the window in the colours of the project in front: the theme's tokens go on the root
// element over the stylesheet's own, and come off again when another project (or none) is in front.
// The terminals draw on a canvas that CSS never reaches, so they hear about every change.
//
// A change crossfades through a view transition: the browser fades a snapshot of the whole window,
// canvases included, where CSS transitions would miss the terminals and restyle every element on
// each frame. The first paint, a reduced-motion setting and the theme editor's picks (a fade per
// step of a picker's drag would trail the pointer) swap at once.

import { useEffect, useRef } from 'react'
import { themeTokens } from '@shared/theme'
import type { ProjectTheme } from '@shared/types'
import { projectIdOf, useStore } from './state'

let applied: string[] = []
let generation = 0
const listeners = new Set<() => void>()

function paint(theme: ProjectTheme | null | undefined): void {
  const style = document.documentElement.style
  for (const name of applied) style.removeProperty(name)
  const tokens = themeTokens(theme)
  for (const [name, value] of Object.entries(tokens)) style.setProperty(name, value)
  applied = Object.keys(tokens)
  for (const listener of listeners) listener()
}

function applyTheme(theme: ProjectTheme | null | undefined, fade: boolean): void {
  const mine = ++generation
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!fade || reduced || !document.startViewTransition) return paint(theme)
  // The swap runs a frame later, once the old window is captured; a newer change by then wins.
  const transition = document.startViewTransition(() => {
    if (mine === generation) paint(theme)
  })
  // A fade overtaken by the next change is skipped, which rejects `ready`: the swap still happens.
  transition.ready.catch(() => {})
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
  const previewing = useStore(s => !!s.themePreview)
  const theme = useStore(s => {
    if (s.themePreview) return s.themePreview.theme
    const id = s.activeTab ? projectIdOf(s.activeTab) : undefined
    return s.projects.find(p => p.id === id)?.theme
  })
  const painted = useRef(false)
  useEffect(() => {
    applyTheme(theme, painted.current && !previewing)
    painted.current = true
  }, [theme, previewing])
}
