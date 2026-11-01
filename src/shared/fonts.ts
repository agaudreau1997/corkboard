// The type and the corner both apps draw with, as the stylesheet tokens they're read through:
// `--font` for text, `--mono` for ids and code, `--radius` for a card's corners. The desktop's
// `:root` in styles.css holds the same values (tests/fonts.test.ts keeps the two equal), and the
// Android companion sets these on its root at start, so a card face is the same family and shape
// on both, whatever size each draws it at.

export const FONT_TOKENS: Readonly<Record<'--font' | '--mono' | '--radius', string>> = {
  '--font': "Inter, 'Segoe UI', 'Noto Sans', system-ui, sans-serif",
  '--mono': "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, monospace",
  '--radius': '8px',
}
