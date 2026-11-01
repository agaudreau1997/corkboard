import { isDivider, listSort, orderList, sortCards } from '@shared/cardfile'
import { findCycle, tackleGroups, unmetPrerequisites } from '@shared/tackleorder'
import type { Card, TackleMode } from '@shared/types'
import { actions, api, isWork, useStore } from './state'

/** Starts Claude on cards; a cloud run asks first, since it works from GitHub's copy and is billed. */
export async function tackleCards(
  boardPath: string,
  cardIds: string[],
  mode: TackleMode,
  opts: { split?: 'together' | 'each'; listTitle?: string } = {},
): Promise<void> {
  const board = useStore.getState().boards[boardPath]
  if (!board) return
  const cards = cardIds
    .map(id => board.cards.find(c => c.id === id))
    .filter(c => c && !c.archived && !isDivider(c))
  if (!cards.length) {
    actions.toast('Nothing to tackle: dividers and archived cards are skipped.', 'error')
    return
  }
  const live = cards as Card[]
  const loop = findCycle(live)
  if (loop) {
    actions.toast(`These cards wait on each other in a loop: ${[...loop, loop[0]].join(' → ')}. Change one's "after" first.`, 'error')
    return
  }
  const count = live.length
  const groups = tackleGroups(live, opts.split)
  const sessions = groups.length
  // What the dialog says of the sessions that hold several cards, and of the cards waited on that
  // the tackle leaves out: it goes ahead all the same, once you say so.
  const chains = groups.filter(g => g.length > 1).map(g => g.map(c => c.id).join(' → '))
  const together = chains.length ? ` Cards ordered by "after" share a session, in that order: ${chains.join('; ')}.` : ''
  const unmet = unmetPrerequisites(live, board.cards, board.meta.flow?.done)
  const warning = unmet
    .map(u => ` ${u.id} waits on ${u.needs.join(', ')}, not done yet and not in this tackle.`)
    .join('')
  const perCard = chains.length ? 'one per card or ordered run' : 'one per card'
  if (mode === 'cloud') {
    const ok = await actions.confirm(
      sessions > 1
        ? `Start ${sessions} Claude Cloud sessions, ${perCard}?`
        : `Tackle ${count === 1 ? live[0].id : `${count} cards`} in Claude Cloud?`,
      'A cloud session clones the code repo from GitHub at your current branch, so it only sees pushed commits. ' +
        'It runs on claude.ai and is billed like any session. The card gets the session link once it prints one.' +
        together +
        warning,
      sessions > 1 ? `Start ${sessions} cloud sessions` : 'Start cloud session',
    )
    if (!ok) return
  } else if (mode === 'desktop' && opts.split === 'each' && sessions > 1) {
    const ok = await actions.confirm(
      `Open ${sessions} sessions in Claude desktop?`,
      `Each card gets its own new Code session in the desktop app, its prompt filled in.${together}${warning}`,
      `Open ${sessions} sessions`,
    )
    if (!ok) return
  } else if (opts.split === 'each' && sessions > 1) {
    const ok = await actions.confirm(
      `Start ${sessions} parallel sessions?`,
      `Each card gets its own Claude Code session in its own git worktree (.claude/worktrees/${isWork(boardPath) ? '<Jira key>' : 'card-<id>'}), each in a terminal tab.${together}${warning}`,
      `Start ${sessions} sessions`,
    )
    if (!ok) return
  } else if (warning) {
    const ok = await actions.confirm(
      `Tackle ${count === 1 ? live[0].id : `${count} cards`} before what they wait on?`,
      `${warning.trim()} The session starts all the same if you go ahead.`,
      'Tackle anyway',
    )
    if (!ok) return
  }
  try {
    await api.tackle.start({ boardPath, cardIds: live.map(c => c.id), mode, ...opts })
    actions.clearSelection(boardPath)
    if (mode === 'desktop') {
      actions.toast('Opened in Claude desktop; the card links to the session once its prompt is sent.')
    }
  } catch (error) {
    actions.toast((error as Error).message, 'error')
  }
}

/**
 * Opens a conversation about cards (one card, or a list or board to triage): nothing is implemented
 * unless asked in it, and the cards stay in their lists.
 */
export async function discussCards(
  boardPath: string,
  cardIds: string[],
  mode: 'desktop' | 'local',
  scope: { listTitle?: string; boardTitle?: string } = {},
): Promise<void> {
  const board = useStore.getState().boards[boardPath]
  if (!board) return
  const ids = cardIds.filter(id => {
    const card = board.cards.find(c => c.id === id)
    return card && !card.archived && !isDivider(card)
  })
  if (!ids.length) {
    actions.toast('Nothing to discuss: dividers and archived cards are skipped.', 'error')
    return
  }
  try {
    await api.tackle.start({ boardPath, cardIds: ids, mode, split: 'together', ...scope, purpose: 'discuss' })
    if (mode === 'desktop') actions.toast('Opened a discussion in Claude desktop: nothing gets implemented unless you ask.')
  } catch (error) {
    actions.toast((error as Error).message, 'error')
  }
}

/**
 * Starts a terminal session that sorts out what still names renumbered cards' old ids (see
 * `untanglePrompt`). The board needn't be open: the side panel's notice offers it for any board.
 */
export async function untangleCards(boardPath: string, cardIds: string[]): Promise<boolean> {
  try {
    await api.tackle.start({ boardPath, cardIds, mode: 'local', split: 'together', purpose: 'untangle' })
    return true
  } catch (error) {
    actions.toast((error as Error).message, 'error')
    return false
  }
}

/**
 * Triages a whole board in one conversation: the cards of each list in board order, then the
 * map-only ideas. Archived lists and cards are left out. The board loads first when it is not open.
 */
export async function discussBoard(boardPath: string, mode: 'desktop' | 'local'): Promise<void> {
  if (!useStore.getState().boards[boardPath]) await actions.loadBoard(boardPath)
  const board = useStore.getState().boards[boardPath]
  if (!board) return
  const live = board.cards.filter(c => !c.archived && !isDivider(c))
  const lists = board.meta.lists.filter(l => !l.archived)
  const ids = [
    ...lists.flatMap(list => orderList(live.filter(c => c.list === list.id), listSort(board.meta, list))),
    ...sortCards(live.filter(c => c.list === null)),
  ].map(c => c.id)
  await discussCards(boardPath, ids, mode, { boardTitle: board.meta.title })
}
