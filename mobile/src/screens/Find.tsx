// The board's search: a magnifier beside the list tabs that opens a field in their place. While it
// holds any text, the board shows the cards matching it (`findCards` in src/repo/find.ts).

import './find.css'

export function FindButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="tabbar-button" aria-label="Find a card" onClick={onOpen}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
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
