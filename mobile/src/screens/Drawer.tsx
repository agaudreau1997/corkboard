// The top of the card drawer, as the desktop's `CardDetail` has it: a head with the card's id (a
// tap copies it) and where it is, the close button at its right, then the title; they stay in
// view while what's under them (`.drawer-body`) scrolls. The new-card form wears it too.

import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import './drawer.css'

export function DrawerTop(props: {
  /** The head's left side: the id, the Jira key, where the card is. */
  children: ReactNode
  title?: ReactNode
  busy?: boolean
  onClose: () => void
}) {
  const { children, title, busy, onClose } = props
  return (
    <div className="drawer-top">
      <div className="drawer-head">
        {children}
        <span className="spacer" />
        {busy && <span className="spinner" aria-label="Saving" />}
        <button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {title}
    </div>
  )
}
