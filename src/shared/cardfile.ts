// A card file is YAML front matter between `---` fences, then the Markdown body.
// Serialising writes the known keys in a fixed order and drops empty ones, so a move is a
// one-line diff and a hand edit by a person or a Claude session round-trips unchanged.

import YAML from 'yaml'
import type { Card, SessionRef } from './types'

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

/** A card titled with a run of dashes is a divider inside its list, not work. */
export function isDivider(card: Pick<Card, 'title'>): boolean {
  return /^\s*-{3,}\s*$/.test(card.title)
}
