// A project's colours: `theme.json` at the root of its board repo, so every machine that opens the
// project paints it the same way, and a glance at the window says which project is in front.
//
// A theme names a few base colours. The stylesheet's other tokens (the panel shades, borders,
// secondary text, the selection tint) are mixed from them here, so a theme of four colours still
// repaints the whole window. Only the tokens whose bases a theme sets are written: the rest keep
// the stylesheet's own values, so a theme that sets only the accent leaves the greys as they were.
// A theme matching a design system can also pin any of those tokens exactly (`tokens`).

import type { ProjectTheme, ThemeColor } from './types'

export const THEME_FILE = 'theme.json'

/** The base colours in the order the settings show them and `theme.json` lists them. */
export const THEME_COLORS: { key: ThemeColor; label: string; hint: string }[] = [
  { key: 'background', label: 'Background', hint: 'The window; the panels and columns are mixed from it and the text' },
  { key: 'surface', label: 'Cards', hint: 'Card faces; unset, mixed from the background' },
  { key: 'text', label: 'Text', hint: 'Secondary and muted text are mixed from it and the background' },
  { key: 'line', label: 'Borders', hint: 'Unset, mixed from the background and the text' },
  { key: 'accent', label: 'Accent', hint: 'Buttons, the selected tab, the selection' },
  { key: 'link', label: 'Links', hint: 'Links and info' },
  { key: 'success', label: 'Success', hint: 'Synced, done, your turn' },
  { key: 'danger', label: 'Danger', hint: 'Errors, deleting, archiving' },
]

/** The stylesheet's own values (`:root` in styles.css), which an unset colour falls back to. */
export const DEFAULT_COLORS: Record<ThemeColor, string> = {
  background: '#15171c',
  surface: '#2a2f3a',
  line: '#2f3440',
  text: '#dfe2e8',
  accent: '#f0c674',
  link: '#5b8def',
  success: '#4cb782',
  danger: '#e06c6c',
}

/** Themes to start from in the settings. Each is a full set, so picking one shows all of it. */
export const THEME_PRESETS: ProjectTheme[] = [
  {
    // The app's icon: notes pinned to cork in a dark wooden frame, joined by a red string.
    name: 'Cork',
    colors: {
      background: '#1f1610',
      surface: '#3a2a1e',
      text: '#f0e2cf',
      accent: '#d9a46c',
      link: '#5b8def',
      success: '#4cb782',
      danger: '#e5534b',
    },
  },
  {
    name: 'Moss',
    colors: { background: '#131a15', surface: '#24302a', text: '#dde6df', accent: '#8fcf7a' },
  },
  {
    name: 'Tide',
    colors: { background: '#111a1f', surface: '#22303a', text: '#dbe6ec', accent: '#5ec4d6' },
  },
  {
    name: 'Plum',
    colors: { background: '#1a1420', surface: '#2f2638', text: '#e6def0', accent: '#c49cf0' },
  },
  {
    name: 'Ember',
    colors: { background: '#1d1312', surface: '#33221f', text: '#f0dfda', accent: '#f08a5d', danger: '#ff6b6b' },
  },
  {
    name: 'Paper',
    colors: { background: '#f4f1ea', surface: '#ffffff', text: '#2b2a28', accent: '#c7852a', link: '#2f6fd6', success: '#2e8f5e', danger: '#c8423b' },
  },
]

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** `#rgb` or `#rrggbb` as `#rrggbb` in lower case, else undefined. */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!HEX.test(v)) return undefined
  const hex = v.length === 4 ? `#${[...v.slice(1)].map(c => c + c).join('')}` : v
  return hex.toLowerCase()
}

/** A `theme.json`'s text as a theme: unknown or malformed colours are left out; broken JSON is undefined. */
export function parseTheme(text: string): ProjectTheme | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw)) return undefined
  const colors: ProjectTheme['colors'] = {}
  if (isObject(raw.colors)) {
    for (const { key } of THEME_COLORS) {
      const hex = normalizeHex(raw.colors[key])
      if (hex) colors[key] = hex
    }
  }
  const tokens: Record<string, string> = {}
  if (isObject(raw.tokens)) {
    for (const name of TOKEN_NAMES) {
      const hex = normalizeHex(raw.tokens[name])
      if (hex) tokens[name] = hex
    }
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
  return { ...(name ? { name } : {}), colors, ...(Object.keys(tokens).length ? { tokens } : {}) }
}

/**
 * The text of `theme.json` for a theme. Keys this app does not know (in the file, its colours and
 * its tokens) are kept from the file's `previous` text, as a card keeps its unknown front matter.
 */
export function themeText(theme: ProjectTheme, previous?: string): string {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = previous ? JSON.parse(previous) : {}
    if (isObject(parsed)) raw = parsed
  } catch {
    /* a broken file is replaced whole */
  }
  const { name: _name, colors: oldColors, tokens: oldTokens, ...rest } = raw
  const colors = known(THEME_COLORS.map(c => c.key), theme.colors, oldColors)
  const tokens = known(TOKEN_NAMES, theme.tokens ?? {}, oldTokens)
  const name = theme.name?.trim()
  const out = { ...(name ? { name } : {}), colors, ...(Object.keys(tokens).length ? { tokens } : {}), ...rest }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** The known keys' valid values in their own order, then the keys `old` had that this app does not know. */
function known(keys: readonly string[], values: Record<string, string | undefined>, old: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const hex = normalizeHex(values[key])
    if (hex) out[key] = hex
  }
  if (isObject(old)) for (const [k, v] of Object.entries(old)) if (!keys.includes(k)) out[k] = v
  return out
}

/** True when a theme sets no colour and no token: the app's own colours, and no file. */
export function isEmptyTheme(theme: ProjectTheme | null | undefined): boolean {
  return !Object.keys(themeTokens(theme)).length
}

