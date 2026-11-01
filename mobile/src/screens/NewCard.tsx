import { useState } from 'react'
import { Header } from './parts'

export /** Writing a new card: its title, and a description if you like. */
function NewCard({ listTitle, onCancel, onSave }: { listTitle: string; onCancel: () => void; onSave: (title: string, body: string) => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <>
      <Header title="New card" sub={listTitle ? `In ${listTitle}` : undefined} onBack={onCancel} />
      <form
        className="page new-card"
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
