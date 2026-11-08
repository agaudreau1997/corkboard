// The project settings' *Suggest from the code repo*: a headless `claude -p` reads the project's
// code repo and answers its colours and an icon as JSON (src/shared/suggest.ts), which the window
// previews. Nothing here writes anything — the answer goes back to the renderer, and the usual
// `projects:setTheme` and `projects:setSettings` write it if you accept it.
//
// It starts `claude` through `CORKBOARD_CLAUDE_BIN` like every other session the app starts, so
// the end-to-end test stands it in, and through the same shell as the terminals, so an nvm
// `claude` is on the PATH. The icon comes back as a path, since `claude -p` writes text: the file
// is read here, and only when it is really inside the code repo and its bytes are an image the
// window can show, then handed over as a data URI for the window to scale down to an icon.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { IMAGE_TYPES, sniffImage } from '@shared/images'
import { MAX_ICON_BYTES, parseSuggestion, suggestPrompt } from '@shared/suggest'
import type { ThemeSuggestion } from '@shared/types'
import { shellRun } from './shell'
import { CLAUDE } from './tackle'

/** Test seam: how long the session gets before the app gives up on it. */
const TIMEOUT_MS = Number(process.env.CORKBOARD_SUGGEST_TIMEOUT_MS ?? 180_000)

/** The answer's text kept in an error message, so a stray answer can be seen but not pasted whole. */
const SHOWN = 400

/**
 * Asks a session in `repo` for the colours and icon of the project named. Throws when there is no
 * answer, when it is in the wrong shape, when `claude` is missing or when it takes too long; an
 * icon that cannot be read leaves the colours standing, with `iconError` saying why.
 */
export async function suggestTheme(repo: string, project: string): Promise<ThemeSuggestion> {
  const answer = await runClaude(repo, suggestPrompt(project))
  const suggestion = parseSuggestion(answer)
  if (!suggestion) {
    const shown = answer.trim().slice(0, SHOWN)
    throw new Error(
      shown
        ? `Claude answered, but not with the colours this asked for:\n\n${shown}`
        : 'Claude answered nothing at all.',
    )
  }
  if (!suggestion.iconPath) return suggestion
  try {
    return { ...suggestion, icon: await readIcon(repo, suggestion.iconPath) }
  } catch (error) {
    return { ...suggestion, iconError: (error as Error).message }
  }
}

/** The session's output, with its argv intact whatever the prompt holds (see `shellRun`). */
function runClaude(cwd: string, prompt: string): Promise<string> {
  const { file, args, env } = shellRun([CLAUDE, '-p', prompt])
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        // A timeout reaches here as a kill, with whatever the session had written so far.
        if ((error as { killed?: boolean }).killed) {
          return reject(new Error(`Claude took longer than ${Math.round(TIMEOUT_MS / 1000)} seconds, so the app stopped waiting.`))
        }
        reject(new Error(stderr.trim().slice(-SHOWN) || error.message))
      },
    )
    // The prompt is in the arguments: nothing is coming on stdin, and the session must not wait for it.
    child.stdin?.end()
  })
}

/**
 * The image a suggestion named, as a data URI: the file has to be inside the code repo (symlinks
 * followed), small enough to keep in memory, and an image by its bytes rather than its name.
 */
export async function readIcon(repo: string, rel: string): Promise<string> {
  const base = await fs.realpath(repo)
  let real: string
  try {
    real = await fs.realpath(path.resolve(base, rel))
  } catch {
    throw new Error(`There is no ${rel} in the code repo.`)
  }
  const inside = path.relative(base, real)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${rel} is outside the code repo.`)
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new Error(`${rel} is not a file.`)
  if (stat.size > MAX_ICON_BYTES) {
    throw new Error(`${rel} is larger than ${Math.round(MAX_ICON_BYTES / (1024 * 1024))} MB.`)
  }
  const bytes = await fs.readFile(real)
  const type = iconType(bytes)
  if (!type) throw new Error(`${rel} is not a PNG, JPEG, GIF, WebP or ICO image.`)
  return `data:${type};base64,${bytes.toString('base64')}`
}

/**
 * The content type of an icon's bytes, when the window can show it. An SVG is refused as it is for
 * a card's images (it can hold scripts); an `.ico` is allowed, which no card image is, because a
 * favicon is one of the likeliest images a repo has.
 */
function iconType(bytes: Uint8Array): string | undefined {
  const kind = sniffImage(bytes)
  if (kind) return IMAGE_TYPES[kind]
  // An ICO: a zero reserved word, type 1, then how many images it holds (never none).
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && (bytes[4] || bytes[5])) {
    return 'image/x-icon'
  }
  return undefined
}
