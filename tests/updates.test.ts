// Which copies update themselves, and an update's install against a stand-in for electron-updater.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/types'
import { releasesPage, updateMode, type Installation, type Updater, Updates } from '../src/main/updates'

const RELEASES = 'https://github.com/someone/corkboard/releases'

function installation(patch: Partial<Installation>): Installation {
  return {
    packaged: true,
    platform: 'linux',
    env: {},
    releases: RELEASES,
    rpmOwned: () => false,
    nsisInstalled: () => false,
    ...patch,
  }
}

describe('updateMode', () => {
  it('stays off in development, under the test switch and without a feed', () => {
    expect(updateMode(installation({ packaged: false, env: { APPIMAGE: '/a' } })).kind).toBe('off')
    expect(updateMode(installation({ env: { APPIMAGE: '/a', CORKBOARD_UPDATES: '0' } })).kind).toBe('off')
    expect(updateMode(installation({ releases: undefined, env: { APPIMAGE: '/a' } })).kind).toBe('off')
  })

  it('updates an AppImage and an rpm install, not the build folder the rpm is made from', () => {
    expect(updateMode(installation({ env: { APPIMAGE: '/home/me/Corkboard.AppImage' } }))).toEqual({ kind: 'install', releases: RELEASES })
    expect(updateMode(installation({ packageType: 'rpm', rpmOwned: () => true })).kind).toBe('install')
    // dist/linux-unpacked carries the rpm's package-type too, but no package owns it.
    expect(updateMode(installation({ packageType: 'rpm' })).kind).toBe('off')
    expect(updateMode(installation({})).kind).toBe('off')
  })

  it('updates the installed exe, only announces to the portable one, leaves the build folder', () => {
    const win = { platform: 'win32' as const }
    expect(updateMode(installation({ ...win, nsisInstalled: () => true })).kind).toBe('install')
    // The portable exe is made from the same folder as the installer, feed and all.
    expect(updateMode(installation({ ...win, env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Corkboard.exe' } })).kind).toBe('notify')
    expect(updateMode(installation(win)).kind).toBe('off')
  })
})

describe('releasesPage', () => {
  it('reads a GitHub feed, and nothing else', () => {
    expect(releasesPage('owner: someone\nrepo: corkboard\nprovider: github\nreleaseType: draft\n')).toBe(RELEASES)
    expect(releasesPage('provider: generic\nurl: https://example.com\n')).toBeUndefined()
    expect(releasesPage('{ not yaml')).toBeUndefined()
    expect(releasesPage(undefined)).toBeUndefined()
  })
})

/** electron-updater's events and the two calls the app makes, recorded in `calls`. */
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  calls: string[] = []
  installFails = false
  async checkForUpdates() {
    this.calls.push('check')
    return null
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.calls.push(`quitAndInstall(${isSilent}, ${isForceRunAfter})`)
    // As the rpm's dnf does when its password prompt is dismissed: an error, and no quit.
    if (this.installFails) this.emit('error', new Error('pkexec: dismissed'))
  }
}

function setup(notifyOnly = false) {
  const updater = new FakeUpdater()
  const statuses: UpdateStatus[] = []
  const updates = new Updates(updater as unknown as Updater, {
    current: '0.2.0',
    releases: RELEASES,
    notifyOnly,
    prepareQuit: async () => {
      updater.calls.push('prepareQuit started')
      await new Promise(r => setTimeout(r, 20))
      updater.calls.push('prepareQuit done')
    },
    relaunch: () => updater.calls.push('relaunch'),
    onStatus: s => statuses.push(s),
  })
  return { updater, updates, statuses }
}

describe('Updates', () => {
  it('shows a newer release downloading, then ready, with its release page', () => {
    const { updater, updates } = setup()
    expect(updater.autoDownload && updater.autoInstallOnAppQuit).toBe(true)
    updater.emit('update-available', { version: '0.2.1' })
    expect(updates.status).toMatchObject({ state: 'downloading', version: '0.2.1', percent: 0 })
    updater.emit('download-progress', { percent: 42.7 })
    expect(updates.status.percent).toBe(42)
    updater.emit('update-downloaded', { version: '0.2.1' })
    expect(updates.status).toMatchObject({ state: 'ready', version: '0.2.1', page: `${RELEASES}/tag/v0.2.1` })
  })

  it('says up to date, and keeps an error until the next check', () => {
    const { updater, updates } = setup()
    expect(updates.status.page).toBe(`${RELEASES}/tag/v0.2.0`)
    updater.emit('error', new Error('HttpError: 406 \n"method: GET url: …"\nHeaders: {…}'))
    expect(updates.status).toMatchObject({ state: 'error', message: 'HttpError: 406' })
    updater.emit('checking-for-update')
    updater.emit('update-not-available', { version: '0.2.0' })
    expect(updates.status.state).toBe('current')
    expect(updates.status.message).toBeUndefined()
  })

  it('only announces a newer version to the portable exe', () => {
    const { updater, updates } = setup(true)
    expect(updater.autoDownload || updater.autoInstallOnAppQuit).toBe(false)
    updater.emit('update-available', { version: '0.2.1' })
    expect(updates.status).toMatchObject({ state: 'available', version: '0.2.1', notifyOnly: true })
  })

  it('does not check again while an update downloads or waits', async () => {
    const { updater, updates } = setup()
    await updates.check()
    updater.emit('update-available', { version: '0.2.1' })
    await updates.check()
    updater.emit('update-downloaded', { version: '0.2.1' })
    await updates.check()
    expect(updater.calls).toEqual(['check'])
  })

  it('installs only after the quit-time sync, silently, starting the new version', async () => {
    const { updater, updates, statuses } = setup()
    await updates.install()
    expect(updater.calls).toEqual([])
    updater.emit('update-downloaded', { version: '0.2.1' })
    await updates.install()
    expect(updater.calls).toEqual(['prepareQuit started', 'prepareQuit done', 'quitAndInstall(true, true)'])
    expect(statuses.at(-1)?.state).toBe('installing')
  })

  it('starts the app again when the install fails after the quit-time work', async () => {
    const { updater, updates } = setup()
    updater.installFails = true
    updater.emit('update-downloaded', { version: '0.2.1' })
    await updates.install()
    expect(updater.calls.slice(-2)).toEqual(['quitAndInstall(true, true)', 'relaunch'])
  })
})
