// electron-builder's afterSign hook: signs the ad-hoc-signed Mac app bundle once more, by itself,
// with a designated requirement naming its bundle id.
//
// Squirrel.Mac installs an update only when it satisfies the running app's designated requirement,
// and an ad-hoc signature's own is its hash, which no newer build matches. electron-builder's
// `requirements` option can't fix that: it hands the requirement to every nested helper and
// framework too, whose ids differ, and the bundle then fails verification. Only the outer bundle
// is signed here (no --deep), keeping the nested signatures and the entitlements. A build signed
// with a real certificate (CSC_LINK / CSC_NAME, no `identity: "-"`) has a stable requirement already
// and is left as it is.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (context.packager.platformSpecificBuildOptions.identity !== '-') return
  const { id, productFilename } = context.packager.appInfo
  const app = path.join(context.appOutDir, `${productFilename}.app`)
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--preserve-metadata=entitlements', `-r=designated => identifier "${id}"`, app],
    { stdio: 'inherit' },
  )
}
