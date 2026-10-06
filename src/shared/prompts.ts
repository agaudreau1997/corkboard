// The prompts the tackle and discuss buttons hand to Claude Code. Pure, so the tests can read them.
//
// A work project's prompts (`work` in the context) keep the board's card ids out of the code
// repo: its repos are shared with people who never see the board, and Jira tracks the work, so
// the card's Jira key is the identifier a session names in commits, branches and PRs. Telling
// the session which trailer to write is not enough (sessions have named branches and PRs after
// cards on their own), so the rule forbids every card id of the board anywhere in the code repo,
// and the prompt itself names an id only where the session needs one: the card's file path, to
// move it when done, and its related cards' ids, which are ids of the same board. A cloud prompt
// has neither, and so carries no card id at all.

import type { BoardMeta, Card } from './types'

export type PromptContext = {
  meta: BoardMeta
  boardRoot: string
  /** Absolute path of each card's file, by id. */
  cardFile: (id: string) => string
  /** Title of a linked card anywhere in the repo, when it exists. */
  linkTitle: (id: string) => string | undefined
  /** Jira key of a linked card, when it has one. */
  linkKey?: (id: string) => string | undefined
  cloud: boolean
  /** Whether the board repo has its CLAUDE.md, which the prompt then points to. */
  guide?: boolean
  /** The project is in work mode: no card id goes into the code repo, the Jira key is named instead. */
  work?: boolean
  listTitle?: string
  /** Title of the board, when the cards are a whole board. */
  boardTitle?: string
  /**
   * The folder a session the Claude desktop app starts should be in: the app can start it with no
   * folder or in the last folder it used instead, so the prompt asks the session to check before
   * anything else, and to move there.
   */
  workDir?: string
}

export type Purpose = 'tackle' | 'discuss'

export function sessionName(cards: Card[], groupTitle?: string, purpose: Purpose = 'tackle'): string {
  const name =
    cards.length === 1
      ? `${cards[0].id} ${truncate(cards[0].title, 48)}`
      : groupTitle
        ? `${groupTitle} (${cards.length} cards)`
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
    parts.push(`Let's discuss ${cardName(card, ctx)} from the task board: ${card.title}`)
    const body = card.body.trim()
    if (body) parts.push(body)
    const links = linkLines(card, ctx)
    if (links) parts.push(`Related cards:\n${links}`)
    parts.push(`The card is ${ctx.cardFile(card.id)} in the board repo ${ctx.boardRoot}${guideNote(ctx)}.`)
  } else {
    if (ctx.boardTitle && !ctx.listTitle) {
      parts.push(`Let's triage the whole "${ctx.boardTitle}" board of the task board, its ${cards.length} cards:`)
    } else {
      const where = ctx.listTitle ? ` in the "${ctx.listTitle}" list` : ''
      parts.push(`Let's triage these ${cards.length} cards${where} of the task board:`)
    }
    parts.push(
      cards
        .map((card, i) => {
          const lines = [`${i + 1}. ${cardHeading(card, ctx)}`]
          // Across a whole board, where each card sits is part of the triage.
          if (ctx.boardTitle && !ctx.listTitle) lines.push(`   List: ${listName(card, ctx.meta)}`)
          lines.push(`   File: ${ctx.cardFile(card.id)}`)
          const body = card.body.trim()
          if (body) lines.push(indent(body, '   '))
          return lines.join('\n')
        })
        .join('\n\n'),
    )
    parts.push(`The cards are Markdown files in the board repo ${ctx.boardRoot}${guideNote(ctx)}.`)
  }
  if (ctx.workDir) parts.push(folderCheck(ctx.workDir))

  const rules = [
    'This is a discussion, not a tackle. Do not implement anything: no code changes, no new files, no commits in the code repo, unless I explicitly ask you to in this conversation.',
    'Read whatever helps you understand (the cards, related cards, the code, its history) and tell me what you find.',
    one
      ? 'Help me think it through: what is unclear or missing, the risks, the options and how you would scope or split it.'
      : 'Go through them with me: for each, whether it is still relevant, whether it is clear enough to tackle, what is missing, and whether it should be split, merged, moved to another list or archived. Propose; I decide.',
    'When we agree on something, write it into the card file (description, title, links, list, or `archived: true`) and set `updated:` (now, ISO UTC): those card files are the only files you may edit without asking. Do not commit in the board repo; the board app commits it.',
  ]
  if (ctx.work) rules.push(`If I do ask you to implement something: ${workRule(cards, ctx)}`)
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
    parts.push(`Tackle ${cardName(card, ctx)} from the task board: ${card.title}`)
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
          const lines = [`${i + 1}. ${cardHeading(card, ctx)}`]
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
        ? `The card is ${ctx.cardFile(cards[0].id)} in the board repo ${ctx.boardRoot}${guideNote(ctx)}.`
        : `The cards are Markdown files in the board repo ${ctx.boardRoot}${guideNote(ctx)}.`,
    )
  }
  if (ctx.workDir) parts.push(folderCheck(ctx.workDir))
  if (!one) rules.push('Work through them one at a time.')
  if (ctx.work) {
    rules.push(workRule(cards, ctx))
  } else {
    rules.push(
      one
        ? `Put a \`Card: ${cards[0].id}\` trailer on every commit you make for this card.`
        : 'Put a `Card: <ID>` trailer on every commit, naming the card the commit is for.',
    )
  }
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

