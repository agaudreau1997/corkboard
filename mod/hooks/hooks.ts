// Corkboard's companion mod: the hooks module Claude Code loads for the sessions the app starts
// (`--plugin-dir`, from `src/main/tackle.ts`). It works out which cards its session was started
// for and draws them in the band above the prompt, with buttons to finish a card and to bring it
// up in the window.
//
// Every hook is written to fail safe. The plugin API is early access and moves between Claude
// Code releases, so a call that isn't there, a shell that won't run and a board the app no longer
// serves all end the same way: the hook calls `next` and the session goes on exactly as it would
// without the mod. The drawing itself only ever reads what the timer has already fetched: a
// render has a budget, and a call that overran it was dropped mid-dispatch.

import { BOARD_SERVER, cardFile, cardFromFile, cardFromTool, fileCommands, type PaneCard, toolJson } from '../src/card'
import { commitArgv, commitsNaming, parseCommits } from '../src/commits'
import type { On } from '../src/engine'
import { paneRows } from '../src/pane'
import { describeSession, envCommands, parseEnv, type SessionCards, sessionFromEnv } from '../src/session'

/** How often the cards are read again: the app may have moved or changed one meanwhile. */
const REFRESH_MS = 8000
/** The board tools are not connected yet when session.start runs; the first read waits for them. */
const FIRST_MS = 2000

/** What this session holds, once session.start has read its environment. */
let held: SessionCards | undefined
/** The cards as the pane last drew them. */
let shown: PaneCard[] = []

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    try {
      for (const argv of envCommands()) {
        const run = await $.process.run(argv).catch(() => undefined)
        if (!run || run.exitCode !== 0) continue
        held = sessionFromEnv(parseEnv(run.stdout))
        break
      }
      const session = held
      if (!session) {
        await $.ui.log('corkboard: no shell answered, so this session knows no cards')
        return next(e)
      }
      await $.ui.log(`corkboard: ${describeSession(session)}`)
      if (!session.cards.length) return next(e)
      await $.ui.status(`▣ ${session.cards.join(' ')}`)

      // Read the cards and keep reading them. The board tools answer while the app runs; with it
      // closed the card files still do, and the pane says which it is showing.
      const refresh = async () => {
        const repo = await $.session.cwd().catch(() => '')
        const cards: PaneCard[] = []
        for (const id of session.cards) {
          const answered = await $.mcp.call(BOARD_SERVER, 'get_card', { id, board: session.board || undefined }).catch(() => undefined)
          const json = toolJson(answered)
          let card: PaneCard | undefined
          if (json) card = cardFromTool(json)
          else if (session.boardDir) {
            // The app is closed, so the card file is the only copy left. $.fs reads inside the
            // project only, which a session running in the code repo is not: it is tried first
            // for the board a session does run in, then a host command prints the file.
            const file = cardFile(session.boardDir, id)
            let text = await $.fs.readFile(file).catch(() => undefined)
            for (const argv of fileCommands(file)) {
              if (text) break
              const printed = await $.process.run(argv).catch(() => undefined)
              if (printed?.exitCode === 0 && printed.stdout.includes('---')) text = printed.stdout
            }
            if (text) card = cardFromFile(text, id)
          }
          if (!card) continue
          const needle = session.work ? card.jira : card.id
          if (needle && repo) {
            const log = await $.process.run(commitArgv(repo, needle, session.work)).catch(() => undefined)
            if (log?.exitCode === 0) card.commits = commitsNaming(parseCommits(log.stdout), needle, session.work).slice(0, 2)
          }
          cards.push(card)
        }
        if (JSON.stringify(cards) === JSON.stringify(shown)) return
        shown = cards
        // The band is drawn again with what was just read; a quiet session redraws nothing of
        // its own, so without this the pane would only appear at the next turn.
        $.ui.invalidate('ui.render')
      }

      await $.clock.after(FIRST_MS, refresh)
      await $.clock.every(REFRESH_MS, refresh)
    } catch {
      // A mod that cannot tell its cards leaves the session as it is.
    }
    return next(e)
  })

  // The band above the prompt: the cards, and what can be done to them from here. The engine's
  // own band is kept below the pane, so nothing it draws is lost.
  on('ui.render', async ($, e, next) => {
    const session = held
    if (e.component !== 'AbovePrompt' || !shown.length || !session) return next(e)
    // The chain runs once, whatever happens next: its result is the engine's own band, which the
    // pane keeps below itself, and what the pane falls back to when anything here goes wrong.
    const below = await next(e)
    try {
      const el = await $.ui.resolve(e)
      const maxRows = Number(e.props?.maxRows ?? 8)
      const rows = paneRows(shown, {
        columns: e.viewport?.columns ?? 80,
        maxRows: Math.max(1, Math.min(shown.length * 4, maxRows - 2)),
        work: session.work,
      })
      const lines = rows.map(row =>
        h(
          el.Text,
          row.tone === 'head'
            ? { key: row.key, color: 'cyan', bold: true }
            : row.tone === 'dim'
              ? { key: row.key, dimColor: true }
              : { key: row.key },
          row.text,
        ),
      )
      // With the app closed the pane is a read-only one: the tools are what move a card, and the
      // mod never edits a card file behind the app's back.
      const live = shown.every(card => card.from === 'app')
      const buttons = live
        ? h(
            el.Box,
            { flexDirection: 'row', gap: 1 },
            h(el.Button, {
              key: 'done',
              label: shown.length > 1 ? `Move ${shown.length} cards to Done` : 'Move to Done',
              onPress: async () => {
                const moved: string[] = []
                for (const card of shown) {
                  const move = { id: card.id, board: session.board || undefined, flow: 'done' }
                  const answer = await $.mcp.call(BOARD_SERVER, 'move_card', move).catch(() => undefined)
                  if (toolJson(answer)) moved.push(card.id)
                }
                await $.ui.toast(moved.length ? `Moved ${moved.join(', ')} to Done` : 'Corkboard did not take the move')
              },
            }),
            h(el.Button, {
              key: 'open',
              label: 'Open in Corkboard',
              onPress: async () => {
                const card = shown[0]
                const answer = await $.mcp.call(BOARD_SERVER, 'show_card', { id: card.id, board: session.board || undefined }).catch(() => undefined)
                if (!toolJson(answer)) await $.ui.toast('Corkboard has no window open for that card')
              },
            }),
          )
        : undefined
      return h(el.Box, { flexDirection: 'column', paddingLeft: 1 }, ...lines, buttons, below)
    } catch {
      return below
    }
  })
}
