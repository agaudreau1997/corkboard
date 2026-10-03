// The shell the terminals run, per platform. A command (argv) must reach the program unchanged
// whatever it holds (a prompt has quotes, backticks and newlines), so it is never pasted into a
// shell line: bash gets it as "$@", PowerShell as a JSON array in an environment variable.

import { existsSync } from 'node:fs'
import path from 'node:path'

export const WINDOWS = process.platform === 'win32'

/** PowerShell 7 when installed: 5.1 drops the double quotes inside an argument to a program. */
function powershell(): string {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of dirs) if (dir && existsSync(path.join(dir, 'pwsh.exe'))) return path.join(dir, 'pwsh.exe')
  const standard = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  return existsSync(standard) ? standard : 'powershell.exe'
}

export type ShellLaunch = { file: string; args: string[]; env: Record<string, string> }

/**
 * An interactive shell that first runs `command` (if any) and stays open afterwards, so the tab
 * remains a usable terminal once Claude exits. Unix shells start as login shells, which is what
 * puts nvm's `claude` on the PATH when the app was started from a desktop menu.
 */
export function shellLaunch(command?: string[]): ShellLaunch {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  if (WINDOWS) {
    const file = powershell()
    if (!command) return { file, args: ['-NoLogo'], env }
    env.CORKBOARD_ARGS = JSON.stringify(command)
    const script =
      "$PSNativeCommandArgumentPassing = 'Standard'; " +
      '$a = @($env:CORKBOARD_ARGS | ConvertFrom-Json); Remove-Item Env:CORKBOARD_ARGS; ' +
      '$rest = @($a | Select-Object -Skip 1); & $a[0] @rest'
    return { file, args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', script], env }
  }
  const userShell = process.env.SHELL || '/bin/bash'
  if (!command) return { file: userShell, args: ['-l', '-i'], env }
  // bash -c 'script' name args...: the args are "$@" inside the script.
  return {
    file: '/bin/bash',
    args: ['-l', '-i', '-c', `"$@"; exec "${userShell}" -l -i`, 'corkboard', ...command],
    env,
  }
}

/** A one-off script in the same shell, for `claude --version`. */
export function shellProbe(script: { unix: string; windows: string }): { file: string; args: string[] } {
  if (WINDOWS) return { file: powershell(), args: ['-NoLogo', '-NoProfile', '-Command', script.windows] }
  return { file: '/bin/bash', args: ['-lic', script.unix] }
}