/**
 * The work-mode rule: the Jira key goes where the card id would have, and no card id of the
 * board goes anywhere near the code repo. The board repo's CLAUDE.md asks for `Card:` trailers
 * (it is never rewritten once there), so the rule says it wins over that. Without a key, the
 * session asks for one first; a local session then keeps it on the card, for the next session
 * and for the board, which shows the commits that name it.
 */
function workRule(cards: Card[], ctx: PromptContext): string {
  const one = cards.length === 1
  const key = one ? cards[0].jira : undefined
  const keep = ctx.cloud
    ? ''
    : one
      ? ' and write it into the card\'s front matter as `jira: <KEY>` (with `updated:`)'
      : " and write it into that card's front matter as `jira: <KEY>` (with `updated:`)"
  const name = one
    ? key
      ? `Name the Jira key ${key} in every commit message, in the branch name and in the PR title.`
      : `This card has no Jira key yet: ask me for it before your first commit${keep}, then name it in every commit message, in the branch name and in the PR title.`
    : `Name each card's Jira key in every commit message for it, in the branch name and in the PR title. A card with no Jira key yet: ask me for it before its first commit${keep}.`
  return `${name} Never write a card id of the task board (this card's or any other's) in anything that goes into the code repo or its remote: not in a commit message, a branch name, a PR title or description, code, a comment or a file. The code repo is shared with people who never see the board, and Jira tracks this work. This overrides the board repo's CLAUDE.md, which asks for \`Card:\` trailers: put none.`
}

/** How a prompt calls a card in its opening line: its id, or in work mode its Jira key or nothing. */
function cardName(card: Card, ctx: PromptContext): string {
  if (!ctx.work) return `card ${card.id}`
  return card.jira ? `${card.jira}` : 'this card'
}

/** A card's line in a numbered list: `ID: title`, or in work mode `KEY: title` or the title alone. */
function cardHeading(card: Card, ctx: PromptContext): string {
  if (!ctx.work) return `${card.id}: ${card.title}`
  return card.jira ? `${card.jira}: ${card.title}` : card.title
}

// A session the desktop app started anywhere else can move itself (the app gives its sessions a
// change_directory tool); told only to stop, it waited for a person to say "move".
function folderCheck(dir: string): string {
  return `Work in ${dir}. The Claude desktop app can start this session elsewhere (with no folder when its branch was left blank, or in the last folder it used): if your working directory is not ${dir}, move the session there first, with the desktop app's change_directory tool. If you can't, stop and tell me before doing anything else.`
}

// A pointer to a file that isn't there sends the session looking for it.
function guideNote(ctx: PromptContext): string {
  return ctx.guide ? ' (its CLAUDE.md describes the card format)' : ''
}

function listName(card: Card, meta: BoardMeta): string {
  if (card.list === null) return 'map only (idea)'
  return meta.lists.find(l => l.id === card.list)?.title ?? card.list
}

/**
 * The related cards. A work project's cloud prompt names them by title (and Jira key), never by
 * id, and leaves out one it knows nothing about: an id alone is all it could say of it.
 */
function linkLines(card: Card, ctx: PromptContext): string {
  return card.links
    .flatMap(id => {
      const title = ctx.linkTitle(id)
      if (!ctx.work) return [title ? `- ${id}: ${title}` : `- ${id}`]
      const key = ctx.linkKey?.(id)
      if (ctx.cloud) return title ? [key ? `- ${title} (${key})` : `- ${title}`] : []
      return [`- ${id}${title ? `: ${title}` : ''}${key ? ` (${key})` : ''}`]
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
