// The prompts the tackle buttons hand to Claude Code. Pure, so the tests can read them.

import type { BoardMeta, Card } from './types'

export type PromptContext = {
  meta: BoardMeta
  boardRoot: string
  /** Absolute path of each card's file, by id. */
  cardFile: (id: string) => string
  /** Title of a linked card anywhere in the repo, when it exists. */
  linkTitle: (id: string) => string | undefined
  cloud: boolean
  listTitle?: string
}

export function sessionName(cards: Card[], listTitle?: string): string {
  if (cards.length === 1) return `${cards[0].id} ${truncate(cards[0].title, 48)}`
  return listTitle ? `${listTitle} (${cards.length} cards)` : `${cards.map(c => c.id).join(' ')}`
}

export function tacklePrompt(cards: Card[], ctx: PromptContext): string {
  const one = cards.length === 1
  const doneList = ctx.meta.flow?.done
    ? ctx.meta.lists.find(l => l.id === ctx.meta.flow?.done)
    : undefined
  const parts: string[] = []

  if (one) {
    const card = cards[0]
    parts.push(`Tackle card ${card.id} from the task board: ${card.title}`)
    const body = card.body.trim()
    if (body) parts.push(body)
    const links = linkLines(card, ctx)
    if (links) parts.push(`Related cards:\n${links}`)
  } else {
    const where = ctx.listTitle ? ` from the "${ctx.listTitle}" list` : ''
    parts.push(`Tackle these ${cards.length} cards${where} of the task board, in this order:`)
    parts.push(
      cards
        .map((card, i) => {
          const lines = [`${i + 1}. ${card.id}: ${card.title}`]
          if (!ctx.cloud) lines.push(`   File: ${ctx.cardFile(card.id)}`)
          const body = card.body.trim()
          if (body) lines.push(indent(body, '   '))
          const links = linkLines(card, ctx)
          if (links) lines.push(`   Related cards:\n${indent(links, '   ')}`)
          return lines.join('\n')
        })
        .join('\n\n'),
    )
  }

  const rules: string[] = []
  if (!ctx.cloud) {
    parts.push(
      one
        ? `The card is ${ctx.cardFile(cards[0].id)} in the board repo ${ctx.boardRoot} (its CLAUDE.md describes the card format).`
        : `The cards are Markdown files in the board repo ${ctx.boardRoot} (its CLAUDE.md describes the card format).`,
    )
  }
  if (!one) rules.push('Work through them one at a time.')
  rules.push(
    one
      ? `Put a \`Card: ${cards[0].id}\` trailer on every commit you make for this card.`
      : 'Put a `Card: <ID>` trailer on every commit, naming the card the commit is for.',
  )
  if (!ctx.cloud && doneList) {
    rules.push(
      one
        ? `When the work is done and verified, move the card to "${doneList.title}": set \`list: ${doneList.id}\` in its front matter.`
        : `As each card is done and verified, move it to "${doneList.title}" (\`list: ${doneList.id}\` in its front matter) before starting the next, so the board shows progress.`,
    )
  }
  if (!ctx.cloud) rules.push("Don't commit in the board repo; the board app commits it.")
  parts.push(rules.map(r => `- ${r}`).join('\n'))

  const notes = ctx.meta.promptNotes?.trim()
  if (notes) parts.push(notes)
  return parts.join('\n\n')
}

function linkLines(card: Card, ctx: PromptContext): string {
  return card.links
    .map(id => {
      const title = ctx.linkTitle(id)
      return title ? `- ${id}: ${title}` : `- ${id}`
    })
    .join('\n')
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map(line => (line ? pad + line : line))
    .join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
