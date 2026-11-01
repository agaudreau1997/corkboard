// The badges along the bottom of a card's face, after its id: which ones a card gets, in what
// order, with what text and tooltip. The desktop's kanban and the Android companion both draw
// their faces from this, so a board reads the same on either and the two can't drift apart. Each
// side only renders the list (as spans with `badge` and the tone as classes); what goes in it is
// decided here.
//
// Commits naming a card are known only where the code repo is (the desktop): the caller passes
// their count, and a caller without one (the phone) leaves the badge out.

import { dueDay, isOverdue } from './due'
import { unmetPrerequisites } from './tackleorder'
import type { BoardMeta, Card } from './types'

/** What a badge is about; also the colour it is drawn in, where it has one. */
export type BadgeTone = 'ok' | 'waits' | 'commit' | 'session' | 'discuss' | 'overdue'

export type CardBadge = {
  /** Stable per card, for React's key. */
  key: string
  glyph: string
  /** A count, or the due day, after the glyph. */
  value?: string
  /** The tooltip, or the accessible label where there are no tooltips. */
  title: string
  tone?: BadgeTone
}

/**
 * A card's badges, in the face's order: complete, has a description, links, waits on, commits,
 * sessions, discussions, due. Sessions, discussions and waits are left out once the card is done
 * (complete, or in the board's done list): the drawer keeps them.
 */
export function cardBadges(
  card: Card,
  board: { cards: Card[]; meta: Pick<BoardMeta, 'flow'> },
  opts: { commits?: number; now?: Date } = {},
): CardBadge[] {
  const done = board.meta.flow?.done
  const finished = card.complete || (!!done && card.list === done)
  const running = finished ? 0 : card.sessions.filter(s => !s.purpose).length
  const talks = finished ? 0 : card.sessions.filter(s => s.purpose === 'discuss').length
  const waitsOn = finished ? [] : (unmetPrerequisites([card], board.cards, done)[0]?.needs ?? [])
  const badges: CardBadge[] = []
  if (card.complete) badges.push({ key: 'complete', glyph: '✓', title: 'Marked complete', tone: 'ok' })
  if (card.body.trim()) badges.push({ key: 'body', glyph: '≡', title: 'Has a description' })
  if (card.links.length > 0) {
    badges.push({ key: 'links', glyph: '⛓', value: String(card.links.length), title: 'Linked cards' })
  }
  if (waitsOn.length > 0) {
    badges.push({
      key: 'waits',
      glyph: '⧗',
      value: String(waitsOn.length),
      title: `Waits on ${waitsOn.join(', ')}, not done yet`,
      tone: 'waits',
    })
  }
  if (opts.commits) {
    badges.push({ key: 'commits', glyph: '⎇', value: String(opts.commits), title: 'Commits naming this card', tone: 'commit' })
  }
  if (running > 0) {
    badges.push({ key: 'sessions', glyph: '▶', value: String(running), title: 'Claude sessions started for it', tone: 'session' })
  }
  if (talks > 0) {
    badges.push({ key: 'discussions', glyph: '✎', value: String(talks), title: 'Discussions about it', tone: 'discuss' })
  }
  if (card.due) {
    const late = isOverdue(card.due, finished, opts.now)
    badges.push({
      key: 'due',
      glyph: '⏰',
      value: dueDay(card.due),
      title: late ? 'Past due' : 'Due',
      tone: late ? 'overdue' : undefined,
    })
  }
  return badges
}

/** A badge's text: the glyph, then its value after a space. */
export function badgeText(badge: CardBadge): string {
  return badge.value === undefined ? badge.glyph : `${badge.glyph} ${badge.value}`
}

/**
 * A badge's text as the children of its span: the glyph and its space, then the value, as two text
 * nodes. One node of the same text lays the glyph (from a fallback font) a fraction of a pixel
 * elsewhere than the desktop always has.
 */
export function badgeChildren(badge: CardBadge): string[] {
  return badge.value === undefined ? [badge.glyph] : [`${badge.glyph} `, badge.value]
}

/** The class a badge's span takes, the same in both apps' stylesheets. */
export function badgeClass(badge: CardBadge): string {
  return badge.tone ? `badge ${badge.tone}` : 'badge'
}
