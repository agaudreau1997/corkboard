import { useEffect, useState } from 'react'
import {
  DEFAULT_COLORS,
  isEmptyTheme,
  normalizeHex,
  THEME_COLORS,
  THEME_PRESETS,
  themeTokens,
} from '@shared/theme'
import type { ProjectTheme, ThemeColor } from '@shared/types'

/** The stylesheet token each base colour shows as, to show an unset one's mixed value. */
const TOKEN_OF: Record<ThemeColor, string> = {
  background: '--bg',
  surface: '--card',
  line: '--line',
  text: '--text',
  accent: '--accent',
  link: '--blue',
  success: '--green',
  danger: '--red',
}

/** A colour as a theme paints it: its own, mixed from the others, or the app's. */
function shownColor(theme: ProjectTheme | null | undefined, key: ThemeColor): string {
  return themeTokens(theme)[TOKEN_OF[key]] ?? DEFAULT_COLORS[key]
}

/** A theme in small: its background, its cards and its accent. */
export function ThemeSwatch({ theme, title }: { theme: ProjectTheme | null | undefined; title?: string }) {
  return (
    <span className="theme-swatch" title={title} aria-hidden={!title}>
      {(['background', 'surface', 'accent'] as const).map(key => (
        <i key={key} style={{ background: shownColor(theme, key) }} />
      ))}
    </span>
  )
}

const sameColors = (a: ProjectTheme, b: ProjectTheme) =>
  THEME_COLORS.every(({ key }) => normalizeHex(a.colors[key]) === normalizeHex(b.colors[key]))

/** Picks a preset, or sets each base colour; `null` is the app's own colours. */
export function ThemeEditor({
  theme,
  onChange,
}: {
  theme: ProjectTheme | null
  onChange: (theme: ProjectTheme | null) => void
}) {
  const presetNames = new Set(THEME_PRESETS.map(p => p.name))
  const setColor = (key: ThemeColor, value: string | undefined) => {
    const colors = { ...theme?.colors }
    if (value) colors[key] = value
    else delete colors[key]
    // A preset changed by hand is no longer that preset; a name of your own stays.
    const name = theme?.name && !presetNames.has(theme.name) ? theme.name : undefined
    onChange({ ...theme, name, colors })
  }
  const pinned = Object.keys(theme?.tokens ?? {}).length

  return (
    <div className="field theme-editor">
      <span>Colours</span>
      <div className="theme-presets" role="group" aria-label="Themes">
        <button
          type="button"
          className={`theme-preset${isEmptyTheme(theme) ? ' on' : ''}`}
          onClick={() => onChange(null)}
        >
          <ThemeSwatch theme={null} />
          Default
        </button>
        {THEME_PRESETS.map(preset => (
          <button
            type="button"
            key={preset.name}
            className={`theme-preset${theme && !pinned && sameColors(theme, preset) ? ' on' : ''}`}
            onClick={() => onChange(preset)}
          >
            <ThemeSwatch theme={preset} />
            {preset.name}
          </button>
        ))}
      </div>
      <div className="theme-colors">
        {THEME_COLORS.map(({ key, label, hint }) => (
          <ColorField
            key={key}
            label={label}
            hint={hint}
            value={normalizeHex(theme?.colors[key])}
            shown={shownColor(theme, key)}
            onChange={value => setColor(key, value)}
          />
        ))}
      </div>
      {pinned > 0 && (
        <small className="muted">
          {theme?.name ?? 'This theme'} also pins {pinned} exact shade{pinned === 1 ? '' : 's'} (<code>tokens</code> in
          theme.json), over what these colours mix.{' '}
          <button type="button" className="link small" onClick={() => onChange({ ...theme!, tokens: undefined })}>
            Drop them
          </button>
        </small>
      )}
      <small className="muted">
        Kept in <code>theme.json</code> at the board repo's root, so every machine shows the project in these colours.
        The window takes them whenever one of its boards is in front.
      </small>
    </div>
  )
}

/** One base colour: a picker, its hex, and a reset when it is set. Unset, it shows what it mixes to. */
function ColorField({
  label,
  hint,
  value,
  shown,
  onChange,
}: {
  label: string
  hint: string
  value: string | undefined
  shown: string
  onChange: (value: string | undefined) => void
}) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  return (
    <div className={`theme-color${value ? '' : ' auto'}`} title={hint}>
      <input type="color" value={shown} aria-label={`${label} colour`} onChange={e => onChange(e.target.value)} />
      <span className="theme-color-label">{label}</span>
      <input
        className="mono"
        value={text}
        placeholder="auto"
        aria-label={`${label} hex`}
        spellCheck={false}
        onChange={e => {
          setText(e.target.value)
          const hex = normalizeHex(e.target.value)
          if (hex) onChange(hex)
          else if (!e.target.value.trim()) onChange(undefined)
        }}
        onBlur={() => setText(value ?? '')}
      />
      <button
        type="button"
        className="icon-button small"
        aria-label={`Reset ${label}`}
        title="Back to auto"
        disabled={!value}
        onClick={() => onChange(undefined)}
      >
        ×
      </button>
    </div>
  )
}
