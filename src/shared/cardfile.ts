// A card file is YAML front matter between `---` fences, then the Markdown body.
// Serialising writes the known keys in a fixed order and drops empty ones, so a move is a
// one-line diff and a hand edit by a person or a Claude session round-trips unchanged.

import YAML from 'yaml'
import type { BoardMeta, Card, ListDef, ListSort, SessionRef } from './types'

const KNOWN = [
  'id',
  'title',
  'list',
  'pos',
  'created',
  'updated',
  'due',
  'complete',
  'archived',
  'labels',
  'links',
  'trello',
  'sessions',
] as const

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseCard(text: string, fallbackId = ''): Card {
  const match = FENCE.exec(text)
  const front: Record<string, unknown> = match ? (YAML.parse(match[1]) ?? {}) : {}
  const body = match ? text.slice(match[0].length) : text
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(front)) {
    if (!(KNOWN as readonly string[]).includes(key)) extra[key] = value
  }
  const list = front.list
  return {
    id: String(front.id ?? fallbackId),
    title: String(front.title ?? ''),
    list: list === null || list === undefined || list === '' ? null : String(list),
    pos: typeof front.pos === 'number' ? front.pos : Number(front.pos ?? 0) || 0,
    created: asString(front.created),
    updated: asString(front.updated),
    due: asString(front.due),
    complete: front.complete === true ? true : undefined,
    archived: front.archived === true ? true : undefined,
    labels: asStringArray(front.labels),
    links: asStringArray(front.links),
    trello: asString(front.trello),
    sessions: Array.isArray(front.sessions) ? (front.sessions as SessionRef[]) : [],
    body: body.replace(/^\r?\n/, '').replace(/\s+$/, ''),
    extra,
  }
}

/** parseCard, or undefined for front matter that does not parse (a file saved half-way by hand). */
export function tryParseCard(text: string, fallbackId = ''): Card | undefined {
  try {
    return parseCard(text, fallbackId)
  } catch {
    return undefined
  }
}

export function serializeCard(card: Card): string {
  const front: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    list: card.list,
    pos: card.pos,
  }
  if (card.created) front.created = card.created
  if (card.updated) front.updated = card.updated
  if (card.due) front.due = card.due
  if (card.complete) front.complete = true
  if (card.archived) front.archived = true
  if (card.labels.length) front.labels = card.labels
  if (card.links.length) front.links = card.links
  if (card.trello) front.trello = card.trello
  if (card.sessions.length) front.sessions = card.sessions
  for (const [key, value] of Object.entries(card.extra)) front[key] = value
  const yaml = YAML.stringify(front, { lineWidth: 0, flowCollectionPadding: false })
  const body = card.body.trim() ? `\n${card.body.replace(/\s+$/, '')}\n` : ''
  return `---\n${yaml}---\n${body}`
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return value instanceof Date ? value.toISOString() : String(value)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(v => v !== null && v !== undefined).map(String)
}

/** `RS-886` -> 886; NaN for an id with no number. */
export function cardNumber(id: string): number {
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : NaN
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'list'
  )
}

/** A position between two neighbours (either may be missing), Trello style. */
export function between(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1024
  if (before === undefined) return (after as number) / 2
  if (after === undefined) return before + 1024
  return (before + after) / 2
}

export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.pos - b.pos || cardNumber(a.id) - cardNumber(b.id))
}

/** The orders a list can keep, as its menu offers them. */
export const LIST_SORTS: { id: ListSort; label: string; compare?: (a: Card, b: Card) => number }[] = [
  { id: 'updated', label: 'Last updated', compare: (a, b) => touched(b).localeCompare(touched(a)) },
  { id: 'newest', label: 'Newest first', compare: (a, b) => (b.created ?? '').localeCompare(a.created ?? '') },
  { id: 'oldest', label: 'Oldest first', compare: (a, b) => (a.created ?? '').localeCompare(b.created ?? '') },
  { id: 'number', label: 'Card number', compare: (a, b) => cardNumber(a.id) - cardNumber(b.id) },
  { id: 'title', label: 'Title A–Z', compare: (a, b) => a.title.localeCompare(b.title) },
  { id: 'manual', label: 'Manual', compare: undefined },
]

/** When a card last changed: a new card, or one written by hand, may carry only `created`. */
function touched(card: Card): string {
  return card.updated ?? card.created ?? ''
}

/**
 * The sort a list keeps. Unset, the board's done list shows what was finished last first, and
 * every other list keeps the order its cards are dragged into: there the order is the plan.
 */
export function listSort(meta: Pick<BoardMeta, 'flow'>, list: Pick<ListDef, 'id' | 'sort'> | undefined): ListSort {
  if (list?.sort) return list.sort
  return list && list.id === meta.flow?.done ? 'updated' : 'manual'
}

/**
 * A list's cards in the order it shows them. The order is worked out each time rather than
 * written into `pos`, so a card that lands or changes takes its place without a write, and
 * `pos` keeps the manual order for when the list goes back to it. Dividers stay where `pos`
 * puts them and the cards between two dividers are sorted among themselves; ties keep `pos` order.
 */
export function orderList(cards: Card[], sort: ListSort): Card[] {
  const byPos = sortCards(cards)
  const compare = LIST_SORTS.find(s => s.id === sort)?.compare
  if (!compare) return byPos
  const out: Card[] = []
  let run: Card[] = []
  for (const card of byPos) {
    if (!isDivider(card)) {
      run.push(card)
      continue
    }
    out.push(...run.sort(compare), card)
    run = []
  }
  out.push(...run.sort(compare))
  return out
}

/** A card titled with a run of dashes is a divider inside its list, not work. */
export function isDivider(card: Pick<Card, 'title'>): boolean {
  return /^\s*-{3,}\s*$/.test(card.title)
}

/** The list colours, for strips and map nodes. */
export const LIST_COLORS = ['#5b8def', '#e0a93b', '#4cb782', '#d9645b', '#a77bdb', '#3fb5c4', '#d77fb1', '#8f9bb3']

/** A list's colour: its own, else the one of its place. */
export function listColorAt(lists: ListDef[], index: number): string {
  return lists[index]?.color ?? LIST_COLORS[index % LIST_COLORS.length]
}

/** Every list gets the colour it shows now written down, so moving lists never repaints them. */
export function freezeListColors(lists: ListDef[]): ListDef[] {
  return lists.map((l, i) => (l.color ? l : { ...l, color: listColorAt(lists, i) }))
}

/**
 * Moves list `from` to where list `to` stands, among the visible lists. Archived lists keep their
 * places: the visible ones are reordered within the slots they occupy. Colours are frozen first,
 * so each list keeps its own. null when nothing moves.
 */
export function reorderLists(original: ListDef[], from: string, to: string): ListDef[] | null {
  const lists = freezeListColors(original)
  const visible = lists.filter(l => !l.archived)
  const a = visible.findIndex(l => l.id === from)
  const b = visible.findIndex(l => l.id === to)
  if (a < 0 || b < 0 || a === b) return null
  const moved = [...visible]
  moved.splice(b, 0, ...moved.splice(a, 1))
  const slots = lists.flatMap((l, i) => (l.archived ? [] : [i]))
  const out = [...lists]
  moved.forEach((list, k) => (out[slots[k]] = list))
  return out
}
