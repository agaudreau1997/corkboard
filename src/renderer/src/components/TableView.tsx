import { useMemo, useState } from 'react'
import { cardNumber, isDivider } from '@shared/cardfile'
import type { Card, LoadedBoard } from '@shared/types'
import { actions, commitsFor, listColor, localTime, useStore, NONE } from '../state'

type SortKey = 'id' | 'title' | 'list' | 'updated' | 'commits'

export function TableView({ board, matches }: { board: LoadedBoard; matches: (c: Card) => boolean }) {
  const commits = useStore(s => s.commits[board.path])
  const selected = useStore(s => s.selected[board.path] ?? NONE)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'updated', desc: true })
  const [archived, setArchived] = useState(false)

  const listTitle = (id: string | null) =>
    id === null ? 'Map only' : (board.meta.lists.find(l => l.id === id)?.title ?? id)

  const rows = useMemo(() => {
    const out = board.cards.filter(c => !isDivider(c) && matches(c) && (archived || !c.archived))
    const value = (c: Card): string | number => {
      switch (sort.key) {
        case 'id':
          return cardNumber(c.id)
        case 'title':
          return c.title.toLowerCase()
        case 'list':
          return board.meta.lists.findIndex(l => l.id === c.list)
        case 'updated':
          return c.updated ?? c.created ?? ''
        case 'commits':
          return commitsFor(commits, c.id).length
      }
    }
    out.sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return sort.desc ? -cmp : cmp
    })
    return out
  }, [board, matches, archived, sort, commits])

  const header = (key: SortKey, label: string) => (
    <th
      onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key === 'updated' || key === 'commits' }))}
      className={sort.key === key ? 'sorted' : ''}
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  )

  return (
    <div className="table-view">
      <div className="table-toolbar">
        <span className="muted">{rows.length} cards</span>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Show archived
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {header('id', 'ID')}
              {header('title', 'Title')}
              {header('list', 'List')}
              {header('updated', 'Updated')}
              {header('commits', 'Commits')}
            </tr>
          </thead>
          <tbody>
            {rows.map(card => (
              <tr
                key={card.id}
                className={`${card.archived ? 'archived' : ''}${selected.includes(card.id) ? ' selected' : ''}`}
                onClick={e => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey) actions.toggleSelected(board.path, card.id)
                  else actions.openCard(board.path, card.id)
                }}
              >
                <td className="mono">{card.id}</td>
                <td>{card.title}</td>
                <td>
                  <span className="list-pill" style={{ borderColor: listColor(board, card.list) }}>
                    {listTitle(card.list)}
                  </span>
                </td>
                <td className="muted nowrap">{localTime(card.updated ?? card.created, false)}</td>
                <td className="mono">{commitsFor(commits, card.id).length || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
