// A card in a list, drawn as the desktop's kanban draws it: the title, then the id and the badges
// from the shared `cardBadges`, in the same order, glyphs and colours, so a board reads the same on
// both. Labels stay off the face, as on the desktop: the card's own screen shows them. There are no
// commit counts here: those come from the code repo, which the phone doesn't read.

import { badgeChildren, badgeClass, cardBadges } from '@shared/badges'
import type { Card } from '@shared/types'
import type { Board } from '../repo/reader'
import './CardFace.css'

export function CardFace({ card, board, onOpen }: { card: Card; board: Board; onOpen: () => void }) {
  const badges = cardBadges(card, board)
  return (
    <button type="button" className={card.complete ? 'card complete' : 'card'} onClick={onOpen}>
      <span className="card-title">{card.title}</span>
      <span className="card-meta">
        <span className="card-id">{card.id}</span>
        {badges.map(b => (
          <span key={b.key} className={badgeClass(b)} aria-label={b.title}>
            {badgeChildren(b)}
          </span>
        ))}
      </span>
    </button>
  )
}
