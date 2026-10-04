import { isDivider, sortCards } from '@shared/cardfile'
import type { TackleMode } from '@shared/types'
import { actions, api, useStore } from './state'

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
  const count = cards.length
  if (mode === 'cloud') {
    const sessions = opts.split === 'each' ? count : 1
    const ok = await actions.confirm(
      sessions > 1
        ? `Start ${sessions} Claude Cloud sessions, one per card?`
        : `Tackle ${count === 1 ? cards[0]!.id : `${count} cards`} in Claude Cloud?`,
      'A cloud session clones the code repo from GitHub at your current branch, so it only sees pushed commits. ' +
        'It runs on claude.ai and is billed like any session. The card gets the session link once it prints one.',
      sessions > 1 ? `Start ${sessions} cloud sessions` : 'Start cloud session',
    )
    if (!ok) return
  } else if (mode === 'desktop' && opts.split === 'each' && count > 1) {
    const ok = await actions.confirm(
      `Open ${count} sessions in Claude desktop?`,
      'Each card gets its own new Code session in the desktop app, its prompt filled in.',
      `Open ${count} sessions`,
    )
    if (!ok) return
  } else if (opts.split === 'each' && count > 1) {
    const ok = await actions.confirm(
      `Start ${count} parallel sessions?`,
      `Each card gets its own Claude Code session in its own git worktree (.claude/worktrees/card-<id>), each in a terminal tab.`,
      `Start ${count} sessions`,
    )
    if (!ok) return
  }
  try {
    await api.tackle.start({ boardPath, cardIds: cards.map(c => c!.id), mode, ...opts })
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
 * Triages a whole board in one conversation: the cards of each list in board order, then the
 * map-only ideas. Archived lists and cards are left out. The board loads first when it is not open.
 */
export async function discussBoard(boardPath: string, mode: 'desktop' | 'local'): Promise<void> {
  if (!useStore.getState().boards[boardPath]) await actions.loadBoard(boardPath)
  const board = useStore.getState().boards[boardPath]
  if (!board) return
  const live = board.cards.filter(c => !c.archived && !isDivider(c))
  const groups = [...board.meta.lists.filter(l => !l.archived).map(l => l.id), null]
  const ids = groups.flatMap(list => sortCards(live.filter(c => c.list === list)).map(c => c.id))
  await discussCards(boardPath, ids, mode, { boardTitle: board.meta.title })
}
