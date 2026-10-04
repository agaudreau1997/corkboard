import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COLORS,
  isEmptyTheme,
  luminance,
  normalizeHex,
  parseTheme,
  THEME_PRESETS,
  themeText,
  themeTokens,
  TOKEN_NAMES,
} from '@shared/theme'

/** The stylesheet's own token values, from `:root` in styles.css. */
function stylesheetTokens(): Record<string, string> {
  const css = readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
  const root = /:root\s*\{([^}]*)\}/.exec(css)![1]
  return Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(m => [m[1], m[2].toLowerCase()]))
}

const channels = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16))

describe('theme.json', () => {
  it('reads the colours it knows, normalised, and leaves out the rest', () => {
    const theme = parseTheme(
      JSON.stringify({
        name: ' Cork ',
        colors: { background: '#ABC', accent: '#D9A46C', text: 'red', glow: '#ffffff', link: 12 },
        tokens: { '--panel': '#16161D', '--nope': '#000000', '--bg-2': 'blue' },
        fonts: { body: 'VGA16' },
      }),
    )
    expect(theme).toEqual({
      name: 'Cork',
      colors: { background: '#aabbcc', accent: '#d9a46c' },
      tokens: { '--panel': '#16161d' },
    })
    expect(parseTheme('{"colors": {')).toBeUndefined()
    expect(parseTheme('[]')).toBeUndefined()
    expect(parseTheme('{}')).toEqual({ colors: {} })
  })

  it('writes the known keys in a fixed order and keeps the ones it does not know', () => {
    const previous = `${JSON.stringify(
      {
        fonts: { body: 'VGA16' },
        colors: { glow: '#ffffff', accent: '#000000' },
        tokens: { '--panel': '#000000', '--radius-px': 0 },
        name: 'Old',
      },
      null,
      2,
    )}\n`
    const text = themeText(
      { name: 'Deus', colors: { accent: '#D89A30', background: '#0e0e12' }, tokens: { '--panel': '#16161d' } },
      previous,
    )
    expect(JSON.parse(text)).toEqual({
      name: 'Deus',
      colors: { background: '#0e0e12', accent: '#d89a30', glow: '#ffffff' },
      tokens: { '--panel': '#16161d', '--radius-px': 0 },
      fonts: { body: 'VGA16' },
    })
    expect(Object.keys(JSON.parse(text))).toEqual(['name', 'colors', 'tokens', 'fonts'])
    expect(Object.keys(JSON.parse(text).colors)).toEqual(['background', 'accent', 'glow'])
    // What it writes reads back as the same theme, and writing that again changes nothing.
    expect(themeText(parseTheme(text)!, text)).toBe(text)
    expect(themeText({ colors: { text: '#fff' } })).toBe('{\n  "colors": {\n    "text": "#ffffff"\n  }\n}\n')
  })

  it('normalises hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex(' #D9a46C ')).toBe('#d9a46c')
    expect(normalizeHex('#abcd')).toBeUndefined()
    expect(normalizeHex('d9a46c')).toBeUndefined()
    expect(normalizeHex(undefined)).toBeUndefined()
  })
})

describe('theme tokens', () => {
  it('sets nothing for an empty theme', () => {
    expect(themeTokens(undefined)).toEqual({})
    expect(themeTokens({ colors: {} })).toEqual({})
    expect(themeTokens({ colors: { accent: 'nope' } })).toEqual({})
    expect(isEmptyTheme({ name: 'Nameless', colors: {} })).toBe(true)
    expect(isEmptyTheme({ colors: {}, tokens: { '--panel': '#16161d' } })).toBe(false)
  })

  it('only touches the tokens made from the colours a theme sets', () => {
    const tokens = themeTokens({ colors: { accent: '#5ec4d6' } })
    expect(Object.keys(tokens).sort()).toEqual(
      ['--accent', '--accent-hover', '--accent-ink', '--select-bg', '--select-line'].sort(),
    )
    expect(tokens['--accent']).toBe('#5ec4d6')
    // No background or text: the greys and the page's colour scheme stay the stylesheet's.
    expect(tokens['--bg']).toBeUndefined()
    expect(tokens['color-scheme']).toBeUndefined()
  })

  it('mixes the stylesheet own shades back out of its own colours', () => {
    // A theme of the default colours looks like no theme: every token it sets lands within a
    // few steps of the value styles.css gives it (the selection's border, a hand-picked browner
    // gold, furthest), so the fractions in theme.ts stay calibrated.
    const css = stylesheetTokens()
    const tokens = themeTokens({ colors: { ...DEFAULT_COLORS } })
    for (const name of TOKEN_NAMES) {
      expect(css[name], `${name} in styles.css`).toBeDefined()
      const off = channels(tokens[name]).map((v, i) => Math.abs(v - channels(css[name])[i]))
      expect(Math.max(...off), `${name}: ${tokens[name]} vs ${css[name]}`).toBeLessThanOrEqual(14)
    }
    expect(tokens['color-scheme']).toBe('dark')
  })

  it('makes a light theme light, keeping the terminals dark', () => {
    const paper = THEME_PRESETS.find(p => p.name === 'Paper')!
    const tokens = themeTokens(paper)
    expect(tokens['color-scheme']).toBe('light')
    expect(tokens['--term-bg']).toBe('#101216')
    expect(luminance(tokens['--bg-3'])).toBeLessThan(luminance(tokens['--bg']))
    // Text on the accent reads: dark on a light accent, light on a dark one.
    expect(luminance(themeTokens({ colors: { accent: '#f0c674' } })['--accent-ink'])).toBeLessThan(0.05)
    expect(luminance(themeTokens({ colors: { accent: '#4a2f60' } })['--accent-ink'])).toBeGreaterThan(0.6)
  })

  it('lets a theme pin exact tokens over what its colours mix', () => {
    const tokens = themeTokens({ colors: { background: '#0e0e12' }, tokens: { '--panel': '#16161d', '--made-up': '#ffffff' } })
    expect(tokens['--panel']).toBe('#16161d')
    expect(tokens['--bg']).toBe('#0e0e12')
    expect(tokens['--made-up']).toBeUndefined()
  })

  it('gives every preset a name and colours it can parse back', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.name).toBeTruthy()
      expect(parseTheme(themeText(preset))).toEqual(preset)
    }
  })
})
