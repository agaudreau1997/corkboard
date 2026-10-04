// The prompts the tackle and discuss buttons hand to Claude Code. Pure, so the tests can read them.

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

export type Purpose = 'tackle' | 'discuss'

export function sessionName(cards: Card[], listTitle?: string, purpose: Purpose = 'tackle'): string {
  const name =
    cards.length === 1
      ? `${cards[0].id} ${truncate(cards[0].title, 48)}`
      : listTitle
        ? `${listTitle} (${cards.length} cards)`
        : `${cards.map(c => c.id).join(' ')}`
  if (purpose === 'tackle') return name
  return cards.length > 1 ? `Triage ${name}` : `Discuss ${name}`
}

/**
 * A conversation about cards, before any work on them: understand, question, scope, triage.
 * Nothing in the code repo changes unless the person asks for it; the cards themselves may be
 * edited once the person agrees, which is how a discussion leaves a card ready to tackle.
 */
export function discussPrompt(cards: Card[], ctx: PromptContext): string {
  const one = cards.length === 1
  const parts: string[] = []
  if (one) {
    const card = cards[0]
    parts.push(`Let's discuss card ${card.id} from the task board: ${card.title}`)
    const body = card.body.trim()
    if (body) parts.push(body)
    const links = linkLines(card, ctx)
    if (links) parts.push(`Related cards:\n${links}`)
    parts.push(`The card is ${ctx.cardFile(card.id)} in the board repo ${ctx.boardRoot} (its CLAUDE.md describes the card format).`)
  } else {
    const where = ctx.listTitle ? ` in the "${ctx.listTitle}" list` : ''
    parts.push(`Let's triage these ${cards.length} cards${where} of the task board:`)
    parts.push(
      cards
        .map((card, i) => {
          const lines = [`${i + 1}. ${card.id}: ${card.title}`, `   File: ${ctx.cardFile(card.id)}`]
          const body = card.body.trim()
          if (body) lines.push(indent(body, '   '))
          return lines.join('\n')
        })
        .join('\n\n'),
    )
    parts.push(`The cards are Markdown files in the board repo ${ctx.boardRoot} (its CLAUDE.md describes the card format).`)
  }

  const rules = [
    'This is a discussion, not a tackle. Do not implement anything: no code changes, no new files, no commits in the code repo, unless I explicitly ask you to in this conversation.',
    'Read whatever helps you understand (the cards, related cards, the code, its history) and tell me what you find.',
    one
      ? 'Help me think it through: what is unclear or missing, the risks, the options and how you would scope or split it.'
      : 'Go through them with me: for each, whether it is still relevant, whether it is clear enough to tackle, what is missing, and whether it should be split, merged, moved to another list or archived. Propose; I decide.',
    'When we agree on something, write it into the card file (description, title, links, list, or `archived: true`) and set `updated:` (now, ISO UTC): those card files are the only files you may edit without asking. Do not commit in the board repo; the board app commits it.',
  ]
  parts.push(rules.map(r => `- ${r}`).join('\n'))
  return parts.join('\n\n')
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
        ? `When the work is done and verified, move the card to "${doneList.title}": set \`list: ${doneList.id}\` and \`updated:\` (now, ISO UTC) in its front matter.`
        : `As each card is done and verified, move it to "${doneList.title}" (\`list: ${doneList.id}\` and \`updated:\` now, in its front matter) before starting the next, so the board shows progress.`,
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
