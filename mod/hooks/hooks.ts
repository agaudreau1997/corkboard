// Corkboard's companion mod: the hooks module Claude Code loads for the sessions the app starts
// (`--plugin-dir`, from `src/main/tackle.ts`). It works out which cards its session was started
// for and says so; the card pane, the `/card` commands and the commit guard are built on that.
//
// Every hook is written to fail safe. The plugin API is early access and moves between Claude
// Code releases, so a call that isn't there, a shell that won't run and a board the app no longer
// serves all end the same way: the hook calls `next` and the session goes on exactly as it would
// without the mod.

import type { On } from '../src/engine'
import { describeSession, envCommands, parseEnv, sessionFromEnv } from '../src/session'

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    try {
      for (const argv of envCommands()) {
        const run = await $.process.run(argv).catch(() => undefined)
        if (!run || run.exitCode !== 0) continue
        const session = sessionFromEnv(parseEnv(run.stdout))
        await $.ui.log(`corkboard: ${describeSession(session)}`)
        if (session.cards.length) await $.ui.status(`▣ ${session.cards.join(' ')}`)
        return next(e)
      }
      await $.ui.log('corkboard: no shell answered, so this session knows no cards')
    } catch {
      // A mod that cannot tell its cards leaves the session as it is.
    }
    return next(e)
  })
}
