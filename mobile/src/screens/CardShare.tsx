// Sharing a card and copying from it: the phone's version of the desktop's Copy menu, with
// Android's share sheet for the card's text. What is shared or copied is built by
// `src/shared/cardcopy.ts`, as the desktop's menu builds it, so a work project's text names the
// card's Jira key and never its id. Neither needs a connection.

import { useState } from 'react'
import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import { cardCopies, cardShareText } from '@shared/cardcopy'
import type { Card } from '@shared/types'
import { Sheet, SheetItem, useToast } from './Sheet'
import './cardshare.css'

const COPY_LABELS = {
  id: 'Copy the id',
  title: 'Copy the title',
  trailer: 'Copy the commit trailer',
  jira: 'Copy the Jira key',
  markdown: 'Copy as Markdown',
}

/** Puts text on the clipboard, and says so. */
export async function copyText(text: string, what: string, say: (text: string) => void): Promise<void> {
  try {
    await Clipboard.write({ string: text })
    say(`Copied ${what}`)
  } catch {
    say('Couldn’t copy.')
  }
}

/** The card's id, which copies itself when tapped, as the desktop drawer's does. */
export function CopyId({ id }: { id: string }) {
  const [toast, say] = useToast()
  return (
    <>
      <button type="button" className="chip copy-id" aria-label={`Copy ${id}`} onClick={() => void copyText(id, id, say)}>
        {id}
      </button>
      {toast}
    </>
  )
}

/** The *Share* button and the sheet it opens. */
export function CardShare({ card, work, disabled }: { card: Card; work: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [toast, say] = useToast()
  const copies = cardCopies(card, work)

  async function share(markdown: boolean) {
    setOpen(false)
    try {
      await Share.share({ title: card.title, text: cardShareText(card, work, markdown), dialogTitle: 'Share the card' })
    } catch {
      // Closed without picking an app: nothing to say.
    }
  }

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        Share
      </button>
      {open && (
        <Sheet title={card.title} onClose={() => setOpen(false)}>
          <SheetItem label="Share" hint="title and description" onSelect={() => void share(false)} />
          <SheetItem label="Share as Markdown" hint={copies.find(c => c.kind === 'markdown')?.hint} onSelect={() => void share(true)} />
          <hr />
          {copies.map(item => (
            <SheetItem
              key={item.kind}
              label={COPY_LABELS[item.kind]}
              hint={item.hint}
              onSelect={() => {
                setOpen(false)
                void copyText(item.text, item.what ?? item.text, say)
              }}
            />
          ))}
        </Sheet>
      )}
      {toast}
    </>
  )
}
