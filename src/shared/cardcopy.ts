// What a card is copied or shared as: the desktop's Copy menu and the companion's share sheet both
// build their text here, so the two never disagree. A work project's code repo, PRs and messages
// never see a card id (see docs/work-mode.md), so in work mode the text that may be pasted there
// names the card's Jira key, or the title alone, in place of the id. The identifier itself is still
// offered: copying it is asking for the id, for Corkboard's own use.

import type { Card } from './types'

type CardText = Pick<Card, 'id' | 'title' | 'jira'>

export type CopyItem = {
  kind: 'id' | 'title' | 'trailer' | 'jira' | 'markdown'
  label: string
  /** What the menu shows beside the label. */
  hint?: string
  text: string
  /** How the confirmation names what was copied; unset, the text itself. */
  what?: string
}

/** The card as one line of Markdown: `[CORK-12] Title`, or `[SPDI-42] Title` / the title in work mode. */
export function cardMarkdown(card: CardText, work: boolean): string {
  if (!work) return `[${card.id}] ${card.title}`
  return card.jira ? `[${card.jira}] ${card.title}` : card.title
}

/** The Copy menu's items, in its order: the trailer is the Jira key's place in work mode. */
export function cardCopies(card: CardText, work: boolean): CopyItem[] {
  return [
    { kind: 'id', label: 'Identifier', hint: card.id, text: card.id },
    { kind: 'title', label: 'Title', text: card.title, what: 'the title' },
    ...(work
      ? card.jira
        ? [{ kind: 'jira' as const, label: 'Jira key', hint: card.jira, text: card.jira, what: 'the Jira key' }]
        : []
      : [{ kind: 'trailer' as const, label: 'Commit trailer', hint: `Card: ${card.id}`, text: `Card: ${card.id}` }]),
    {
      kind: 'markdown',
      label: 'Markdown',
      hint: work ? (card.jira ? `[${card.jira}] …` : 'the title') : `[${card.id}] …`,
      text: cardMarkdown(card, work),
      what: 'as Markdown',
    },
  ]
}

/**
 * The card for a share sheet: its title and description as plain text, or as Markdown headed by
 * the Copy menu's Markdown line (the id, or in work mode the Jira key).
 */
export function cardShareText(card: CardText & Pick<Card, 'body'>, work: boolean, markdown: boolean): string {
  const head = markdown ? cardMarkdown(card, work) : card.title
  const body = card.body.trim()
  return body ? `${head}\n\n${body}\n` : `${head}\n`
}
