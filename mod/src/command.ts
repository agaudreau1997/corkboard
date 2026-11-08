// The `/card` command, read apart from the engine: which of the four things it asks for, and the
// line that answers it.
//
// Claude Code namespaces a plugin's commands, so the command is `/corkboard-mod:card`; it is
// written down in `mod/commands/card.md`, which is what makes the terminal offer it at all — an
// unknown slash command never reaches a hook. The hook then answers it and drops the prompt, so
// no turn is spent: the person ran the command, not Claude.

import type { PaneCard } from './card'
import { headline } from './pane'

export type CardCommand =
  /** Show the session's cards, as the pane does. */
  | { kind: 'show' }
  /** Move every card of the session to the board's done list. */
  | { kind: 'done' }
  /** Append a line to the description of every card of the session. */
  | { kind: 'note'; text: string }
  /** Make a card on the session's board. */
  | { kind: 'new'; title: string; list?: string }
  /** Something else was asked for; the answer says what the command takes. */
  | { kind: 'unknown'; said: string }

/** What the command takes, for its answer and for `commands/card.md`'s hint. */
export const CARD_USAGE = 'card · card done · card note <text> · card new <title> [--list <id>]'

/**
 * The command a submitted prompt is, or undefined when the prompt is an ordinary one and the hook
 * must leave it alone. Both `/<plugin>:card …` (what the terminal sends when the command is run)
 * and a bare `/card …` are taken, so the mod keeps working if a Claude Code release stops
 * namespacing a plugin's commands.
 */
export function parseCardCommand(prompt: unknown): CardCommand | undefined {
  if (typeof prompt !== 'string') return undefined
  const asked = /^\/(?:[A-Za-z0-9_-]+:)?card\b(.*)$/s.exec(prompt.trim())
  if (!asked) return undefined
  const args = asked[1].trim()
  if (!args) return { kind: 'show' }
  const [word, ...rest] = args.split(/\s+/)
  const tail = args.slice(word.length).trim()
  if (word === 'done') return { kind: 'done' }
  if (word === 'note') return tail ? { kind: 'note', text: tail } : { kind: 'unknown', said: 'card note takes a line of text.' }
  if (word === 'new') {
    const { title, list } = withoutList(tail)
    return title ? { kind: 'new', title, list } : { kind: 'unknown', said: 'card new takes a title.' }
  }
  void rest
  return { kind: 'unknown', said: `card does not know "${word}".` }
}

/** `<title> --list <id>`, in either order, as a title and a list. */
function withoutList(args: string): { title: string; list?: string } {
  const flagged = /(?:^|\s)--list[\s=]+([^\s]+)/.exec(args)
  if (!flagged) return { title: args.trim() }
  return { title: args.replace(flagged[0], ' ').replace(/\s+/g, ' ').trim(), list: flagged[1] }
}

/**
 * The session's cards as `/card` answers them: one line, because the terminal shows a dropped
 * prompt's reason as one line (a newline of its own comes out as a glyph). The descriptions, the
 * links and the commits are in the pane above the prompt, which the command draws again.
 */
export function showCards(cards: PaneCard[], work: boolean): string {
  if (!cards.length) return 'corkboard: this session holds no cards.'
  return `corkboard: ${cards.map(card => headline(card, work).replace(/^▣ /, '')).join(' | ')}`
}

/** What a command that writes says when there is no app to write through. */
export const NO_APP = 'corkboard: Corkboard is closed, so nothing was written. The board tools are what change a card.'
