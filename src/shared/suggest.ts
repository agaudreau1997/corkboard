// What the project settings' *Suggest from the code repo* asks a headless `claude -p` for, and how
// its answer is read back. A project's colours and its icon are usually sitting in its code repo
// already (a stylesheet's custom properties, a theme file, a favicon, the logo in its README), and
// a session finds them far better than a rule could; it answers as JSON, since `claude -p` writes
// text and nothing else. Pure, so the tests can read the prompt and the parser.
//
// The answer is read generously: a session asked for JSON may still wrap it in a sentence or a
// fenced block, and a colour it could not find is better left out than invented. Only the shape is
// insisted on, through the same `parseTheme` that reads a `theme.json` written by hand: a colour
// that is not `#rrggbb` is dropped, and an answer with no colour at all is no answer.

import { parseTheme } from './theme'
import type { ThemeSuggestion } from './types'

/** The largest image file a suggestion may name, as the prompt says and the app enforces. */
export const MAX_ICON_BYTES = 2 * 1024 * 1024

/** The prompt the session gets, in the code repo of the project named. */
export function suggestPrompt(project: string): string {
  const megabytes = Math.round(MAX_ICON_BYTES / (1024 * 1024))
  return `Corkboard, the board app whose cards you work from, is asking about this project's own look: it paints its window in a project's colours and shows the project's icon wherever it names it. The project is "${project}" and you are in its code repo.

Find the colours this project already uses — CSS custom properties or a stylesheet's palette, a theme or design-token file, a Tailwind or editor theme, the colours of the README's badges and screenshots — and one small image that stands for it: a favicon, an app icon among its build files, a logo its README shows.

Answer with one JSON object and nothing else:

{
  "name": "a short name for the theme",
  "colors": {
    "background": "#rrggbb",
    "surface": "#rrggbb",
    "text": "#rrggbb",
    "line": "#rrggbb",
    "accent": "#rrggbb",
    "link": "#rrggbb",
    "success": "#rrggbb",
    "danger": "#rrggbb"
  },
  "icon": "a path in this repo",
  "notes": "where these came from, in one sentence"
}

- \`background\` is the window behind everything, \`surface\` a card's face on it, \`text\` the body text, \`line\` the borders, \`accent\` the buttons and the selection, \`link\` the links, \`success\` and \`danger\` the good and the bad news. A light theme is as welcome as a dark one, whichever this project's own look is, but the text has to stay readable on the background, and a card has to be told from the window behind it.
- Every colour is \`#rrggbb\`. Leave one out rather than invent it: \`surface\` and \`line\` are mixed from the others when they are missing, and \`background\`, \`text\` and \`accent\` are the ones worth finding. If the repo says nothing about colour at all, say so in "notes" and give what little it does say.
- \`icon\` is the path of a PNG, JPEG, GIF, WebP or ICO file in this repo, relative to its root (\`build/icon.png\`), no larger than ${megabytes} MB; the app scales it down to 64 px itself. Leave it out if the repo holds no such image: an SVG is no use here, the app cannot read one.
- Read the repo and answer; change nothing in it, and run nothing that would.`
}

/**
 * A session's answer as a suggestion: the JSON object in it, however it was wrapped. Undefined
 * when there is none, or when it names no colour the app can use.
 */
export function parseSuggestion(answer: string): ThemeSuggestion | undefined {
  for (const raw of objectsIn(answer)) {
    // A session asked for the colours at the top level may nest them under the theme instead.
    const body = isObject(raw.theme) ? raw.theme : raw
    const theme = parseTheme(JSON.stringify(body))
    if (!theme || !Object.keys(theme.colors).length) continue
    const iconPath = suggestedIcon(body.icon ?? raw.icon)
    const notes = oneLine(body.notes ?? raw.notes)
    return { theme, ...(iconPath ? { iconPath } : {}), ...(notes ? { notes } : {}) }
  }
  return undefined
}

/**
 * The image a suggestion names, as a path relative to the code repo's root: undefined for a URL,
 * an absolute path, or one that climbs out of the repo. Where the path really lands is checked
 * again where the file is read, against the repo it is read from.
 */
export function suggestedIcon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const given = value.trim()
  if (!given || given.length > 500 || given.includes('\0')) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(given)) return undefined
  if (given.startsWith('/') || given.startsWith('\\') || /^[A-Za-z]:/.test(given)) return undefined
  const parts = given.split(/[/\\]/).filter(p => p !== '' && p !== '.')
  if (!parts.length || parts.includes('..')) return undefined
  return parts.join('/')
}

/** Every JSON object the answer holds, the likeliest first: a fenced block, then the text itself. */
function* objectsIn(answer: string): Generator<Record<string, unknown>> {
  const blocks = [...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1])
  for (const text of [...blocks, answer]) {
    const object = parseObject(text)
    if (object) yield object
  }
}

/** The text as a JSON object, or its first `{` to its last `}` (a sentence written around it). */
function parseObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const tries = start >= 0 && end > start ? [text, text.slice(start, end + 1)] : [text]
  for (const candidate of tries) {
    try {
      const raw: unknown = JSON.parse(candidate)
      if (isObject(raw)) return raw
    } catch {
      /* the next candidate, if there is one */
    }
  }
  return undefined
}

/** A note as the preview shows it: one line, short enough to read at a glance. */
function oneLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 300) : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
