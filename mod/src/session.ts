// What a session knows about itself: the cards Corkboard started it for, the board they are on,
// where that board's folder is, the prefix every card id of that board carries, and whether the
// project is a work one. The app puts all of it in the terminal's environment (`sessionEnv` in
// `src/main/tackle.ts`), for a new session and a resumed one alike.
//
// The plugin API has no way to read an environment variable — there is no `$.process.env`, and a
// hooks module has no Node — so the one way in is a host command that prints them, which the
// session.start hook runs once. Everything here is pure: the hook runs the command and hands the
// output back.

export const CARDS_VAR = 'CORKBOARD_CARDS'
export const BOARD_VAR = 'CORKBOARD_BOARD'
export const BOARD_DIR_VAR = 'CORKBOARD_BOARD_DIR'
export const PREFIX_VAR = 'CORKBOARD_CARD_PREFIX'
export const WORK_VAR = 'CORKBOARD_WORK'

/** The variables the mod reads, in the order the printing command writes them. */
export const SESSION_VARS = [CARDS_VAR, BOARD_VAR, BOARD_DIR_VAR, PREFIX_VAR, WORK_VAR] as const

/** The cards a session holds, and the board they came from. */
export type SessionCards = {
  /** The card ids, in the order the tackle worked them. */
  cards: string[]
  /** The board's key in the app, `<project id>:<path>`: what the board tools take. */
  board: string
  /** The board's folder on this machine, which holds its `cards/`. */
  boardDir: string
  /** The prefix every card id of that board starts with, `CORK` for `CORK-142`. */
  prefix: string
  /** A work project: no card id may reach the code repo. */
  work: boolean
}

/**
 * The host commands that print the variables, one per line, in `SESSION_VARS` order: a POSIX
 * shell first, then `cmd.exe` for a Windows machine with no `sh` on its PATH. The hook runs them
 * in turn and keeps the first that exits 0.
 */
export function envCommands(vars: readonly string[] = SESSION_VARS): string[][] {
  return [
    ['sh', '-c', `printf '%s\\n' ${vars.map(v => `"$${v}"`).join(' ')}`],
    ['cmd', '/c', vars.map(v => `echo %${v}%`).join('& ')],
  ]
}

/** The values of `vars` out of such a command's output, one per line. */
export function parseEnv(stdout: string, vars: readonly string[] = SESSION_VARS): Record<string, string> {
  const lines = stdout.replace(/\r/g, '').split('\n')
  const env: Record<string, string> = {}
  vars.forEach((name, i) => {
    const value = (lines[i] ?? '').trim()
    // cmd.exe echoes `%NAME%` back when there is no such variable.
    env[name] = value === `%${name}%` ? '' : value
  })
  return env
}

/** The session the environment describes; no cards at all when the app didn't start it. */
export function sessionFromEnv(env: Record<string, string>): SessionCards {
  return {
    cards: (env[CARDS_VAR] ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
    board: (env[BOARD_VAR] ?? '').trim(),
    boardDir: (env[BOARD_DIR_VAR] ?? '').trim(),
    prefix: (env[PREFIX_VAR] ?? '').trim(),
    work: (env[WORK_VAR] ?? '').trim() === '1',
  }
}

/** One line for the log and the status row: which cards this session holds. */
export function describeSession(session: SessionCards): string {
  if (!session.cards.length) return 'no cards: Corkboard did not start this session'
  const where = session.board ? ` on ${session.board}` : ''
  return `${session.cards.join(', ')}${where}${session.work ? ' (work mode)' : ''}`
}
