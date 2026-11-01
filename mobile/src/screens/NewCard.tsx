// Writing a new card, in the drawer over the list it goes to: its title, and a description if you
// like. It waits in the outbox until it's sent (Browse.tsx).

import { useState } from 'react'
import { DrawerTop } from './Drawer'

/** Writing a new card: its title, and a description if you like. */
export function NewCard({ listTitle, onCancel, onSave }: { listTitle: string; onCancel: () => void; onSave: (title: string, body: string) => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <>
      <DrawerTop onClose={onCancel} title={<h2>New card</h2>}>
        {listTitle && <span className="where">In {listTitle}</span>}
      </DrawerTop>
      <form
        className="drawer-body new-card"
        onSubmit={e => {
          e.preventDefault()
          if (title.trim()) onSave(title.trim(), body)
        }}
      >
        <input autoFocus placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} enterKeyHint="done" />
        <textarea placeholder="Description (Markdown, optional)" value={body} onChange={e => setBody(e.target.value)} rows={8} />
        <button className="primary" type="submit" disabled={!title.trim()}>
          Add card
        </button>
      </form>
    </>
  )
}
