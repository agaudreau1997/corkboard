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
//
// A session the app started in a terminal or a worktree has the app's MCP server (`mcp` in the
// context): it is told to change cards with the server's tools, which check the change and stamp
// `updated` from the app's clock, and never to edit a card file. Every other session (Claude
// desktop, the cloud, a prompt copied into a session of one's own) gets the file rules.

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
  /** The session has the app's MCP server, whose tools change the cards instead of the files. */
  mcp?: boolean
  /** A card by id anywhere in the repo: an untangle names the card now under a renumbered card's old id. */
  findCard?: (id: string) => Card | undefined
  /** The board's code repo on this machine, when it has one: where an untangle looks for trailers. */
  codeRepo?: string
}

export type Purpose = 'tackle' | 'discuss' | 'untangle'

export function sessionName(cards: Card[], groupTitle?: string, purpose: Purpose = 'tackle'): string {
  const name =
    cards.length === 1
      ? `${cards[0].id} ${truncate(cards[0].title, 48)}`
      : groupTitle
        ? `${groupTitle} (${cards.length} cards)`
        : `${cards.map(c => c.id).join(' ')}`
  if (purpose === 'tackle') return name
  if (purpose === 'untangle') return `Untangle ${name}`
  return cards.length > 1 ? `Triage ${name}` : `Discuss ${name}`
}

/**
 * Sorting out what still names a card's old id after a sync renumbered it (another machine had
 * made a card under the same id). The sync moved the links this machine wrote; what is left needs
 * reading: a description, a link written on the other machine, a commit's trailer or a branch
 * may name the old id and mean either card. So the prompt gives both cards in full, and the
 * session decides each mention from its context, fixes the board through the usual rules, and
 * only proposes what would rewrite the code repo's history. A work project's code repo never names
 * a card id, so there it is left alone and the rule against writing one is repeated.
 */
