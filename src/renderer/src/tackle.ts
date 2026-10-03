import { isDivider } from '@shared/cardfile'
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
