// Paints the window in the colours of the project in front: the theme's tokens go on the root
// element over the stylesheet's own, and come off again when another project (or none) is in front.
// The terminals are not painted from here: each wears its own project's colours (TerminalPanel).
//
// A change crossfades through a view transition: the browser fades a snapshot of the whole window,
// canvases included, where CSS transitions would miss the terminals and restyle every element on
// each frame. The terminals' repaints go through `repaint` too, so a theme.json edit fades the
// window and its project's terminals together rather than the terminals jumping ahead. The first
// paint, a reduced-motion setting and the theme editor's picks (a fade per step of a picker's drag
// would trail the pointer) swap at once.

import { useEffect, useRef } from 'react'
import { themeTokens } from '@shared/theme'
import type { ProjectTheme } from '@shared/types'
import { projectIdOf, useStore } from './state'

let applied: string[] = []
// The repaints waiting for the fade under way to capture the old window, by what they paint.
const pending = new Map<string, () => void>()

/**
 * Runs a change of colours, crossfaded unless `fade` is false or motion is reduced. Changes made in
 * the same task share one fade; `key` names what the change paints, so a newer one replaces one
 * still waiting, and an instant one cancels it.
 */
export function repaint(key: string, update: () => void, fade: boolean): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!fade || reduced || !document.startViewTransition) {
    pending.delete(key)
    return update()
  }
  const starting = pending.size === 0
  pending.set(key, update)
  if (!starting) return
  // The updates run a frame later, once the old window is captured.
  const transition = document.startViewTransition(() => {
    const updates = [...pending.values()]
    pending.clear()
    for (const run of updates) run()
  })
  // A fade overtaken by the next change is skipped, which rejects `ready`: the swap still happens.
  transition.ready.catch(() => {})
}

function paint(theme: ProjectTheme | null | undefined): void {
  const style = document.documentElement.style
  for (const name of applied) style.removeProperty(name)
  const tokens = themeTokens(theme)
  for (const [name, value] of Object.entries(tokens)) style.setProperty(name, value)
  applied = Object.keys(tokens)
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
    repaint('window', () => paint(theme), painted.current && !previewing)
    painted.current = true
  }, [theme, previewing])
}
