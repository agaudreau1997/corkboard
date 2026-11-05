// Checks the packages in dist/ the way the in-app updater will read them, so a release with a
// package that can't update itself fails in CI instead of on someone's machine.
//
//   node scripts/check-packages.mjs linux|win|mac [dist folder]
//
// electron-updater finds releases through resources/app-update.yml in every package, picks the
// file to download from latest.yml / latest-linux.yml, and on Linux reads resources/package-type
// to choose between replacing the AppImage and installing the rpm with dnf. The rpm target writes
// package-type into linux-unpacked, the same folder the AppImage is made from, so an AppImage made
// after the rpm in one run would carry `rpm` and try to dnf-install itself. electron-builder 26
// builds fpm targets (the rpm) after all the others, so the AppImage comes first whatever the
// command line says; this checks it still does. On macOS Squirrel.Mac installs an update only when
// it satisfies the running app's designated requirement, which an ad-hoc signature pins to its own
// hash unless scripts/after-sign-mac.cjs replaces it: this checks every app bundle carries that one.

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

const platform = process.argv[2]
const dist = path.resolve(process.argv[3] ?? 'dist')
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
const find = pattern => readdirSync(dist).find(f => pattern.test(f))

/** The file names an update info file offers, after checking it names this version. */
function offered(name) {
  const file = path.join(dist, name)
  if (!existsSync(file)) {
    failures.push(`no ${name}`)
    return []
  }
  const info = parse(readFileSync(file, 'utf8'))
  check(info.version === version, `${name} is for ${info.version}, package.json says ${version}`)
  return (info.files ?? []).map(f => f.url)
}

if (platform === 'linux') {
  const urls = offered('latest-linux.yml')
  check(urls.some(u => u.endsWith('.AppImage')), 'latest-linux.yml lists no AppImage')
  check(urls.some(u => u.endsWith('.rpm')), 'latest-linux.yml lists no rpm')

  const appImage = find(/\.AppImage$/)
  check(appImage, 'no AppImage')
  if (appImage) {
    // An AppImage is an ELF runtime with a squashfs after it, starting where the runtime's
    // section headers end.
    const head = Buffer.alloc(64)
    const fd = openSync(path.join(dist, appImage), 'r')
    readSync(fd, head, 0, 64, 0)
    closeSync(fd)
    const offset = Number(head.readBigUInt64LE(0x28)) + head.readUInt16LE(0x3a) * head.readUInt16LE(0x3c)
    const files = execFileSync('unsquashfs', ['-o', String(offset), '-l', path.join(dist, appImage)]).toString()
    check(/\/resources\/app-update\.yml$/m.test(files), 'the AppImage has no resources/app-update.yml')
    check(!/\/resources\/package-type$/m.test(files), 'the AppImage has a resources/package-type: it would update itself with dnf')
  }

  const rpm = find(/\.rpm$/)
  check(rpm, 'no rpm')
  if (rpm) {
    const files = execFileSync('rpm', ['-qlp', path.join(dist, rpm)]).toString()
    check(/\/resources\/app-update\.yml$/m.test(files), 'the rpm has no resources/app-update.yml')
    check(/\/resources\/package-type$/m.test(files), 'the rpm has no resources/package-type')
    // Electron's files have the build ids of every other Electron app's, and dnf won't install two
    // packages that both own a link to one.
    check(!/^\/usr\/lib\/\.build-id\//m.test(files), 'the rpm has /usr/lib/.build-id links, which clash with other Electron apps')
  }
} else if (platform === 'win') {
  // GitHub gets the installer under a name without spaces, which is the one latest.yml gives.
  const urls = offered('latest.yml')
  check(urls.some(u => /setup.*\.exe$/i.test(u)), 'latest.yml lists no Setup exe')
  check(find(/^Corkboard Setup .*\.exe$/), 'no Setup exe')
  check(find(/^Corkboard \d.*\.exe$/), 'no portable exe')
  // The installer and the portable exe are both made from win-unpacked.
  check(existsSync(path.join(dist, 'win-unpacked/resources/app-update.yml')), 'win-unpacked has no resources/app-update.yml')
} else if (platform === 'mac') {
  const urls = offered('latest-mac.yml')
  check(urls.some(u => /arm64-mac\.zip$/.test(u)), 'latest-mac.yml lists no arm64 zip')
  check(urls.some(u => /\d-mac\.zip$/.test(u)), 'latest-mac.yml lists no x64 zip')
  check(find(/arm64\.dmg$/), 'no arm64 dmg')
  check(find(/\d\.dmg$/), 'no x64 dmg')
  for (const folder of ['mac-arm64', 'mac']) {
    const app = path.join(dist, folder, 'Corkboard.app')
    if (!existsSync(app)) {
      failures.push(`no ${folder}/Corkboard.app`)
      continue
    }
    check(existsSync(path.join(app, 'Contents/Resources/app-update.yml')), `${folder}/Corkboard.app has no Resources/app-update.yml`)
    // Every terminal starts through node-pty's spawn-helper (scripts/fix-spawn-helper.mjs).
    const prebuilds = path.join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds')
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const helper = path.join(prebuilds, arch, 'spawn-helper')
      check(existsSync(helper) && (statSync(helper).mode & 0o111) !== 0, `${folder}/Corkboard.app's ${arch}/spawn-helper isn't executable: no terminal would open`)
    }
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
    } catch (error) {
      failures.push(`${folder}/Corkboard.app fails codesign --verify: ${error.stderr}`)
    }
    // codesign prints the requirement on stdout or stderr depending on the macOS version.
    const shown = execFileSync('sh', ['-c', 'codesign -d -r- "$1" 2>&1', 'sh', app]).toString()
    check(/designated => identifier "com\.corkboard\.app"/.test(shown), `${folder}/Corkboard.app's designated requirement isn't the bundle id: no update would install`)
  }
} else {
  console.error('usage: node scripts/check-packages.mjs linux|win|mac [dist folder]')
  process.exit(2)
}

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`)
  process.exit(1)
}
console.log(`✓ ${platform} packages for ${version} carry what the updater reads`)
