// Checks the packages in dist/ the way the in-app updater will read them, so a release with a
// package that can't update itself fails in CI instead of on someone's machine.
//
//   node scripts/check-packages.mjs linux|win [dist folder]
//
// electron-updater finds releases through resources/app-update.yml in every package, picks the
// file to download from latest.yml / latest-linux.yml, and on Linux reads resources/package-type
// to choose between replacing the AppImage and installing the rpm with dnf. The rpm target writes
// package-type into linux-unpacked, the same folder the AppImage is made from, so an AppImage made
// after the rpm in one run would carry `rpm` and try to dnf-install itself. electron-builder 26
// builds fpm targets (the rpm) after all the others, so the AppImage comes first whatever the
// command line says; this checks it still does.

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
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
} else {
  console.error('usage: node scripts/check-packages.mjs linux|win [dist folder]')
  process.exit(2)
}

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`)
  process.exit(1)
}
console.log(`✓ ${platform} packages for ${version} carry what the updater reads`)
