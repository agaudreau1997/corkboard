// Takes the README's and the docs' screenshots, into docs/images/, so they can be taken again when
// the window changes:
//
//   npm run screenshots          (builds first; `node tests/e2e/screenshots.mjs` reuses the build)
//
// It drives the built app the way the end-to-end test does, on the same made-up board repo
// (fixture.mjs), never a real one: a few more cards, commits and sessions are written into a
// scratch copy so the board looks worked on, and `claude` is a stand-in that only sets the
// terminal titles Claude Code sets and prints a few lines, so nothing real is started or billed.
// The terminals' shell gets a scratch home with a bare prompt, so no one's own shell setup, home
// folder or user name shows in a picture.
//
// SHOT_DIR writes them elsewhere (to compare before replacing them).

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { COMMITTED, IDEAS, MAIN, TO_FIX, writeFixture } from './fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '../..')
const shots = process.env.SHOT_DIR ?? path.join(appDir, 'docs/images')
mkdirSync(shots, { recursive: true })

const scratch = mkdtempSync(path.join(os.tmpdir(), 'corkboard-shots-'))
// The folder's name is the project's name in the side panel.
const root = path.join(scratch, 'moon-base')
const codeRepo = path.join(scratch, 'moon-base-game')
const home = path.join(scratch, 'home')
const gitIdentity = { GIT_AUTHOR_NAME: 'Sam Rivera', GIT_AUTHOR_EMAIL: 'sam@example.com', GIT_COMMITTER_NAME: 'Sam Rivera', GIT_COMMITTER_EMAIL: 'sam@example.com' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...gitIdentity } }).toString()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const minutesAgo = m => new Date(Date.now() - m * 60_000).toISOString()

// ---- the board repo: the fixture, with a few cards that are being worked on ----

/** The cards the pictures centre on: in Doing and Next up, which the fixture leaves empty. */
const SHOWN = {
  headlights: 'MB-301',
  oxygen: 'MB-302',
  footsteps: 'MB-303',
  pause: 'MB-304',
  quit: 'MB-305',
}

