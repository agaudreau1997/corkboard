// Corkboard's own updates: electron-updater reads the GitHub releases CI publishes (the feed in
// resources/app-update.yml, written by electron-builder), downloads a newer version in the
// background, and installs it at the next quit or on *Restart to update*.
//
// How a copy updates depends on how it was installed. The Setup exe's install runs the new
// installer silently; an AppImage is replaced where it lies ($APPIMAGE); an rpm install hands the new
// rpm to dnf behind a pkexec password prompt, so dnf still tracks the package. The portable exe can't
// update itself, and since it is made from the same folder as the installer it carries the feed
// too and would run the installer: it only says a newer version is out. A copy run from the build
// folders (dist/win-unpacked, dist/linux-unpacked, which also holds the rpm's package-type) or in
// development never looks.
//
// quitAndInstall starts the install before it quits (on Linux, the AppImage copy or dnf runs
// right there), so the quit-time work, stopping the terminals and committing and pushing the board
// repos, runs first: install() waits for it.

import type { AppUpdater } from 'electron-updater'
import YAML from 'yaml'
import type { UpdateStatus } from '@shared/types'

export type UpdateMode = { kind: 'install' | 'notify'; releases: string } | { kind: 'off'; why: string }

/** What decides whether this copy updates itself; the checks that cost something are lazy. */
export type Installation = {
  packaged: boolean
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** The releases page the build's update feed names; none when it names none. */
  releases?: string
  /** resources/package-type, which the rpm writes. */
  packageType?: string
  /** Whether the rpm database owns the running executable: it was installed from the rpm. */
  rpmOwned: () => boolean
  /** Whether the NSIS uninstaller sits beside the executable: the Setup exe installed it. */
  nsisInstalled: () => boolean
}

export function updateMode(i: Installation): UpdateMode {
  const off = (why: string): UpdateMode => ({ kind: 'off', why })
  if (!i.packaged) return off('a development build')
  if (i.env.CORKBOARD_UPDATES === '0') return off('CORKBOARD_UPDATES=0')
  if (!i.releases) return off('this build names no releases to update from')
  const on = (kind: 'install' | 'notify'): UpdateMode => ({ kind, releases: i.releases! })
  if (i.platform === 'win32') {
    if (i.env.PORTABLE_EXECUTABLE_FILE) return on('notify')
    return i.nsisInstalled() ? on('install') : off('not installed by the Setup exe (a build folder)')
  }
  if (i.platform === 'linux') {
    if (i.env.APPIMAGE) return on('install')
    if (i.packageType === 'rpm' && i.rpmOwned()) return on('install')
    return off('neither an AppImage nor installed from the rpm (a build folder)')
  }
  return off(`no updates on ${i.platform}`)
}

/** The releases page of a GitHub update feed (app-update.yml); undefined for any other. */
export function releasesPage(feed: string | undefined): string | undefined {
  if (!feed) return undefined
  try {
    const config = YAML.parse(feed) as { provider?: string; owner?: string; repo?: string }
    if (config?.provider !== 'github' || !config.owner || !config.repo) return undefined
    return `https://github.com/${config.owner}/${config.repo}/releases`
  } catch {
    return undefined
  }
}

export type Updater = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'checkForUpdates' | 'quitAndInstall' | 'on' | 'off'>

type Options = {
  current: string
  releases: string
  /** The portable exe: look, but neither download nor install. */
  notifyOnly: boolean
  /** Stops the terminals and commits and pushes the board repos, as a quit does first. */
  prepareQuit: () => Promise<void>
  /** Starts the app again: what is left after an install that failed once the quit work was done. */
  relaunch: () => void
  onStatus: (status: UpdateStatus) => void
}

export class Updates {
  status: UpdateStatus
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private updater: Updater,
    private opts: Options,
  ) {
    this.status = this.withPage({ current: opts.current, state: 'checking', notifyOnly: opts.notifyOnly || undefined })
    updater.autoDownload = !opts.notifyOnly
    updater.autoInstallOnAppQuit = !opts.notifyOnly
    updater.on('checking-for-update', () => this.set({ state: 'checking' }))
    updater.on('update-not-available', () => this.set({ state: 'current', version: undefined, percent: undefined }))
    updater.on('update-available', info =>
      this.set({ state: opts.notifyOnly ? 'available' : 'downloading', version: info.version, percent: 0 }),
    )
    updater.on('download-progress', progress => this.set({ state: 'downloading', percent: Math.floor(progress.percent) }))
    updater.on('update-downloaded', info => this.set({ state: 'ready', version: info.version, percent: undefined }))
    // electron-updater's messages go on with the response's headers and body: the first line says it.
    updater.on('error', error => this.set({ state: 'error', message: error.message.split('\n')[0].trim().slice(0, 300) }))
  }

  /** Checks now and every `everyMs`. */
  start(everyMs: number): void {
    void this.check()
    this.timer = setInterval(() => void this.check(), everyMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  /** Looks for a newer release, unless one is already on its way or waiting to be installed. */
  async check(): Promise<void> {
    if (['downloading', 'ready', 'installing'].includes(this.status.state)) return
    // A failure also comes as an `error` event, which the status shows.
    await this.updater.checkForUpdates().catch(() => undefined)
  }

  /** Does the quit-time work, then installs the downloaded update and starts the new version. */
  async install(): Promise<void> {
    if (this.status.state !== 'ready') return
    this.set({ state: 'installing' })
    await this.opts.prepareQuit()
    // The AppImage copy and dnf run inside quitAndInstall, and report a failure (a password
    // prompt dismissed) as an error before it returns, without quitting.
    let failed = false
    const onError = () => {
      failed = true
    }
    this.updater.on('error', onError)
    try {
      this.updater.quitAndInstall(true, true)
    } catch {
      failed = true
    } finally {
      this.updater.off('error', onError)
    }
    // The board repos are closed by now: start again, on the version still installed.
    if (failed) this.opts.relaunch()
  }

  private set(patch: Partial<UpdateStatus>): void {
    const next = { ...this.status, ...patch }
    if (next.state !== 'error') delete next.message
    this.status = this.withPage(next)
    this.opts.onStatus(this.status)
  }

  private withPage(status: UpdateStatus): UpdateStatus {
    return { ...status, page: `${this.opts.releases}/tag/v${status.version ?? status.current}` }
  }
}
