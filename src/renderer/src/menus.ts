// The right-click menus of cards and lists, shared by the board, map and table views.

import { between, isDivider, LIST_SORTS, listSort, orderList, reorderLists, sortCards } from '@shared/cardfile'
import type { BoardNode, Card, ListDef, LoadedBoard, TackleMode } from '@shared/types'
import type { MenuItem } from './components/ContextMenu'
import { discussCards, tackleCards } from './tackle'
import { actions, api, findNode, flatten, projectIdOf, useStore } from './state'

/** Every other board as "Parent / Child" (behind its project's name when there are several). */
function otherBoards(current: string): { node: BoardNode; label: string; lists: ListDef[] }[] {
  const { tree, projects } = useStore.getState()
  return flatten(tree)
    .filter(n => n.path !== current)
    .map(node => {
      const parts = node.path.split('/')
      let label = parts.map((_, i) => findNode(tree, parts.slice(0, i + 1).join('/'))?.title ?? parts[i]).join(' / ')
      if (projects.length > 1) {
        const project = projects.find(p => p.id === projectIdOf(node.path))
        if (project) label = `${project.name} › ${label}`
      }
      return { node, label, lists: node.lists.filter(l => !l.archived) }
    })
}

function listsOf(board: LoadedBoard): ListDef[] {
  return board.meta.lists.filter(l => !l.archived)
}

export function cardMenu(board: LoadedBoard, card: Card): MenuItem[] {
  const selected = useStore.getState().selected[board.path] ?? []
  const isSelected = selected.includes(card.id)
  const inList = sortCards(board.cards.filter(c => c.list === card.list && !c.archived))
  const sorted = card.list !== null && listSort(board.meta.lists.find(l => l.id === card.list)) !== 'manual'
  const tackle = (mode: TackleMode) => () => void tackleCards(board.path, [card.id], mode)
  const divider = isDivider(card)

  const items: MenuItem[] = [
    { label: 'Open', onSelect: () => actions.openCard(board.path, card.id) },
  ]
  if (!divider && !card.archived) {
    items.push({ label: 'Tackle', items: cardTackleItems(board, card.id) })
    items.push({ label: 'Discuss', hint: 'no implementing', items: discussItems(board, [card.id]) })
    if (selected.length > 1 && isSelected) {
      items.push({
        label: `Tackle the ${selected.length} selected`,
        items: tackleAllItems(board, selected),
      })
    }
  }
  items.push('separator', {
    label: 'Move to list',
    items: [
      ...listsOf(board).map(l => ({
        label: l.title,
        checked: card.list === l.id,
        disabled: card.list === l.id,
        onSelect: () => void actions.moveCard(board.path, card.id, board.path, l.id, endOf(board, l.id)),
      })),
      'separator' as const,
      {
        label: 'Map only (idea)',
        checked: card.list === null,
        disabled: card.list === null,
        onSelect: () => void actions.moveCard(board.path, card.id, board.path, null),
      },
    ],
  })
  const boards = otherBoards(board.path)
  items.push({
    label: 'Move to board',
    disabled: !boards.length,
    items: boards.map(b => ({
      label: b.label,
      items: [
        ...b.lists.map(l => ({
          label: l.title,
          onSelect: () => void actions.moveCard(board.path, card.id, b.node.path, l.id),
        })),
        ...(b.lists.length ? ['separator' as const] : []),
        { label: 'Map only (idea)', onSelect: () => void actions.moveCard(board.path, card.id, b.node.path, null) },
      ],
    })),
  })
  items.push(
    {
      label: 'Move to top',
      hint: sorted ? 'the list is sorted' : undefined,
      disabled: sorted || inList[0]?.id === card.id,
      onSelect: () => void actions.updateCard(board.path, card.id, { pos: between(undefined, inList[0]?.pos) }),
    },
    {
      label: 'Move to bottom',
      hint: sorted ? 'the list is sorted' : undefined,
      disabled: sorted || inList.at(-1)?.id === card.id,
      onSelect: () => void actions.updateCard(board.path, card.id, { pos: between(inList.at(-1)?.pos, undefined) }),
    },
    'separator',
    {
      label: 'Link to a card…',
      hint: 'any board',
      onSelect: () => {
        actions.openCard(board.path, card.id)
        useStore.setState(s => ({ focusLinks: s.focusLinks + 1 }))
      },
    },
    {
      label: 'Copy',
      items: [
        { label: 'Identifier', hint: card.id, onSelect: () => actions.copy(card.id) },
        { label: 'Title', onSelect: () => actions.copy(card.title, 'the title') },
        { label: 'Commit trailer', hint: `Card: ${card.id}`, onSelect: () => actions.copy(`Card: ${card.id}`) },
        { label: 'Markdown', hint: `[${card.id}] …`, onSelect: () => actions.copy(`[${card.id}] ${card.title}`, 'as Markdown') },
        {
          label: 'File path',
          onSelect: async () => actions.copy(await api.cards.filePath(board.path, card.id), 'the file path'),
        },
        ...(divider || card.archived
          ? []
          : [
              'separator' as const,
              {
                label: 'Tackle prompt',
                hint: 'to paste into Claude',
                onSelect: () => void copyPrompt(board, card.id, 'tackle'),
              },
              { label: 'Discuss prompt', onSelect: () => void copyPrompt(board, card.id, 'discuss') },
            ]),
      ],
    },
    {
      label: isSelected ? 'Deselect' : 'Select',
      hint: 'Ctrl+click',
      onSelect: () => actions.toggleSelected(board.path, card.id),
    },
  )
  if (!divider) {
    items.push({
      label: card.complete ? 'Mark incomplete' : 'Mark complete',
      onSelect: () => void actions.updateCard(board.path, card.id, { complete: card.complete ? undefined : true }),
    })
  }
  items.push(
    {
      label: 'Duplicate',
      onSelect: () => void api.cards.duplicate(board.path, card.id).catch(e => actions.toast((e as Error).message, 'error')),
    },
    { label: 'Open file', onSelect: async () => api.shell.openPath(await api.cards.filePath(board.path, card.id)) },
    'separator',
    {
      label: card.archived ? 'Unarchive' : 'Archive',
      danger: !card.archived,
      onSelect: () => void actions.updateCard(board.path, card.id, { archived: card.archived ? undefined : true }),
    },
  )
  return items
}

