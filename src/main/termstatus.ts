// What a terminal tab is doing, read from the window title its programs set. Claude Code (read
// from 2.1.289) titles the terminal "◐ <topic>" / "◑ <topic>" while it works, flipping between
// the two, and "✳ <topic>" when it stops: at its prompt, or asking something. On exit it clears
// the title (`ESC ] 0 ; BEL`), and a shell prompt may set its own. Being in-band, this works for
// a `claude` typed by hand in a shell tab too, and on every platform.

import type { TerminalStatus } from '@shared/types'

// OSC 0 (title and icon) or 2 (title), ended by BEL or ST (`ESC \`).
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// A sequence the chunk cuts off: an OSC still open (maybe up to the ESC of its ST), or a lone ESC.
const OPEN_TAIL = /\x1b(?:\][^\x07\x1b]*\x1b?)?$/
// A title longer than this is not one; dropping it keeps a stray `ESC ]` from holding output.
const MAX_CARRY = 4096

/** The titles a chunk of output sets, in order, and the unfinished sequence to read with the next chunk. */
export function scanTitles(carry: string, chunk: string): { titles: string[]; carry: string } {
  const text = carry + chunk
  if (!text.includes('\x1b')) return { titles: [], carry: '' }
  const titles = [...text.matchAll(TITLE)].map(m => m[1])
  const tail = OPEN_TAIL.exec(text)?.[0] ?? ''
  return { titles, carry: tail.length <= MAX_CARRY ? tail : '' }
}

export function statusFromTitle(title: string): TerminalStatus {
  if (title.startsWith('◐') || title.startsWith('◑')) return 'working'
  if (title.startsWith('✳')) return 'waiting'
  return 'shell'
}