function cardFile({ id, title, list, pos, body = '', links = [], sessions = [], updated }) {
  const lines = ['---', `id: ${id}`, `title: ${JSON.stringify(title)}`, `list: ${list}`, `pos: ${pos}`, `created: ${minutesAgo(60 * 24 * 6)}`, `updated: ${updated}`]
  if (links.length) lines.push('links:', ...links.map(l => `  - ${l}`))
  if (sessions.length) {
    lines.push('sessions:')
    for (const s of sessions) {
      const entries = Object.entries(s)
      lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`, ...entries.slice(1).map(([k, v]) => (Array.isArray(v) ? `    ${k}:\n${v.map(x => `      - ${x}`).join('\n')}` : `    ${k}: ${JSON.stringify(v)}`)))
    }
  }
  lines.push('---', '')
  return `${lines.join('\n')}${body ? `\n${body}\n` : ''}`
}

/** Adds a card's front-matter line before the closing `---`. */
function addFront(file, text) {
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n---\n/, `\n${text}\n---\n`))
}

function dressBoards() {
  const cards = path.join(root, MAIN.path, 'cards')
  const write = card => writeFileSync(path.join(cards, `${card.id}.md`), cardFile(card))
  write({
    id: SHOWN.headlights,
    title: 'Rover headlights flicker inside the hangar',
    list: 'doing',
    pos: 1024,
    updated: minutesAgo(12),
    links: [TO_FIX],
    body: [
      'The lights flicker whenever the rover is parked under the hangar roof, and only there.',
      '',
      '- Likely the light probe the hangar swaps in: check its update rate',
      '- Keep the fix out of the night cycle, which uses the same lights',
    ].join('\n'),
    sessions: [
      { id: '6f1c2d4e-0a7b-4c51-9e3f-2b8d7a6c5e41', kind: 'local', started: minutesAgo(60 * 26), cwd: codeRepo, cards: [SHOWN.headlights], name: `${SHOWN.headlights} Rover headlights flicker inside the hangar`, purpose: 'discuss' },
      { id: '9a4e7b21-3c6d-4f80-8b12-5d9e0f1a2c37', kind: 'local-worktree', started: minutesAgo(95), cwd: codeRepo, cards: [SHOWN.headlights], name: `${SHOWN.headlights} Rover headlights flicker inside the hangar` },
    ],
  })
  write({ id: SHOWN.oxygen, title: 'The oxygen meter reads empty after loading a save', list: 'doing', pos: 2048, updated: minutesAgo(30), body: 'Reload any save made outside: the meter shows 0 until the first breath.' })
  write({ id: SHOWN.footsteps, title: 'Footsteps on the metal floors', list: 'next', pos: 1024, updated: minutesAgo(200) })
  write({ id: SHOWN.pause, title: 'Pause menu that keeps the game running in co-op', list: 'next', pos: 2048, updated: minutesAgo(210), links: [SHOWN.quit] })
  write({ id: SHOWN.quit, title: "Save the rover's position on quit", list: 'next', pos: 3072, updated: minutesAgo(220) })

  // A few lines between ideas, so the map shows links.
  const ideas = path.join(root, IDEAS.path, 'cards')
  for (const [from, to] of [
    ['IDEA-2', ['IDEA-13', 'IDEA-22']],
    ['IDEA-22', ['IDEA-30']],
    ['IDEA-30', ['IDEA-36']],
  ])
    addFront(path.join(ideas, `${from}.md`), `links:\n${to.map(id => `  - ${id}`).join('\n')}`)

  // The board guide is there, so the side panel doesn't offer one.
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Moon base boards\n\nCards are `cards/<ID>.md`: YAML front matter, then the description.\n')
}

mkdirSync(root)
git(root, 'init', '-q', '-b', 'main')
writeFixture(root)
dressBoards()
const mainMeta = JSON.parse(readFileSync(path.join(root, MAIN.path, 'board.json'), 'utf8'))
mainMeta.codeRepo = codeRepo
writeFileSync(path.join(root, MAIN.path, 'board.json'), `${JSON.stringify(mainMeta, null, 2)}\n`)
git(root, 'add', '-A')
git(root, 'commit', '-q', '-m', 'The Moon base boards')

// ---- the code repo: commits whose trailers name cards, touching files the drawer lists ----

mkdirSync(codeRepo)
git(codeRepo, 'init', '-q', '-b', 'main')
const commit = (files, message) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(codeRepo, name)), { recursive: true })
    writeFileSync(path.join(codeRepo, name), text)
  }
  git(codeRepo, 'add', '-A')
  git(codeRepo, 'commit', '-q', '-m', message)
}
commit({ 'README.md': '# Moon base\n', 'src/rover/rover.gd': 'extends Node3D\n' }, 'Start the rover scene')
commit({ 'src/audio/drill.gd': 'extends AudioStreamPlayer3D\n' }, `Give the drill a sound of its own\n\nCard: ${COMMITTED}`)
commit(
  { 'src/rover/headlights.gd': 'extends SpotLight3D\n# Hold the light still under a roof.\n', 'src/hangar/light_probe.gd': 'extends ReflectionProbe\n' },
  `Update the hangar's light probe once, not every frame\n\nThe probe re-baked each frame and the headlights flickered with it.\n\nCard: ${SHOWN.headlights}`,
)
commit({ 'tests/test_headlights.gd': 'extends GutTest\n' }, `Test the headlights under the hangar roof\n\nCard: ${SHOWN.headlights}`)

// ---- the stand-in for claude, and a shell with nothing personal in it ----

// Answers --version like Claude Code, then plays a session: Claude Code's terminal titles (◐/◑
// while it works, ✳ when it waits) and a few lines of work. A tackle in a worktree or a resumed
// session finishes its turn after a moment; any other keeps working; a cloud one prints its URL.
const fakeScript = path.join(scratch, 'fake-claude.mjs')
writeFileSync(
  fakeScript,
  [
    'const argv = process.argv.slice(2)',
    "if (argv[0] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0) }",
    "const title = t => process.stdout.write('\\x1b]0;' + t + '\\x07')",
    "if (argv[0] === '--cloud') { console.log('Created https://claude.ai/code/session_moonbase'); process.exit(0) }",
    "const name = argv[argv.indexOf('-n') + 1] ?? 'Claude Code'",
    "const id = argv.includes('-n') ? name.split(' ')[0] : 'the card'",
    "const lines = argv.includes('--resume')",
    "  ? ['Resumed. Back on ' + id + ': the probe fix is in, the test passes.', '', 'Next: the night cycle, which uses the same lights. Go ahead?']",
    "  : ['Reading the card ' + id + ' and the code it names.', '', '  read   cards/' + id + '.md', '  read   src/hud/oxygen_meter.gd', '  search \"load_game\" in src/', '', 'The meter is filled before the save restores the tank: moving it after load_game().']",
    "const wait = argv.includes('-w') || argv.includes('--resume')",
    'let frame = 0',
    "const spin = setInterval(() => title((frame++ % 2 ? '\\u25d1 ' : '\\u25d0 ') + name), 250)",
    'lines.forEach((l, i) => setTimeout(() => console.log(l), 150 * i))',
    "if (wait) setTimeout(() => { clearInterval(spin); title('\\u2733 ' + name) }, 1500)",
    "process.stdin.on('data', () => {})",
    'setInterval(() => {}, 1 << 30)',
    '',
  ].join('\n'),
)
const fakeClaude = path.join(scratch, 'claude')
writeFileSync(fakeClaude, `#!/bin/bash\nexec '${process.execPath}' '${fakeScript}' "$@"\n`)
chmodSync(fakeClaude, 0o755)
mkdirSync(home)
const prompt = `PS1='\\W $ '\n`
writeFileSync(path.join(home, '.bashrc'), prompt)
writeFileSync(path.join(home, '.bash_profile'), `. ~/.bashrc\n`)

const app = await electron.launch({
  args: [appDir],
  cwd: appDir,
  env: {
    ...process.env,
    HOME: home,
    SHELL: '/bin/bash',
    CORKBOARD_ROOT: root,
    CORKBOARD_USER_DATA: path.join(scratch, 'profile'),
    CORKBOARD_HIDDEN: '1',
    CORKBOARD_SYNC_INTERVAL_MS: '0',
    CORKBOARD_CLAUDE_BIN: fakeClaude,
    CORKBOARD_OPEN_URL_LOG: path.join(scratch, 'opened-urls.txt'),
    CORKBOARD_DESKTOP_SESSIONS_DIR: path.join(scratch, 'desktop-sessions'),
    CORKBOARD_CLAUDE_PROJECTS_DIR: path.join(scratch, 'claude-projects'),
    CORKBOARD_UPDATES: '0',
    ...gitIdentity,
  },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
const shot = async (name, clip) => {
  await sleep(400)
  await page.screenshot({ path: path.join(shots, `${name}.png`), ...(clip ? { clip } : {}) })
  console.log(`${name}.png`)
}
const tab = boardPath => page.locator(`.tab[title$=":${boardPath}"]`).first()
const openCard = async id => {
  await page.locator(`.card[data-card="${id}"]`).first().click()
  await page.locator('.drawer .card-id', { hasText: id }).waitFor()
}

let failed = false
try {
  await page.getByRole('treeitem').first().waitFor()
  await page.locator('.tree-row', { hasText: MAIN.title }).first().locator('.twisty').click()
  await page.locator('.tree-row', { hasText: MAIN.title }).first().click()
  await page.locator('.column').first().waitFor()

  // The board, as it opens.
  await shot('board')

  // The map of the ideas board, laid out list by list.
  await page.locator('.tree-row', { hasText: IDEAS.title }).click()
  await page.getByRole('tab', { name: 'Map' }).click()
  await page.locator('.map-node').first().waitFor()
  await sleep(600)
  await shot('map')

  // The card drawer: its links, its commits and its sessions.
  await tab(MAIN.path).click()
  await openCard(SHOWN.headlights)
  await page.locator('.drawer .commits li').nth(1).waitFor()
  await shot('drawer')

  // Sessions in the terminal panel: a worktree tackle and a resumed session that wait for you, a
  // cloud one, and a tackle still working, in front.
  await openCard(SHOWN.footsteps)
  await page.locator('.drawer').getByRole('button', { name: 'Worktree', exact: true }).click()
  await page.locator('.terminal-tab').first().waitFor()
  await openCard(SHOWN.headlights)
  await page.locator('.drawer .sessions li', { hasText: 'Worktree' }).getByRole('button', { name: 'Resume' }).click()
  await openCard(SHOWN.pause)
  await page.locator('.drawer').getByRole('button', { name: 'Cloud', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start cloud session' }).click()
  await openCard(SHOWN.oxygen)
  await page.locator('.drawer').getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('.terminal-tab').nth(3).waitFor()
  await page.mouse.move(700, 450)
  await page.locator('.kanban').evaluate(el => (el.scrollLeft = 0))
  // The waiting ones finish their turn while another tab is in front, so they stand out.
  await sleep(2500)

  // The front page's picture: the board, a card open, its sessions running below.
  await openCard(SHOWN.headlights)
  await page.locator('.kanban').evaluate(el => (el.scrollLeft = 0))
  await shot('hero')

  // The terminal panel alone.
  await page.locator('.drawer').getByRole('button', { name: 'Close' }).click()
  await page.mouse.move(700, 300)
  const panel = await page.locator('.terminal-panel').boundingBox()
  await shot('terminals', { x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, 200) })

  // The same window in a project's own colours, picked in its settings.
  await page.locator('.project-row').first().click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Settings/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cork' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.mouse.move(700, 300)
  await sleep(600)
  await shot('colours')
} catch (error) {
  console.log('FAIL', error)
  failed = true
  await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {})
} finally {
  await app.close()
}
console.log(`scratch: ${scratch}\nshots: ${shots}`)
process.exit(failed ? 1 : 0)