/** Copies the prompt a tackle or discussion in a terminal would start with. */
async function copyPrompt(board: LoadedBoard, id: string, purpose: 'tackle' | 'discuss'): Promise<void> {
  try {
    const prompt = await api.tackle.prompt({ boardPath: board.path, cardIds: [id], mode: 'local', purpose })
    actions.copy(prompt, `the ${purpose} prompt`)
  } catch (e) {
    actions.toast((e as Error).message, 'error')
  }
}

/** Where cards can be talked through: one card, or a list or selection to triage together. */
export function discussItems(board: LoadedBoard, ids: string[], listTitle?: string): MenuItem[] {
  const go = (mode: 'desktop' | 'local') => () => void discussCards(board.path, ids, mode, { listTitle })
  const desktop = useStore.getState().desktop
  return [
    ...(desktop ? [{ label: 'In Claude desktop', onSelect: go('desktop') }] : []),
    { label: 'In a terminal', onSelect: go('local') },
  ]
}

/** Where one card can be tackled. */
export function cardTackleItems(board: LoadedBoard, id: string): MenuItem[] {
  const go = (mode: TackleMode) => () => void tackleCards(board.path, [id], mode)
  const desktop = useStore.getState().desktop
  return [
    ...(desktop ? [{ label: 'In Claude desktop', hint: 'a new Code session', onSelect: go('desktop') }] : []),
    { label: 'In a terminal', hint: 'here, in the code repo', onSelect: go('local') },
    { label: 'In a terminal, in a worktree', onSelect: go('local-worktree') },
    { label: 'In Claude Cloud', onSelect: go('cloud') },
  ]
}

/** Where several cards (a list, a selection) can be tackled: together or one session each. */
export function tackleAllItems(board: LoadedBoard, ids: string[], listTitle?: string): MenuItem[] {
  const go = (mode: TackleMode, split: 'together' | 'each') => () =>
    void tackleCards(board.path, ids, mode, { split, listTitle })
  const desktop = useStore.getState().desktop
  return [
    ...(desktop
      ? [
          { label: 'In Claude desktop, one session', hint: 'in order', onSelect: go('desktop', 'together') },
          { label: 'In Claude desktop, one session per card', onSelect: go('desktop', 'each') },
          'separator' as const,
        ]
      : []),
    { label: 'In a terminal, one session', hint: 'in order', onSelect: go('local', 'together') },
    { label: 'In terminals, in parallel', hint: 'a worktree each', onSelect: go('local-worktree', 'each') },
    'separator',
    { label: 'In Claude Cloud, one session', onSelect: go('cloud', 'together') },
    { label: 'In Claude Cloud, one session per card', onSelect: go('cloud', 'each') },
  ]
}

