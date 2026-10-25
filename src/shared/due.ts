// A card's `due` key: a date (`2026-11-02`), as the drawer writes it, or a full time a person or a
// Claude session wrote by hand, which is kept as it is. A date is past once the next day has begun
// where the app runs, so a card due today is not late yet; a time is past once it has gone by.

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The date part of a due value, as a date input and the card's face show it. */
export function dueDay(due: string): string {
  return due.slice(0, 10)
}

/** Today's date, `2026-11-02`, in the local time zone. */
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Whether a card due then is late: past, and not done (complete, or in the board's done list). */
export function isOverdue(due: string | undefined, done: boolean, now = new Date()): boolean {
  if (!due || done) return false
  if (DAY.test(due)) return localDay(now) > due
  const at = Date.parse(due)
  return !Number.isNaN(at) && at < now.getTime()
}
