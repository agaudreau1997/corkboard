// A list's menu, from the ⋯ beside the tabs or a long press on a tab: sort its cards, rename it,
// move it left or right, archive it, add a list, and the board's settings. The phone's version of
// the desktop's list menu; each choice is one change to `board.json` (src/repo/boardchange.ts).

import { useState } from 'react'
import { LIST_SORTS, listSort } from '@shared/cardfile'
import type { BoardMeta, ListDef } from '@shared/types'
import type { BoardChange } from '../repo/boardchange'
import { Sheet, SheetItem } from './Sheet'
import './listmenu.css'

type Step = 'menu' | 'sort' | 'rename' | 'add' | 'archive'

export function ListMenu(props: {
  meta: BoardMeta
  /** The list the menu is for; none on the Ideas and Archived tabs. */
  list?: ListDef
  /** How many cards it holds, for its heading. */
  count?: number
  canChange: boolean
  onClose: () => void
  onChange: (change: BoardChange) => void
  onSettings: () => void
}) {
  const { meta, list, count, canChange, onClose, onChange, onSettings } = props
  const [step, setStep] = useState<Step>('menu')
  const change = (c: BoardChange) => {
    onClose()
    onChange(c)
  }
  const visible = meta.lists.filter(l => !l.archived)
  const at = list ? visible.findIndex(l => l.id === list.id) : -1

  if (step === 'rename' && list) {
    return <AskText title="Rename list" value={list.title} action="Rename" onClose={onClose} onDone={title => change({ kind: 'renameList', list: list.id, title })} />
  }
  if (step === 'add') {
    return <AskText title="Add a list" value="" action="Add list" onClose={onClose} onDone={title => change({ kind: 'addList', title })} />
  }
  if (step === 'sort' && list) {
    const sort = listSort(meta, list)
    return (
      <Sheet title={`Sort ${list.title} by`} onClose={onClose}>
        {LIST_SORTS.map(s => (
          <SheetItem
            key={s.id}
            label={s.label}
            hint={s.id === 'manual' ? 'as placed on the desktop' : undefined}
            checked={s.id === sort}
            disabled={s.id === sort}
            onSelect={() => change({ kind: 'sortList', list: list.id, sort: s.id })}
          />
        ))}
      </Sheet>
    )
  }
  if (step === 'archive' && list) {
    return (
      <Sheet title={`Archive the list “${list.title}”?`} onClose={onClose}>
        <p className="sheet-note">The list is hidden from the board; its cards keep their list. Restore it from the board settings.</p>
        <SheetItem label="Archive list" danger onSelect={() => change({ kind: 'archiveList', list: list.id })} />
        <SheetItem label="Cancel" onSelect={onClose} />
      </Sheet>
    )
  }

  const off = !canChange
  return (
    <Sheet title={list ? `${list.title} · ${count ?? 0} card${count === 1 ? '' : 's'}` : meta.title} onClose={onClose}>
      {off && <p className="sheet-note">Changing the board needs a connection to GitHub.</p>}
      {list && (
        <>
          <SheetItem
            label="Sort cards by"
            hint={LIST_SORTS.find(s => s.id === listSort(meta, list))?.label}
            disabled={off}
            onSelect={() => setStep('sort')}
          />
          <SheetItem label="Rename list" disabled={off} onSelect={() => setStep('rename')} />
          <SheetItem label="Move list left" disabled={off || at <= 0} onSelect={() => change({ kind: 'moveList', list: list.id, by: -1 })} />
          <SheetItem
            label="Move list right"
            disabled={off || at < 0 || at >= visible.length - 1}
            onSelect={() => change({ kind: 'moveList', list: list.id, by: 1 })}
          />
          <SheetItem label="Archive list" danger disabled={off} onSelect={() => setStep('archive')} />
          <hr />
        </>
      )}
      <SheetItem label="Add a list" disabled={off} onSelect={() => setStep('add')} />
      <SheetItem
        label="Board settings"
        onSelect={() => {
          onClose()
          onSettings()
        }}
      />
    </Sheet>
  )
}

/** A sheet asking for a line of text: a list's title, a board's. */
export function AskText(props: { title: string; value: string; action: string; onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState(props.value)
  const ok = !!text.trim() && text.trim() !== props.value
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <form
        className="sheet-form"
        onSubmit={e => {
          e.preventDefault()
          if (ok) props.onDone(text.trim())
        }}
      >
        <input autoFocus value={text} onChange={e => setText(e.target.value)} enterKeyHint="done" aria-label={props.title} />
        <div className="sheet-buttons">
          <button type="button" className="plain" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ok}>
            {props.action}
          </button>
        </div>
      </form>
    </Sheet>
  )
}