function endOf(board: LoadedBoard, listId: string): number {
  const inList = sortCards(board.cards.filter(c => c.list === listId && !c.archived))
  return between(inList.at(-1)?.pos, undefined)
}

export type ListMenuHooks = { addCard: () => void; rename: () => void }

export function listMenu(board: LoadedBoard, list: ListDef, hooks: ListMenuHooks): MenuItem[] {
  const sort = listSort(list)
  const cards = orderList(board.cards.filter(c => c.list === list.id && !c.archived), sort)
  const work = cards.filter(c => !isDivider(c))
  const collapsed = (useStore.getState().collapsed[board.path] ?? []).includes(list.id)
  const visible = listsOf(board)
  const visibleIndex = visible.findIndex(l => l.id === list.id)

  const setLists = (lists: ListDef[]) =>
    void api.boards.updateMeta(board.path, { lists }).then(() => actions.loadBoard(board.path))
  const moveBy = (by: number) => {
    // Next to the neighbouring visible list, archived ones staying where they are.
    const other = visible[visibleIndex + by]
    const lists = other ? reorderLists(board.meta.lists, list.id, other.id) : null
    if (lists) void actions.setLists(board.path, lists)
  }

  const boards = otherBoards(board.path)
  return [
    { heading: `${list.title} · ${work.length} card${work.length === 1 ? '' : 's'}` },
    { label: 'Add a card', onSelect: hooks.addCard },
    { label: 'Rename list', hint: 'double-click the title', onSelect: hooks.rename },
    'separator',
    { label: 'Tackle all', disabled: !work.length, items: tackleAllItems(board, work.map(c => c.id), list.title) },
    {
      label: 'Discuss / triage',
      hint: 'no implementing',
      disabled: !work.length,
      items: discussItems(board, work.map(c => c.id), list.title),
    },
    {
      label: 'Select all cards',
      disabled: !work.length,
      onSelect: () => actions.selectMany(board.path, work.map(c => c.id)),
    },
    'separator',
    {
      label: 'Sort cards by',
      hint: LIST_SORTS.find(s => s.id === sort)?.label,
      items: LIST_SORTS.map(s => ({
        label: s.label,
        hint: s.id === 'manual' ? 'drag and drop' : undefined,
        checked: s.id === sort,
        disabled: s.id === sort,
        onSelect: () => void actions.setListSort(board.path, list.id, s.id),
      })),
    },
    { label: 'Move list left', disabled: visibleIndex <= 0, onSelect: () => moveBy(-1) },
    { label: 'Move list right', disabled: visibleIndex >= visible.length - 1, onSelect: () => moveBy(1) },
    {
      label: 'Move list to board',
      disabled: !boards.length,
      items: boards.map(b => ({
        label: b.label,
        onSelect: async () => {
          try {
            await api.lists.move(board.path, list.id, b.node.path)
            await actions.loadBoard(board.path)
            if (useStore.getState().boards[b.node.path]) await actions.loadBoard(b.node.path)
            actions.toast(`Moved “${list.title}” and its ${cards.length} cards to ${b.label}`)
          } catch (e) {
            actions.toast((e as Error).message, 'error')
          }
        },
      })),
    },
    { label: collapsed ? 'Expand list' : 'Collapse list', onSelect: () => actions.toggleCollapsed(board.path, list.id) },
    {
      label: 'Copy as Markdown',
      disabled: !cards.length,
      onSelect: () =>
        actions.copy(
          `## ${list.title}\n\n${cards
            .map(c => (isDivider(c) ? '---' : `- [${c.complete ? 'x' : ' '}] ${c.id}: ${c.title}`))
            .join('\n')}\n`,
          `${list.title} as Markdown`,
        ),
    },
    'separator',
    {
      label: 'Archive all cards in this list',
      danger: true,
      disabled: !cards.length,
      onSelect: async () => {
        const ok = await actions.confirm(
          `Archive the ${cards.length} cards in “${list.title}”?`,
          'They disappear from the board and stay in the repo with archived: true (the table view shows them).',
          'Archive cards',
        )
        if (ok) await api.cards.updateMany(board.path, cards.map(c => ({ id: c.id, patch: { archived: true } })))
      },
    },
    {
      label: 'Archive list',
      danger: true,
      onSelect: async () => {
        const ok = await actions.confirm(
          `Archive the list “${list.title}”?`,
          'The list is hidden from the board; its cards keep their list. Restore it from the board settings.',
          'Archive list',
        )
        if (ok) setLists(board.meta.lists.map(l => (l.id === list.id ? { ...l, archived: true } : l)))
      },
    },
  ]
}
