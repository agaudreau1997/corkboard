// Where the companion mod lives, so a tackle can hand it to the session it starts.
//
// The mod is the `mod/` folder of this repo (its own manifest, hooks module and helpers), and a
// packaged build ships it beside the app as `resources/mod` (electron-builder's
// `extraResources`). A build without it hands out nothing and the sessions are as they were
// before the mod existed, which is also what `CORKBOARD_MOD_DIR=` (empty) asks for.

import { existsSync } from 'node:fs'
import path from 'node:path'

/** The mod's name in its manifest: the prefix of any tool it registers, too. */
export const MOD_NAME = 'corkboard-mod'

/** Test seam: the folder to hand out instead, or empty for none. */
const SEAM = 'CORKBOARD_MOD_DIR'

/**
 * The mod's folder, or undefined when this build has none. `appPath` is the app's own folder
 * (the repo, when it runs from the source) and `resourcesPath` the packaged app's resources.
 */
export function modDir(opts: {
  packaged: boolean
  appPath: string
  resourcesPath: string
  env?: Record<string, string | undefined>
}): string | undefined {
  const seam = (opts.env ?? process.env)[SEAM]
  if (seam !== undefined) return seam && existsSync(seam) ? seam : undefined
  const dir = opts.packaged ? path.join(opts.resourcesPath, 'mod') : path.join(opts.appPath, 'mod')
  return existsSync(dir) ? dir : undefined
}
