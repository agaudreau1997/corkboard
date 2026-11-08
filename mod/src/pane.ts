// The pane's rows: what the band above the prompt says about each card the session holds. Pure,
// so the whole layout is a test rather than a screenshot; `hooks/hooks.ts` turns each row into a
// Text element of the surface it draws on.

import type { PaneCard } from './card'

/** A row of the pane. `head` is the card's line, `body` its description, `dim` the rest. */
export type PaneRow = { key: string; text: string; tone: 'head' | 'body' | 'dim' }

export type PaneOpts = {
  /** The width the surface measured, in character cells. */
  columns: number
  /** The rows the band may take. */
  maxRows: number
  /** A work project: the Jira key is what its code repo knows the card by. */
  work: boolean
}

const BODY_ROWS = 2

/**
 * The pane, newest first as the cards were given. A card gets a head row, up to two rows of its
 * description and a dim row of its links, its key and the commits that name it; the rows are cut
 * to `maxRows`, oldest card first, so the card at hand keeps its lines.
 */
export function paneRows(cards: PaneCard[], opts: PaneOpts): PaneRow[] {
  const width = Math.max(20, opts.columns - 2)
  const rows: PaneRow[] = []
  for (const card of cards) {
    rows.push({ key: `${card.id}-head`, text: clip(headline(card, opts.work), width), tone: 'head' })
    for (const [i, line] of bodyLines(card.description, width).entries()) {
      rows.push({ key: `${card.id}-body-${i}`, text: line, tone: 'body' })
    }
    const notes = noteLine(card, opts.work)
    if (notes) rows.push({ key: `${card.id}-notes`, text: clip(notes, width), tone: 'dim' })
  }
  return rows.slice(Math.max(0, rows.length - Math.max(1, opts.maxRows)))
}

/** `▣ CORK-101 · Doing · Companion mod: a card pane`. */
export function headline(card: PaneCard, work: boolean): string {
  const name = work && card.jira ? `${card.id} (${card.jira})` : card.id
  return ['▣', name, card.listTitle, card.title].filter(Boolean).join(' · ').replace('▣ ·', '▣')
}

/** The first rows of the description, folded to the width, whitespace collapsed. */
export function bodyLines(description: string, width: number, rows = BODY_ROWS): string[] {
  const text = description
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return []
  const lines: string[] = []
  let rest = text
  while (rest && lines.length < rows) {
    if (rest.length <= width) {
      lines.push(rest)
      break
    }
    const cut = rest.lastIndexOf(' ', width)
    const at = cut > width / 2 ? cut : width
    lines.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  // There was more than the rows allow: the last one ends in an ellipsis rather than mid-sentence.
  if (rest && lines.length) {
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = last.length < width ? `${last}…` : clip(`${last} `, width)
  }
  return lines
}

/** The dim row: where the card was read, its links, and the commits that name it. */
export function noteLine(card: PaneCard, work: boolean): string {
  const parts: string[] = []
  if (card.from === 'file') parts.push('from the card file (Corkboard is closed)')
  if (card.links.length) parts.push(`links ${card.links.join(' ')}`)
  if (work && card.jira) parts.push(card.jira)
  for (const commit of card.commits) parts.push(`${commit.sha} ${commit.subject}`)
  return parts.join(' · ')
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}