export function untanglePrompt(cards: Card[], ctx: PromptContext): string {
  const renumbers = cards.flatMap(card => (card.renumbered ?? []).map(r => ({ card, from: r.from })))
  const one = renumbers.length === 1
  const parts: string[] = []
  parts.push(
    one
      ? 'A sync of the task board renumbered a card: another machine had made a card under the same id before the two synced, so the card made on this machine took a new id. Anything written before that sync may still name the old id while meaning the renumbered card. Help me untangle those references.'
      : `A sync of the task board renumbered ${renumbers.length} cards: another machine had made cards under the same ids before the two synced, so the cards made on this machine took new ids. Anything written before that sync may still name an old id while meaning the renumbered card. Help me untangle those references.`,
  )
  parts.push(
    renumbers
      .map(({ card, from }, i) => {
        const lines = [`${i + 1}. ${from} is now ${card.id}${card.uid ? ` (uid ${card.uid})` : ''}.`]
        lines.push(`   The renumbered card, now ${card.id}: ${card.title}`)
        lines.push(`   File: ${ctx.cardFile(card.id)}`)
        if (card.body.trim()) lines.push(indent(card.body.trim(), '      '))
        const other = ctx.findCard?.(from)
        if (other) {
          lines.push(`   The card now under ${from}, made on the other machine: ${other.title}`)
          if (other.body.trim()) lines.push(indent(other.body.trim(), '      '))
        } else {
          lines.push(`   No card is under ${from} on this machine now (moved, or not synced back yet).`)
        }
        return lines.join('\n')
      })
      .join('\n\n'),
  )
  parts.push(`The cards are Markdown files in the board repo ${ctx.boardRoot}${guideNote(ctx)}.`)

  const fix = ctx.mcp
    ? `with the corkboard tools (update_card for a description, links or \`after\`), never by editing a card file. ${MCP_NOTE}`
    : 'in the card files, setting `updated:` (now, ISO UTC) on each card you change.'
  const rules = [
    `Search every card of the board repo (descriptions, \`links:\` and \`after:\`, on every board) for ${one ? 'the old id' : 'each old id'}. Decide from the context which card each mention means: the renumbered card, or the card now under the old id. Fix the ones that mean the renumbered card, ${fix} Leave the others as they are.`,
  ]
  if (ctx.work) {
    rules.push(
      "This is a work project: its code repo names Jira keys, never card ids, so a renumber leaves nothing to fix there. Don't change the code repo, and never write a card id of the task board in anything that goes into it or its remote: not in a commit message, a branch name, a PR title or description, code, a comment or a file. This overrides the board repo's CLAUDE.md, which asks for `Card:` trailers: put none.",
    )
  } else if (ctx.codeRepo) {
    const trailers = renumbers.map(r => `\`Card: ${r.from}\``).join(', ')
    rules.push(
      `In the code repo ${ctx.codeRepo}, find the commits whose trailer names an old id (${trailers}; \`git log --all --grep\`) and the branches named after one. Decide from each commit's changes which card it was for. For those that belong to a renumbered card and aren't pushed yet (no remote branch contains them: \`git branch -r --contains <sha>\`), propose how to fix them (the trailer reworded to the new id by amending or rebasing before the push, a branch renamed with \`git branch -m\`), and change them only once I agree. Leave pushed commits as they are: name them (short hash and subject) in the renumbered card's description instead, saying their trailer names its old id.`,
    )
  } else {
    rules.push('This board has no code repo on this machine: leave the commits alone.')
  }
  rules.push(
    "Ask me before anything you aren't sure of: a mention that could mean either card, a commit you can't place, any rewrite of the code repo's history.",
    'Change nothing else: this is untangling, not work on the cards.',
    "Don't commit in the board repo; the board app commits it.",
  )
  parts.push(rules.map(r => `- ${r}`).join('\n'))
  return parts.join('\n\n')
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
    ctx.mcp
      ? `When we agree on something, change the card with the corkboard tools (update_card for its description, title, links and \`after\`, move_card for its list, archive_card, create_card for a new card), never by editing its file: those cards are the only things you may change without asking. ${MCP_NOTE} Do not commit in the board repo; the board app commits it.`
      : 'When we agree on something, write it into the card file (description, title, links, `after`, list, or `archived: true`) and set `updated:` (now, ISO UTC): those card files are the only files you may edit without asking. Do not commit in the board repo; the board app commits it.',
    ORDER_RULE,
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
          const first = waitsOn(card, cards)
          if (first) lines.push(`   Do it after ${first}.`)
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
  if (cards.some(c => waitsOn(c, cards))) {
    rules.push("Some of them wait on others (\"Do it after\"): if a card can't be finished, don't start the cards that wait on it; leave them in their list and tell me why.")
  }
  if (ctx.work) {
    rules.push(workRule(cards, ctx))
  } else {
    rules.push(
      one
        ? `Put a \`Card: ${cards[0].id}\` trailer on every commit you make for this card.`
        : 'Put a `Card: <ID>` trailer on every commit, naming the card the commit is for.',
    )
  }
  if (ctx.mcp) {
    rules.push(`Change the cards with the corkboard tools (get_card, move_card, update_card, link_cards), never by editing their files. ${MCP_NOTE}`)
  }
  if (!ctx.cloud && doneList && ctx.mcp) {
    rules.push(
      one
        ? `When the work is done and verified, move the card to "${doneList.title}" with move_card (\`flow: done\`).`
        : `As each card is done and verified, move it to "${doneList.title}" with move_card (\`flow: done\`) before starting the next, so the board shows progress.`,
    )
  } else if (!ctx.cloud && doneList) {
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
    : ctx.mcp
      ? one
        ? ' and set it on the card with update_card (`jira`)'
        : ' and set it on that card with update_card (`jira`)'
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

// Recorded on the cards, an order agreed in a discussion is what a later tackle of the whole list
// follows: the cards it joins go to one session, in that order.
const ORDER_RULE =
  "When we agree that a card must be done before another, record it in the later card's `after` (the ids of the cards of the same board to do before it): a tackle of several cards then keeps them in one session, in that order."

// Why the tools and not the files, and what to do when the app that serves them has been closed
// since the session started.
const MCP_NOTE =
  "The tools keep the card format and stamp `updated:` themselves. Only if they stop answering (Corkboard was closed), edit the card file instead, as the board repo's CLAUDE.md describes."

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

/**
 * The cards of the session a card waits on, by their number in the prompt: numbers rather than
 * ids, so a work project's prompt says it without a card id.
 */
function waitsOn(card: Card, cards: Card[]): string | undefined {
  const numbers = cards.flatMap((c, i) => (card.after.includes(c.id) && c.id !== card.id ? [String(i + 1)] : []))
  if (!numbers.length) return undefined
  return numbers.length === 1 ? numbers[0] : `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`
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