type Rgb = [number, number, number]

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
}

/** `t` of the way from `a` to `b`, in sRGB (what the stylesheet's hand-picked shades follow). */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

type Bases = Record<ThemeColor, Rgb> & { set: Set<ThemeColor>; light: boolean }

/**
 * Every stylesheet token a theme decides: its value, and the base colours it is made from. The
 * fractions put the stylesheet's own shades where they sit between its background and its text.
 */
const TOKENS: { name: string; from: ThemeColor[]; value: (c: Bases) => string }[] = [
  { name: '--bg', from: ['background'], value: c => hex(c.background) },
  { name: '--bg-2', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.036)) },
  { name: '--panel', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.053)) },
  { name: '--column', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.067)) },
  { name: '--bg-3', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.084)) },
  { name: '--hover', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.128)) },
  { name: '--scrollbar', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.18)) },
  {
    name: '--active',
    from: ['background', 'text', 'link'],
    value: c => hex(mix(mix(c.background, c.text, 0.084), c.link, 0.1)),
  },
  { name: '--card', from: ['surface', 'background', 'text'], value: c => hex(card(c)) },
  { name: '--card-hover', from: ['surface', 'background', 'text'], value: c => hex(mix(card(c), c.text, 0.047)) },
  { name: '--line', from: ['line', 'background', 'text'], value: c => hex(line(c)) },
  { name: '--line-2', from: ['line', 'background', 'text'], value: c => hex(mix(line(c), c.text, 0.07)) },
  { name: '--text', from: ['text'], value: c => hex(c.text) },
  { name: '--text-2', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.745)) },
  { name: '--muted', from: ['background', 'text'], value: c => hex(mix(c.background, c.text, 0.54)) },
  { name: '--accent', from: ['accent'], value: c => hex(c.accent) },
  // Text on the accent: a near-black of its own hue on a light accent, a near-white on a dark one.
  {
    name: '--accent-ink',
    from: ['accent'],
    value: c => hex(luminance(hex(c.accent)) > 0.3 ? mix(c.accent, BLACK, 0.9) : mix(c.accent, WHITE, 0.92)),
  },
  { name: '--accent-hover', from: ['accent'], value: c => hex(mix(c.accent, WHITE, 0.2)) },
  { name: '--select-bg', from: ['background', 'accent'], value: c => hex(mix(c.background, c.accent, 0.1)) },
  { name: '--select-line', from: ['background', 'accent'], value: c => hex(mix(c.background, c.accent, 0.32)) },
  { name: '--blue', from: ['link'], value: c => hex(c.link) },
  { name: '--green', from: ['success'], value: c => hex(c.success) },
  { name: '--red', from: ['danger'], value: c => hex(c.danger) },
  { name: '--danger-bg', from: ['background', 'danger'], value: c => hex(mix(c.background, c.danger, 0.123)) },
  // The terminals stay dark (their programs' colours assume it); on a dark theme they take its hue.
  {
    name: '--term-bg',
    from: ['background'],
    value: c => (c.light ? '#101216' : hex(mix(c.background, BLACK, 0.22))),
  },
  // Fixed hues (commits, cloud sessions, ideas) made dark enough to read on a light background.
  { name: '--purple', from: ['background', 'text'], value: c => (c.light ? hex(mix(rgb('#c49cf0'), BLACK, 0.4)) : '#c49cf0') },
  { name: '--cyan', from: ['background', 'text'], value: c => (c.light ? hex(mix(rgb('#7cc4f5'), BLACK, 0.45)) : '#7cc4f5') },
  { name: '--idea', from: ['background', 'text'], value: c => (c.light ? hex(mix(rgb('#c9b458'), BLACK, 0.35)) : '#c9b458') },
]

/** Every token a theme may set, in the stylesheet's order. */
export const TOKEN_NAMES: readonly string[] = TOKENS.map(t => t.name)

function card(c: Bases): Rgb {
  return c.set.has('surface') ? c.surface : mix(c.background, c.text, 0.123)
}

function line(c: Bases): Rgb {
  return c.set.has('line') ? c.line : mix(c.background, c.text, 0.15)
}

/**
 * The CSS custom properties a theme sets on the document (and `color-scheme`, so the scroll bars
 * and native controls match a light theme). An empty theme sets nothing.
 */
export function themeTokens(theme: ProjectTheme | null | undefined): Record<string, string> {
  const set = new Set<ThemeColor>()
  const bases = {} as Record<ThemeColor, Rgb>
  for (const { key } of THEME_COLORS) {
    const given = normalizeHex(theme?.colors[key])
    if (given) set.add(key)
    bases[key] = rgb(given ?? DEFAULT_COLORS[key])
  }
  const exact = Object.entries(theme?.tokens ?? {}).flatMap(([name, value]) => {
    const hex = normalizeHex(value)
    return hex && TOKEN_NAMES.includes(name) ? [[name, hex] as const] : []
  })
  if (!set.size && !exact.length) return {}
  const light = luminance(hex(bases.background)) > luminance(hex(bases.text))
  const c: Bases = { ...bases, set, light }
  const out: Record<string, string> = {}
  for (const token of TOKENS) if (token.from.some(k => set.has(k))) out[token.name] = token.value(c)
  for (const [name, value] of exact) out[name] = value
  if (set.has('background') || set.has('text')) out['color-scheme'] = light ? 'light' : 'dark'
  return out
}

/** The colour a base shows as under a theme: its own, else the app's. */
export function themeColor(theme: ProjectTheme | null | undefined, key: ThemeColor): string {
  return normalizeHex(theme?.colors[key]) ?? DEFAULT_COLORS[key]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
