// The shell the terminals run, per platform. A command (argv) must reach the program unchanged
// whatever it holds (a prompt has quotes, backticks and newlines), so it is never pasted into a
// shell line: bash gets it as "$@", PowerShell as a JSON array in an environment variable.
//
// PowerShell before 7.3 (Windows PowerShell 5.1 among them) puts an argument on a program's command
// line as it is, in double quotes if it has whitespace, so a quote inside it ends the quoting and
// vanishes. It is given the arguments escaped for that (legacyArg) instead, and they come out
// right whether the command is a program or a .ps1 that passes its arguments on to one, as npm's
// `claude.ps1` does.

import { existsSync } from 'node:fs'
import path from 'node:path'

export const WINDOWS = process.platform === 'win32'

/** PowerShell 7 when installed: it passes arguments to a program as they are, with no escaping. */
function powershell(): string {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of dirs) if (dir && existsSync(path.join(dir, 'pwsh.exe'))) return path.join(dir, 'pwsh.exe')
  const standard = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  return existsSync(standard) ? standard : 'powershell.exe'
}

/**
 * An argument escaped so that PowerShell before 7.3 hands it to a program intact. It quotes an
 * argument only when it sees whitespace outside double quotes, and it counts escaped quotes too: an
 * argument whose every space follows an odd number of quotes (`"Ideas list`) still comes apart.
 * Corkboard's never do; each starts with a word and a space, or has no quote at all.
 */
export function legacyArg(arg: string): string {
  if (!arg) return '""'
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"')
  const quoted = /^(?:[^"]*"[^"]*")*[^"]*\s/.test(escaped)
  return quoted ? escaped.replace(/(\\+)$/, '$1$1') : escaped
}

// Runs CORKBOARD_ARGS as a command. ConvertFrom-Json in 5.1 writes an array out as one object,
// which @() would wrap whole, so ForEach-Object unrolls it into its strings.
const RUN_ARGS =
  '$v = $PSVersionTable.PSVersion; ' +
  "if ($v.Major -gt 7 -or ($v.Major -eq 7 -and $v.Minor -ge 3)) { $PSNativeCommandArgumentPassing = 'Standard'; $j = $env:CORKBOARD_ARGS } " +
  "else { $PSNativeCommandArgumentPassing = 'Legacy'; $j = $env:CORKBOARD_ARGS_LEGACY }; " +
  'Remove-Item Env:CORKBOARD_ARGS, Env:CORKBOARD_ARGS_LEGACY; ' +
  '$a = @($j | ConvertFrom-Json | ForEach-Object { $_ }); $rest = @($a | Select-Object -Skip 1); & $a[0] @rest'

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
    // Both forms: which one is wanted depends on the PowerShell that runs, and pwsh may be any version.
    env.CORKBOARD_ARGS = JSON.stringify(command)
    env.CORKBOARD_ARGS_LEGACY = JSON.stringify([command[0], ...command.slice(1).map(legacyArg)])
    return { file, args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', RUN_ARGS], env }
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
