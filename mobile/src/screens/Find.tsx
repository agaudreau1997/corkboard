// The board's search: a magnifier beside the list tabs that opens a field in their place. While it
// holds any text, the board shows the cards matching it (`findCards` in src/repo/find.ts).

import { Icon } from '../Icon'
import './find.css'

export function FindButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="tabbar-button" aria-label="Find a card" onClick={onOpen}>
      <Icon name="search" />
    </button>
  )
}

export function FindBar({ query, onQuery, onClose }: { query: string; onQuery: (q: string) => void; onClose: () => void }) {
  return (
    <div className="findbar">
      <input
        autoFocus
        type="search"
        placeholder="Find: id, title or description"
        value={query}
        enterKeyHint="search"
        onChange={e => onQuery(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button type="button" className="plain" onClick={onClose}>
        Close
      </button>
    </div>
  )
}
