// node-pty 1.1.0's npm package ships its macOS spawn-helper without the execute bit, and on macOS
// every terminal starts through it: without the bit, opening a terminal or tackling a card in one
// fails with "posix_spawnp failed". npm install runs this (postinstall), so a run from the source and
// the Mac packages, which copy the file as it is, both get a helper that runs. Windows and Linux
// don't use these files.

import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = path.join(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/node-pty/prebuilds')
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = path.join(prebuilds, arch, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
