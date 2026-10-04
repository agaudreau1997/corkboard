// End-to-end smoke test: drives the built app with Playwright on a scratch board repo, with a
// stand-in `claude` that records its arguments, so nothing real is started or billed.
//
//   npm run build && node tests/e2e/smoke.mjs [board repo to start from]
//
// The board repo is made up by fixture.mjs for every run. A board repo given instead is cloned at
// its first commit, and must have the fixture's shape: the checks name its boards, lists and ids.
//
// Screenshots go to $SHOT_DIR (default: ./test-results). Exits 1 on the first failed check.
//
// CORKBOARD_E2E_EXECUTABLE runs the same checks against a packaged app instead of the dev build,
// e.g. dist/linux-unpacked/corkboard after `npm run dist:linux`.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { CHILDREN, COMMITTED, IDEAS, MAIN, SPARE, TO_FIX, writeFixture } from './fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '../..')
const source = process.argv[2]
const shots = process.env.SHOT_DIR ?? path.join(appDir, 'test-results')
mkdirSync(shots, { recursive: true })

const scratch = mkdtempSync(path.join(os.tmpdir(), 'corkboard-e2e-'))
const root = path.join(scratch, 'board')
const codeRepo = path.join(scratch, 'code')
// A scratch bare remote, so the app's sync pushes there and never to the real board repo; a
// second clone of it plays the other machine.
const remote = path.join(scratch, 'remote.git')
const otherMachine = path.join(scratch, 'other-machine')
// Commits made here and by the app, on a machine with no git identity of its own (CI).
const gitIdentity = { GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' }
const seed = path.join(scratch, 'seed')
if (source) {
  // A board repo given: as it was first committed, so what its boards hold today never changes
  // what the checks see.
  execFileSync('git', ['clone', '-q', source, seed])
  const firstCommit = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: seed }).toString().trim().split('\n')[0]
  execFileSync('git', ['checkout', '-q', '-B', 'main', firstCommit], { cwd: seed })
} else {
  mkdirSync(seed)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: seed })
  writeFixture(seed)
  execFileSync('git', ['add', '-A'], { cwd: seed })
  execFileSync('git', ['commit', '-q', '-m', 'The fixture boards'], { cwd: seed, env: { ...process.env, ...gitIdentity } })
}
execFileSync('git', ['clone', '-q', '--bare', seed, remote])
execFileSync('git', ['clone', '-q', remote, root])
execFileSync('git', ['clone', '-q', remote, otherMachine])
for (const dir of [root, otherMachine]) {
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
}
// A code repo with a commit naming a card, so the card shows it.
mkdirSync(codeRepo)
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: codeRepo })
execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', `Fix the drill sound\n\nCard: ${COMMITTED}`], { cwd: codeRepo })
const mainMeta = JSON.parse(readFileSync(path.join(root, MAIN.path, 'board.json'), 'utf8'))
mainMeta.codeRepo = codeRepo
writeFileSync(path.join(root, MAIN.path, 'board.json'), `${JSON.stringify(mainMeta, null, 2)}\n`)
// No CLAUDE.md, as in a board repo made before the app wrote one, so the side panel offers it.
if (existsSync(path.join(root, 'CLAUDE.md'))) execFileSync('git', ['rm', '-q', 'CLAUDE.md'], { cwd: root })
execFileSync('git', ['commit', '-qam', 'e2e: point at the scratch code repo'], { cwd: root })

const fakeLog = path.join(scratch, 'claude-calls.txt')
const urlLog = path.join(scratch, 'opened-urls.txt')
const openedUrls = () => (existsSync(urlLog) ? readFileSync(urlLog, 'utf8').split('\n').filter(Boolean) : [])
/** The stand-in's calls that started sessions (the app also asks it for --version). */
const sessionCalls = () =>
  existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n--\n').filter(c => c && !c.startsWith('--version')) : []
// Records its argv, then parses it the way Claude Code does (--add-dir takes every argument up to
// the next option), so a prompt an option swallowed shows up on screen as "prompt=none". It is a
// Node script so it runs on Windows too, behind a launcher the terminal's shell runs: a bash script
// on Unix, a .ps1 on Windows (PowerShell runs that itself, so a prompt's quotes and newlines reach
// Node intact; a .cmd would go through cmd.exe, which mangles them).
const fakeScript = path.join(scratch, 'fake-claude.mjs')
writeFileSync(
  fakeScript,
  [
    "import { appendFileSync } from 'node:fs'",
    'const argv = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(fakeLog)}, argv.map(a => a + '\\0').join('') + '\\n--\\n')`,
    "const cloud = argv[0] === '--cloud'",
    "let prompt = 'none'",
    'for (let i = 0; i < argv.length; ) {',
    '  const a = argv[i]',
    "  if (a === '--add-dir') for (i++; i < argv.length && !argv[i].startsWith('-'); i++);",
    "  else if (['-n', '--session-id', '-w', '--resume'].includes(a)) i += 2",
    "  else if (a === '--cloud') {",
    "    if (i + 1 < argv.length) prompt = 'given'",
    '    i += 2',
    "  } else if (a === '--version' || a === 'update') i++",
    '  else {',
    "    prompt = 'given'",
    '    i++',
    '  }',
    '}',
    'console.log(`FAKE CLAUDE in ${process.cwd()} prompt=${prompt}`)',
    "if (cloud) console.log('Created https://claude.ai/code/session_fake123')",
    '',
  ].join('\n'),
)
const psQuote = s => `'${s.replaceAll("'", "''")}'`
const shQuote = s => `'${s.replaceAll("'", `'\\''`)}'`
const fakeClaude = path.join(scratch, process.platform === 'win32' ? 'fake-claude.ps1' : 'fake-claude')
writeFileSync(
  fakeClaude,
  process.platform === 'win32'
    ? `& ${psQuote(process.execPath)} ${psQuote(fakeScript)} @args\r\nexit $LASTEXITCODE\r\n`
    : `#!/bin/bash\nexec ${shQuote(process.execPath)} ${shQuote(fakeScript)} "$@"\n`,
)
chmodSync(fakeClaude, 0o755)
// One Claude turn as the terminal sees it: Claude Code's titles (✳ at its prompt, ◐/◑ flipping
// while it works), then its prompt until Enter, then the cleared title it leaves on exit.
const fakeTurn = path.join(scratch, 'fake-turn.mjs')
writeFileSync(
  fakeTurn,
  [
    "const title = t => process.stdout.write('\\x1b]0;' + t + '\\x07')",
    "title('\\u2733 Claude Code')",
    'let frame = 0',
    "const spin = setInterval(() => title((frame++ % 2 ? '\\u25d1' : '\\u25d0') + ' Fake turn'), 200)",
    'setTimeout(() => {',
    '  clearInterval(spin)',
    "  title('\\u2733 Fake turn')",
    "  console.log('FAKE TURN DONE')",
    "  process.stdin.once('data', () => {",
    "    title('')",
    '    process.exit(0)',
    '  })',
    '}, 3000)',
    '',
  ].join('\n'),
)

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 6000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return v
    await sleep(100)
  }
}

const packaged = process.env.CORKBOARD_E2E_EXECUTABLE
const app = await electron.launch({
  // The app folder, as `npm start` and the launcher run it: Electron then reads package.json (its
  // name and version) and starts its main, out/main/index.js.
  ...(packaged ? { executablePath: path.resolve(packaged), args: [] } : { args: [appDir] }),
  cwd: appDir,
  env: {
    ...process.env,
    CORKBOARD_ROOT: root,
    CORKBOARD_USER_DATA: path.join(scratch, 'profile'),
    CORKBOARD_HIDDEN: process.env.CORKBOARD_HIDDEN ?? '1',
    CORKBOARD_COMMIT_DELAY_MS: '600',
    CORKBOARD_SYNC_INTERVAL_MS: '0',
    CORKBOARD_CLAUDE_BIN: fakeClaude,
    // claude:// links are written to a file, and the desktop app's session index is a scratch one.
    CORKBOARD_OPEN_URL_LOG: urlLog,
    CORKBOARD_DESKTOP_SESSIONS_DIR: path.join(scratch, 'desktop-sessions'),
    CORKBOARD_CLAUDE_PROJECTS_DIR: path.join(scratch, 'claude-projects'),
    CORKBOARD_DESKTOP_POLL_MS: '300',
    // Never looks for Corkboard updates, even as a packaged app.
    CORKBOARD_UPDATES: '0',
    ...gitIdentity,
  },
})
// The main process's own output (git failures and the like), saved beside the screenshots.
const mainLog = []
app.process().stdout?.on('data', d => mainLog.push(String(d)))
app.process().stderr?.on('data', d => mainLog.push(String(d)))
const page = await app.firstWindow()
page.on('pageerror', e => {
  console.log('PAGE ERROR', e.message)
  failures++
})
page.on('console', m => m.type() === 'error' && console.log('console.error:', m.text()))
await page.setViewportSize({ width: 1500, height: 940 }).catch(() => {})
const shot = async name => page.screenshot({ path: path.join(shots, `${name}.png`) })

let quitCard
try {
  // ---- the tree and tabs ----
  await page.getByRole('treeitem').first().waitFor()
  const rows = await page.locator('.tree-row .tree-title').allTextContents()
  check(rows.includes(MAIN.title) && rows.includes(SPARE.title), `tree roots: ${rows.join(', ')}`)
  await page.locator('.tree-row', { hasText: MAIN.title }).first().locator('.twisty').click()
  const children = await page.locator('.tree-row .tree-title').allTextContents()
  check(CHILDREN.every(t => children.includes(t)), `child boards listed under ${MAIN.title}`)
  const { version } = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const updateLine = page.locator('.update-line.update-off')
  await until(async () => (await updateLine.count()) === 1)
  const versionLine = await updateLine.textContent().catch(() => 'no line')
  check(versionLine === `Corkboard ${version}`, `the side panel shows the version, with updates off (${versionLine})`)

  await page.locator('.tree-row', { hasText: MAIN.title }).first().click()
  await page.locator('.column').first().waitFor()
  const columns = await page.locator('.column-title').allTextContents()
  check(columns[0] === 'To do' && columns.includes('Next up') && columns.includes('Done'), `kanban columns: ${columns.join(' | ')}`)
  const done = page.locator('.column[data-list="done"]')
  check((await done.locator('.card').count()) === 60 && (await done.getByText(/Show all/).count()) === 1, 'Done column capped at 60 with a Show all')
  check((await page.locator('.divider-card').count()) > 0, 'dashes cards draw as dividers')
  await shot('01-kanban')

  // Second tab, map view.
  await page.locator('.tree-row', { hasText: IDEAS.title }).click()
  check((await page.locator('.tab').count()) === 2, 'a second tab opened')
  await page.getByRole('tab', { name: 'Map' }).click()
  await page.locator('.map-node').first().waitFor()
  check((await page.locator('.map-node').count()) > 30, `map draws the open idea cards (${await page.locator('.map-node').count()})`)
  await shot('02-map')

  // Link two ideas by dragging handle to node.
  const nodes = page.locator('.react-flow__node-card')
  const a = nodes.nth(0)
  const b = nodes.nth(1)
  const aId = await a.getAttribute('data-id')
  const bId = await b.getAttribute('data-id')
  await a.hover()
  const handle = a.locator('.react-flow__handle-right')
  const hb = await handle.boundingBox()
  const tb = await b.locator('.react-flow__handle-left').boundingBox()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 15 })
  await page.mouse.up()
  const linked = await until(() =>
    readFileSync(path.join(root, IDEAS.path, 'cards', `${aId}.md`), 'utf8').includes(bId),
  )
  check(linked, `dragging ${aId} → ${bId} wrote a link into ${aId}.md`)
  check((await until(async () => (await page.locator('.react-flow__edge').count()) >= 1)) !== false, 'the link draws as an edge')

  // Drag a node, its position lands in map.json, and nothing else on the map moves.
  const c = nodes.nth(2)
  const cBefore = await c.boundingBox()
  const nb = await b.boundingBox()
  await page.mouse.move(nb.x + 60, nb.y + 15)
  await page.mouse.down()
  await page.mouse.move(nb.x + 260, nb.y + 215, { steps: 10 })
  await page.mouse.up()
  const placed = await until(() => {
    const map = JSON.parse(readFileSync(path.join(root, IDEAS.path, 'map.json'), 'utf8'))
    return map.nodes[bId]
  })
  check(!!placed, `moving ${bId} saved its position to map.json`)
  await sleep(300)
  const cAfter = await c.boundingBox()
  check(Math.abs(cAfter.x - cBefore.x) < 1 && Math.abs(cAfter.y - cBefore.y) < 1, 'the other cards stay where they were')
  const pinned = Object.keys(JSON.parse(readFileSync(path.join(root, IDEAS.path, 'map.json'), 'utf8')).nodes).length
  check(pinned === (await page.locator('.map-node').count()), `the drag pinned every card on the map (${pinned})`)
  await shot('03-map-linked')

  // ---- backdrops: one per list; dropping a card on another moves it there ----
  const ideasMeta = JSON.parse(readFileSync(path.join(root, IDEAS.path, 'board.json'), 'utf8'))
  check((await page.locator('.map-area').count()) === ideasMeta.lists.length, `every list has a backdrop (${await page.locator('.map-area').count()})`)
  await page.locator('.react-flow__controls-fitview').click()
  await sleep(300)
  const firstArea = page.locator('.map-area').nth(0)
  const secondArea = page.locator('.map-area').nth(1)
  const fromList = await firstArea.getAttribute('data-area')
  const toList = await secondArea.getAttribute('data-area')
  const mapMover = page.locator('.react-flow__node-card', { has: page.locator('.map-node-meta', { hasText: ideasMeta.lists.find(l => l.id === fromList).title }) }).first()
  const mapMoverId = await mapMover.getAttribute('data-id')
  const mb = await mapMover.boundingBox()
  const tb2 = await secondArea.boundingBox()
  await page.mouse.move(mb.x + mb.width / 2, mb.y + 10)
  await page.mouse.down()
  await page.mouse.move(tb2.x + tb2.width / 2, tb2.y + tb2.height / 2, { steps: 15 })
  await page.mouse.up()
  const moverFile = path.join(root, IDEAS.path, 'cards', `${mapMoverId}.md`)
  check(await until(() => readFileSync(moverFile, 'utf8').includes(`list: ${toList}`)), `dropping ${mapMoverId} on the ${toList} backdrop moved it there`)
  const savedMap = JSON.parse(readFileSync(path.join(root, IDEAS.path, 'map.json'), 'utf8'))
  check(!!savedMap.areas?.[fromList] && !!savedMap.areas?.[toList], 'backdrops are saved in map.json')

  // Right-click a backdrop: Automatically lay out puts its cards back in columns inside it.
  await secondArea.locator('.area-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Automatically lay out/ }).click()
  const laidOut = await until(() => {
    const map = JSON.parse(readFileSync(path.join(root, IDEAS.path, 'map.json'), 'utf8'))
    const a = map.areas[toList]
    const p = map.nodes[mapMoverId]
    return a && p && p.x >= a.x && p.y >= a.y && p.x + 230 <= a.x + a.w && p.y <= a.y + a.h ? map : null
  })
  check(!!laidOut, 'Automatically lay out keeps the cards inside their backdrop')
  await shot('13-map-backdrops')

  // Double-click empty space: an input; Escape (or nothing typed) adds no card.
  const cardsBefore = readdirSync(path.join(root, IDEAS.path, 'cards')).length
  const pane = await page.locator('.react-flow__pane').boundingBox()
  // A spot where the pointer meets the canvas itself (not a card, the controls or the minimap),
  // with canvas all around: a connection dropped within 20 px of a card's dot snaps to it. When a
  // drag starts at `from`, far enough from it to be a drag.
  const findEmpty = from => page.evaluate(({ box, from }) => {
    const pane = (x, y) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')
    for (let y = box.y + 40; y < box.y + box.height - 40; y += 23) {
      for (let x = box.x + 80; x < box.x + box.width - 260; x += 37) {
        if (from && Math.hypot(x - from.x, y - from.y) < 150) continue
        if ([[0, 0], [-40, 0], [40, 0], [0, -40], [0, 40]].every(([dx, dy]) => pane(x + dx, y + dy))) return { x, y }
      }
    }
    return null
  }, { box: pane, from })
  const emptyAt = await findEmpty()
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.locator('.map-new-card input').waitFor()
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await page.locator('.map-new-card').count()) === 0 && readdirSync(path.join(root, IDEAS.path, 'cards')).length === cardsBefore, 'Escape on a new map card adds nothing')
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.locator('.map-new-card input').waitFor()
  await page.mouse.click(pane.x + pane.width / 2, pane.y + 20)
  await sleep(300)
  check(readdirSync(path.join(root, IDEAS.path, 'cards')).length === cardsBefore, 'an empty new card left by clicking away adds nothing')
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.keyboard.type('Typed on the map')
  await page.keyboard.press('Enter')
  check(await until(() => readdirSync(path.join(root, IDEAS.path, 'cards')).length === cardsBefore + 1), 'a typed title adds the card')

  // Drag a card's dot to empty space: an input for a new card linked from it.
  const linker = page.locator('.react-flow__node-card').first()
  const linkerId = await linker.getAttribute('data-id')
  await linker.hover()
  const dot = await linker.locator('.react-flow__handle-right').boundingBox()
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
  await page.mouse.down()
  const freeAt = await findEmpty({ x: dot.x, y: dot.y })
  await page.mouse.move(freeAt.x, freeAt.y, { steps: 15 })
  await page.mouse.up()
  await page.locator('.map-new-card input').waitFor()
  check((await page.locator('.map-new-card', { hasText: `linked from ${linkerId}` }).count()) === 1, 'dragging a dot to empty space opens a linked new card')
  await page.keyboard.type('Grown from a link')
  await page.keyboard.press('Enter')
  const grown = await until(() => {
    const dir = path.join(root, IDEAS.path, 'cards')
    const f = readdirSync(dir).map(n => readFileSync(path.join(dir, n), 'utf8')).find(t => t.includes('title: Grown from a link'))
    return f ? /id: (\S+)/.exec(f)[1] : null
  })
  check(!!grown && (await until(() => readFileSync(path.join(root, IDEAS.path, 'cards', `${linkerId}.md`), 'utf8').includes(grown))), `the new card ${grown} is linked from ${linkerId}`)

  // ---- a new board, a card, a drag ----
  await page.locator('.sidebar-head .icon-button').click()
  await page.getByLabel('Title').fill('Scratch board')
  await page.getByRole('button', { name: 'Create board' }).click()
  await page.locator('.column-title', { hasText: 'To do' }).waitFor()
  check(existsSync(path.join(root, 'scratch-board/board.json')), 'new board folder written')
  check((await page.locator('.tab').count()) === 3, 'new board opened in its own tab')
  const todo = page.locator('.column[data-list="todo"]')
  await todo.getByText('+ Add a card').click()
  await page.keyboard.type('Drag me to done')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  const card = todo.locator('.card', { hasText: 'Drag me to done' })
  await card.waitFor()
  check(existsSync(path.join(root, 'scratch-board/cards/SB-1.md')), 'card file SB-1.md written')

  const cb = await card.boundingBox()
  const doneCol = await page.locator('.column[data-list="done"] .column-body').boundingBox()
  await page.mouse.move(cb.x + 40, cb.y + 12)
  await page.mouse.down()
  await page.mouse.move(cb.x + 60, cb.y + 20, { steps: 4 })
  await page.mouse.move(doneCol.x + 60, doneCol.y + 20, { steps: 20 })
  await page.mouse.up()
  const moved = await until(() => readFileSync(path.join(root, 'scratch-board/cards/SB-1.md'), 'utf8').includes('list: done'))
  check(moved, 'dragging the card to Done rewrote its list')
  check((await page.locator('.column[data-list="done"] .card', { hasText: 'Drag me to done' }).count()) === 1, 'the card shows in Done')

  // ---- the drag tray: no column appears mid-drag; the Archive zone archives ----
  // dnd-kit swallows clicks for 50 ms after a drop; a person never clicks that fast.
  await sleep(120)
  await todo.getByText('+ Add a card').click()
  await todo.locator('textarea').waitFor()
  await page.keyboard.type('Archive me by dragging')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  const victim = page.locator('.card', { hasText: 'Archive me by dragging' })
  await victim.waitFor()
  const columnsBefore = await page.locator('.column').count()
  const vb = await victim.boundingBox()
  await page.mouse.move(vb.x + 40, vb.y + 12)
  await page.mouse.down()
  await page.mouse.move(vb.x + 60, vb.y + 30, { steps: 5 })
  await page.locator('.drag-tray.up').waitFor()
  check((await page.locator('.column').count()) === columnsBefore, 'dragging adds no column (the board does not shift)')
  await sleep(250)
  await shot('08-drag-tray')
  const zone = await page.locator('[data-zone="zone:archive"]').boundingBox()
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 20 })
  await page.mouse.up()
  await sleep(120)
  const archivedId = await until(() => {
    for (const name of ['SB-2.md', 'SB-3.md']) {
      const f = path.join(root, 'scratch-board/cards', name)
      if (existsSync(f) && readFileSync(f, 'utf8').includes('Archive me') && readFileSync(f, 'utf8').includes('archived: true')) return name
    }
    return ''
  })
  check(!!archivedId, `dropping on the tray's Archive zone archived the card (${archivedId})`)
  check((await page.locator('.card', { hasText: 'Archive me by dragging' }).count()) === 0, 'the archived card left the board')

  // ---- lists from the board: add one, rename it, collapse it ----
  await page.getByRole('button', { name: '+ Add a list' }).click()
  await page.keyboard.type('Bugs')
  await page.keyboard.press('Enter')
  await page.locator('.column[data-list="bugs"]').waitFor()
  check(readFileSync(path.join(root, 'scratch-board/board.json'), 'utf8').includes('"Bugs"'), 'a list added from the board lands in board.json')
  await page.keyboard.press('Escape')
  await page.locator('.column[data-list="bugs"] .column-title').dblclick()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Known bugs\n')
  check(await until(() => readFileSync(path.join(root, 'scratch-board/board.json'), 'utf8').includes('"Known bugs"')), 'double-clicking a list title renames it')
  const renamed = page.locator('.card[data-card="SB-1"]')
  await renamed.locator('.card-title').dblclick()
  await page.keyboard.type('Thrown away')
  await page.keyboard.press('Escape')
  check((await renamed.locator('.rename-card').count()) === 0 && (await renamed.locator('.card-title').textContent()) === 'Drag me to done', 'Escape leaves a card title as it was')
  await renamed.locator('.card-title').dblclick()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Drag me to done, renamed\n')
  check(
    await until(() => readFileSync(path.join(root, 'scratch-board/cards/SB-1.md'), 'utf8').includes('title: Drag me to done, renamed')),
    'double-clicking a card edits its title',
  )
  await page.keyboard.press('Escape')
  await page.locator('.column[data-list="bugs"] .column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Collapse list' }).click()
  check((await page.locator('.column.collapsed[data-list="bugs"]').count()) === 1, 'the list menu collapses a list')
  await page.locator('.column.collapsed[data-list="bugs"]').click()

  // ---- drag a list by its header to reorder the board ----
  await sleep(120)
  const scrollBefore = await page.locator('.kanban').evaluate(el => el.scrollLeft)
  const todoHead = await page.locator('.column[data-list="todo"] .column-head').boundingBox()
  const doingHead = await page.locator('.column[data-list="doing"] .column-head').boundingBox()
  await page.mouse.move(doingHead.x + 40, doingHead.y + doingHead.height / 2)
  await page.mouse.down()
  await page.mouse.move(doingHead.x + 30, doingHead.y + 20, { steps: 4 })
  await page.locator('.column-preview').waitFor()
  check((await page.locator('.drag-tray.up').count()) === 0, 'a list drag raises no card tray')
  await page.mouse.move(todoHead.x + 20, todoHead.y + 20, { steps: 20 })
  await sleep(150)
  await shot('12-list-drag')
  await page.mouse.up()
  await sleep(150)
  const order = await until(() => {
    const ids = JSON.parse(readFileSync(path.join(root, 'scratch-board/board.json'), 'utf8')).lists.map(l => l.id)
    return ids[0] === 'doing' ? ids : null
  })
  check(!!order, `dragging Doing's header before To do reorders board.json (${order?.join(', ')})`)
  const onScreen = await page.locator('.kanban > .column[data-list]').evaluateAll(els => els.map(e => e.dataset.list))
  check(onScreen.slice(0, 2).join() === 'doing,todo', `and the board shows it (${onScreen.join(', ')})`)
  check((await page.locator('.kanban').evaluate(el => el.scrollLeft)) === scrollBefore, 'a header drag does not pan the board')

  // ---- a change made on disk shows up live (what a Claude session does) ----
  const file = path.join(root, 'scratch-board/cards/SB-1.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('list: done', 'list: doing'))
  const live = await until(async () => (await page.locator('.column[data-list="doing"] .card', { hasText: 'Drag me to done' }).count()) === 1)
  check(live, 'a card file edited on disk moved columns on screen')

  // ---- a list keeps itself sorted by last update; a change on disk re-sorts it ----
  for (const title of ['Sorted older', 'Sorted newer']) {
    await todo.getByText('+ Add a card').click()
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await todo.locator('.card', { hasText: title }).waitFor()
    await sleep(20)
  }
  const firstInTodo = async () => (await todo.locator('.card .card-title').first().textContent())?.trim()
  check((await firstInTodo()) === 'Sorted newer', `a list shows its last updated card first (${await firstInTodo()})`)
  const sortTodo = async name => {
    await todo.locator('.column-head').click({ button: 'right' })
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /Sort cards by/ }).hover()
    await page.locator('.ctx-menu').getByRole('menuitem', { name }).click()
  }
  const todoSort = () => JSON.parse(readFileSync(path.join(root, 'scratch-board/board.json'), 'utf8')).lists.find(l => l.id === 'todo')?.sort
  await sortTodo(/Manual/)
  check(await until(() => todoSort() === 'manual'), 'Sort cards by › Manual is kept in board.json')
  check(await until(async () => (await firstInTodo()) === 'Sorted older'), 'a manual list shows its cards in their positions')
  await sortTodo(/Last updated/)
  check(await until(async () => (await firstInTodo()) === 'Sorted newer'), 'and back to last updated first')
  const olderFile = path.join(root, 'scratch-board/cards', readdirSync(path.join(root, 'scratch-board/cards'))
    .find(f => readFileSync(path.join(root, 'scratch-board/cards', f), 'utf8').includes('title: Sorted older')))
  const later = new Date(Date.now() + 60000).toISOString()
  writeFileSync(olderFile, readFileSync(olderFile, 'utf8').replace(/^created: .*$/m, line => `${line}\nupdated: ${later}`))
  check(await until(async () => (await firstInTodo()) === 'Sorted older'), 'a card updated on disk rises to the top of its list')

  // ---- the board repo commits itself ----
  const log = await until(() => {
    const out = execFileSync('git', ['log', '--format=%B', '-5'], { cwd: root }).toString()
    return out.includes('SB-1') ? out : ''
  }, 8000)
  check(!!log, `board repo auto-committed:\n${log}`)

  // ---- card detail, commits and tackling ----
  await page.locator(`.tab[title$=":${MAIN.path}"]`).click()
  await page.locator('.column[data-list="tofix"] .card').first().click()
  await page.locator('.drawer').waitFor()
  const openId = (await page.locator('.drawer .card-id').textContent()).trim()
  check(openId.startsWith(`${MAIN.key}-`), `drawer opened for ${openId}`)
  await shot('04-drawer')

  // Its left edge resizes it; the width is remembered, and a double-click puts it back.
  const drawerWidth = () => page.locator('.drawer').evaluate(el => el.getBoundingClientRect().width)
  const edge = await page.locator('.drawer-resize').boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 - 120, edge.y + 200, { steps: 8 })
  await page.mouse.up()
  check((await drawerWidth()) === 560, `dragging the drawer's edge widens it (${await drawerWidth()})`)
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('corkboard.ui')).drawerWidth === 560), 'and the width is remembered')
  await page.mouse.dblclick(edge.x + edge.width / 2 - 120, edge.y + 200)
  check((await drawerWidth()) === 440, 'double-clicking the edge puts it back')

  await page.keyboard.press('Control+f')
  check(await page.locator('.filter').evaluate(el => el === document.activeElement), 'Ctrl+F focuses the filter')

  // COMMITTED has a commit in the scratch code repo.
  await page.locator('.filter').fill(COMMITTED)
  await page.locator('.card', { hasText: COMMITTED }).first().click()
  check((await until(async () => (await page.locator('.drawer .commits li').count()) === 1)) === true, `${COMMITTED} lists its Card: commit`)
  check((await page.locator(`.card[data-card="${COMMITTED}"] .badge.commit`).count()) === 1, 'the card face shows the commit badge')
  await page.locator('.drawer .commits li').first().hover()
  await page.locator('.drawer .commits .copy-sha').click()
  const sha = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(/^[0-9a-f]{40}$/.test(sha), `the commit's Copy put its full SHA on the clipboard: ${sha}`)
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await page.locator('.drawer .commits .commit-line').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy short SHA' }).click()
  const short = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(!!short && sha.startsWith(short) && short.length < 40, `its menu's Copy short SHA put ${short} on the clipboard`)
  await page.locator('.filter').fill('')

  const tackleId = (await page.locator('.drawer .card-id').textContent()).trim()
  await page.locator('.drawer').getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('.terminal-tab').first().waitFor()
  const termText = await until(async () => {
    const t = await page.locator('.xterm-rows').first().textContent()
    return t?.includes('FAKE CLAUDE') ? t : ''
  }, 15000)
  check(!!termText, 'tackle opened a terminal running claude')
  check(termText.includes('prompt=given'), 'claude received the prompt (no option swallowed it)')
  const calls = sessionCalls()
  const args = calls[0].split('\0')
  check(args.includes('--session-id') && args.includes('--add-dir') && args.includes('-n'), `claude args: ${args.slice(0, 7).join(' ')}`)
  check(args.at(-2)?.includes(`Tackle card ${tackleId}`) ?? false, `the prompt names ${tackleId}`)
  const tackled = readFileSync(path.join(root, MAIN.path, 'cards', `${tackleId}.md`), 'utf8')
  check(tackled.includes('sessions:') && tackled.includes('kind: local'), 'the session is recorded on the card')

  // Forget it again from the drawer.
  await page.locator('.drawer .sessions li').first().waitFor()
  await page.locator('.drawer').getByRole('button', { name: 'Forget this session' }).first().click()
  const forgotten = await until(() => !readFileSync(path.join(root, MAIN.path, 'cards', `${tackleId}.md`), 'utf8').includes('sessions:'))
  check(forgotten, 'forgetting the session takes it off the card')
  check((await page.locator('.drawer .sessions li').count()) === 0, 'and off the drawer')

  // ---- Claude desktop: a claude://code/new link, then the session found in its index ----
  const cardFileOf = id => path.join(root, MAIN.path, 'cards', `${id}.md`)
  await page.locator('.drawer').getByRole('button', { name: 'Claude desktop' }).click()
  const newLink = await until(() => openedUrls().find(u => u.startsWith('claude://code/new?')))
  check(!!newLink, 'Claude desktop opened a claude://code/new link')
  const linkParams = new URL(newLink).searchParams
  check(linkParams.get('q')?.startsWith(`Tackle card ${tackleId}`) ?? false, 'the link carries the prompt')
  check(linkParams.getAll('folder').join() === codeRepo, 'in the code repo, its only folder')
  check(linkParams.get('q')?.includes(`if your working directory is not ${codeRepo}, stop`) ?? false, 'the prompt asks the session to check its folder')
  check(await until(() => readFileSync(cardFileOf(tackleId), 'utf8').includes('kind: desktop')), 'the desktop session is recorded')
  check(await until(async () => (await page.locator('.drawer .sessions li', { hasText: 'waiting' }).count()) === 1), 'waiting until its prompt is sent')
  // The desktop app indexes the session and writes its transcript once the prompt is sent.
  const desktopIndex = path.join(scratch, 'desktop-sessions', 'account', 'org')
  mkdirSync(desktopIndex, { recursive: true })
  writeFileSync(
    path.join(desktopIndex, 'local_e2e-1.json'),
    JSON.stringify({ sessionId: 'local_e2e-1', cliSessionId: 'cli-e2e-1', cwd: codeRepo, createdAt: Date.now() }),
  )
  const transcriptDir = path.join(scratch, 'claude-projects', codeRepo.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(
    path.join(transcriptDir, 'cli-e2e-1.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: linkParams.get('q') }] } }) + '\n',
  )
  check(await until(() => readFileSync(cardFileOf(tackleId), 'utf8').includes('desktopId: local_e2e-1')), 'the card links the session the desktop app opened')
  await page.locator('.drawer .sessions').getByRole('button', { name: 'Open', exact: true }).click()
  check(!!(await until(() => openedUrls().includes('claude://code/continue?session=local_e2e-1'))), 'Open reopens it in the desktop app')

  // A terminal session opens in the desktop app too (it imports the CLI session).
  const callsBeforeTerminal = sessionCalls().length
  await page.locator('.drawer').getByRole('button', { name: 'Terminal', exact: true }).click()
  await until(() => readFileSync(cardFileOf(tackleId), 'utf8').includes('kind: local'))
  await until(() => sessionCalls().length > callsBeforeTerminal, 15000)
  await page.locator('.drawer .sessions li', { hasText: 'Terminal' }).getByRole('button', { name: 'Desktop' }).click()
  const imported = await until(() => openedUrls().find(u => u.startsWith('claude://resume?session=')))
  check(!!imported && /session=[0-9a-f-]{36}$/.test(imported), `a terminal session opens in the desktop app (${imported})`)

  // ---- Discuss: a card from its menu (terminal), a list from its menu (desktop) ----
  const todoCard = page.locator('.column[data-list="todo"] .card').first()
  const talkId = await todoCard.getAttribute('data-card')
  const callsBeforeTalk = sessionCalls().length
  await todoCard.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /^Discuss/ }).hover()
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'In a terminal' }).click()
  const talk = await until(() => sessionCalls().slice(callsBeforeTalk)[0], 15000)
  const talkPrompt = talk?.split('\0').at(-2) ?? ''
  check(talkPrompt.startsWith(`Let's discuss card ${talkId}`), `Discuss opens a session about ${talkId}`)
  check(talkPrompt.includes('Do not implement anything') && !talkPrompt.includes(`Card: ${talkId}`), 'its prompt forbids implementing and asks for no commits')
  const talkFile = readFileSync(cardFileOf(talkId), 'utf8')
  check(talkFile.includes('purpose: discuss') && talkFile.includes('list: todo'), 'the discussion is recorded and the card stays in its list')
  check((await page.locator(`.card[data-card="${talkId}"] .badge.discuss`).count()) === 1, 'the card shows a discussion badge')

  await page.locator('.column[data-list="todo"] .column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Discuss \/ triage/ }).hover()
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'In Claude desktop' }).click()
  const triageLink = await until(() => openedUrls().find(u => u.startsWith('claude://code/new?') && new URL(u).searchParams.get('q').startsWith("Let's triage")))
  check(!!triageLink, 'Discuss / triage on a list opens one desktop session for the whole list')

  const boardRow = page.locator('.tree-row.active')
  const boardTitle = (await boardRow.locator('.tree-title').textContent())?.trim()
  const callsBeforeBoardTalk = sessionCalls().length
  await boardRow.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Discuss \/ triage/ }).hover()
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'In a terminal' }).click()
  const boardTalk = await until(() => sessionCalls().slice(callsBeforeBoardTalk)[0], 15000)
  const boardPrompt = boardTalk?.split('\0').at(-2) ?? ''
  check(boardPrompt.startsWith(`Let's triage the whole "${boardTitle}" board`), `Discuss / triage on a board opens one session for all of ${boardTitle}`)
  check(boardPrompt.includes(`${talkId}: `) && boardPrompt.includes('   List: '), 'its prompt lists every card with its list')
  await shot('05-terminal')

  // Tackle a whole list in parallel: one terminal per card.
  const before = await page.locator('.terminal-tab').count()
  const callsBeforeParallel = sessionCalls().length
  const prime = page.locator('.column[data-list="todo"]')
  const primeCount = await prime.locator('.card').count()
  await prime.locator('.column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Tackle all' }).hover()
  await page.getByRole('menuitem', { name: /In terminals, in parallel/ }).click()
  await page.getByRole('button', { name: /Start \d+ sessions/ }).click()
  const after = await until(async () => ((await page.locator('.terminal-tab').count()) === before + primeCount ? true : false), 15000)
  check(after, `parallel tackle opened ${primeCount} terminals`)
  await sleep(1500)
  const worktreeCalls = sessionCalls().slice(callsBeforeParallel)
  check(worktreeCalls.every(c => c.split('\0').includes('-w')), 'each parallel session runs in a worktree')

  // Cloud: asks first, then records the printed URL.
  await page.locator('.column[data-list="tofix"] .card').first().click()
  const cloudId = (await page.locator('.drawer .card-id').textContent()).trim()
  await page.locator('.drawer').getByRole('button', { name: 'Cloud', exact: true }).click()
  check((await page.getByRole('dialog').count()) === 1, 'cloud tackle asks for confirmation')
  await page.getByRole('button', { name: 'Start cloud session' }).click()
  const cloudUrl = await until(() => readFileSync(path.join(root, MAIN.path, 'cards', `${cloudId}.md`), 'utf8').includes('claude.ai/code/session_fake123'), 15000)
  check(cloudUrl, 'the cloud session URL printed by claude is saved on the card')

  // Cloud, one session per card, from the list menu.
  const callsBefore = sessionCalls().length
  await prime.locator('.column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Tackle all' }).hover()
  await page.getByRole('menuitem', { name: /Claude Cloud, one session per card/ }).click()
  await page.getByRole('button', { name: new RegExp(`Start ${primeCount} cloud sessions`) }).click()
  const cloudEach = await until(() => {
    const calls = sessionCalls().slice(callsBefore)
    return calls.length === primeCount && calls.every(c => c.startsWith('--cloud')) ? calls : null
  }, 15000)
  check(!!cloudEach, `cloud one-per-card started ${primeCount} cloud sessions`)

  // ---- card menu: copy the id, move the card to another board ----
  // Pinned by its id: lists sort by last update, so the cloud sessions still being recorded from
  // the step above can lift another card to the top of the list between two clicks.
  const moverId = await page.locator('.column[data-list="todo"] .card').first().getAttribute('data-card')
  const mover = page.locator(`.column[data-list="todo"] .card[data-card="${moverId}"]`)
  await mover.click({ button: 'right' })
  await shot('09-card-menu')
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Identifier/ }).click()
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(copied === moverId, `Copy › Identifier put ${copied} on the clipboard`)

  const promptCardFile = path.join(root, MAIN.path, 'cards', `${moverId}.md`)
  const moverBefore = readFileSync(promptCardFile, 'utf8')
  await mover.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Tackle prompt/ }).click()
  const copiedPrompt = await until(async () => {
    const text = await app.evaluate(({ clipboard }) => clipboard.readText())
    return text.includes(`Card: ${moverId}`) ? text : null
  })
  check(!!copiedPrompt, `Copy › Tackle prompt put ${moverId}'s tackle prompt on the clipboard`)
  check(readFileSync(promptCardFile, 'utf8') === moverBefore, 'copying the prompt left the card as it was')
  check(!copiedPrompt?.includes('CLAUDE.md'), 'the prompt points to no CLAUDE.md the board repo lacks')

  // ---- the board repo has no CLAUDE.md: the side panel offers one ----
  const guideFile = path.join(root, 'CLAUDE.md')
  const offer = page.locator('.guide-offer')
  check((await offer.count()) === 1 && !existsSync(guideFile), 'a board repo without a CLAUDE.md gets an offer of one, and no file')
  await shot('09b-guide-offer')
  await offer.getByRole('button', { name: 'Add one' }).click()
  check(!!(await until(() => existsSync(guideFile))) && readFileSync(guideFile, 'utf8').includes('set its `updated:`'), 'Add one writes the CLAUDE.md with the card format')
  check(!!(await until(async () => (await offer.count()) === 0)), 'and the offer goes away')
  const rootLogHas = text => execFileSync('git', ['log', '--format=%B'], { cwd: root, stdio: 'pipe' }).toString().includes(text)
  check(!!(await until(() => rootLogHas('Add CLAUDE.md'), 12000)), 'the app commits the CLAUDE.md it added')
  await mover.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Tackle prompt/ }).click()
  check(!!(await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).includes('(its CLAUDE.md describes the card format)'))), 'now the prompt points to it')

  await page.locator(`.card[data-card="${moverId}"]`).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Move to board' }).hover()
  await page.getByRole('menuitem', { name: `${MAIN.title} / ${IDEAS.title}` }).hover()
  await sleep(150)
  await shot('10-move-to-board')
  await page.getByRole('menuitem', { name: 'Considering' }).click()
  const movedFile = path.join(root, IDEAS.path, 'cards', `${moverId}.md`)
  const movedOver = await until(() => existsSync(movedFile) && !existsSync(path.join(root, MAIN.path, 'cards', `${moverId}.md`)))
  check(movedOver, `${moverId} moved to the Ideas board, keeping its id`)
  check(readFileSync(movedFile, 'utf8').includes('list: considering'), 'into the chosen list')

  // ---- grab scrolling ----
  const kanban = page.locator('.kanban')
  await kanban.evaluate(el => (el.scrollLeft = 0))
  const kb = await kanban.boundingBox()
  const emptyY = kb.y + 6 // the board's top padding, above the columns
  await page.mouse.move(kb.x + kb.width - 120, emptyY)
  await page.mouse.down()
  await page.mouse.move(kb.x + 200, emptyY, { steps: 12 })
  await page.mouse.up()
  const scrolled = await kanban.evaluate(el => el.scrollLeft)
  check(scrolled > 300, `dragging the board's background scrolls it (scrollLeft ${Math.round(scrolled)})`)

  // ---- sync: what the app committed reached the remote; the other machine's change comes in ----
  await page.locator('.sync-line, .foot-line').first().waitFor()
  const syncNow = async () => {
    await page.locator('.project-row').first().click({ button: 'right' })
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /Sync now/ }).click()
  }
  await syncNow()
  const synced = await until(async () => (await page.locator('.project-row.sync-synced').count()) === 1, 15000)
  check(synced, 'the sync line reads Synced')
  const remoteLog = execFileSync('git', ['log', '--format=%B', '-30', 'main'], { cwd: remote }).toString()
  check(remoteLog.includes('SB-1'), 'the board commits reached the remote')
  execFileSync('git', ['pull', '-q'], { cwd: otherMachine })
  const otherCard = path.join(otherMachine, MAIN.path, 'cards', `${TO_FIX}.md`)
  writeFileSync(otherCard, readFileSync(otherCard, 'utf8').replace(/^title: .*$/m, 'title: Renamed on the other machine').replace(/^updated: .*$/m, `updated: ${new Date().toISOString()}`))
  execFileSync('git', ['commit', '-qam', `Rename ${TO_FIX} elsewhere`], { cwd: otherMachine })
  execFileSync('git', ['push', '-q'], { cwd: otherMachine })
  await syncNow()
  const pulled = await until(async () => (await page.locator(`.card[data-card="${TO_FIX}"]`, { hasText: 'Renamed on the other machine' }).count()) === 1, 15000)
  check(pulled, "the other machine's rename showed up after a sync")
  await shot('11-synced')

  // A plain shell in the panel.
  await page.locator('.terminal-tabs').getByTitle('New shell').click()
  await sleep(1500)
  await page.keyboard.type('echo corkboard-$((6*7))\n')
  const echoed = await until(async () => {
    const texts = await page.locator('.xterm-rows').allTextContents()
    return texts.some(t => t.includes('corkboard-42'))
  }, 10000)
  check(echoed, 'an interactive shell runs in the terminal panel')
  await shot('06-shell')

  // Each tab's icon follows the title Claude Code sets; a turn that ends out of sight stands out.
  const shellTab = page.locator('.terminal-tab').last()
  const shellIcon = () => shellTab.locator('.term-status').getAttribute('class')
  check((await shellIcon()).includes('shell'), 'a shell tab shows the shell icon')
  const runTurn =
    process.platform === 'win32'
      ? `& ${psQuote(process.execPath)} ${psQuote(fakeTurn)}`
      : `${shQuote(process.execPath)} ${shQuote(fakeTurn)}`
  await page.keyboard.type(`${runTurn}\n`)
  check(!!(await until(async () => (await shellIcon()).includes('working'), 10000)), 'Claude working: the tab spins')
  await shot('15-terminal-working')
  await page.locator('.terminal-tab').first().click()
  const finished = await until(async () => (await shellIcon()).includes('finished'), 10000)
  check(!!finished && (await shellTab.getAttribute('class')).includes('attention'), 'a turn that ended in a background tab marks it')
  check((await page.locator('.terminal-finished').textContent()) === '1', 'and the strip counts it by Terminals')
  await shot('16-terminal-finished')
  await page.locator('.terminal-finished').click()
  check((await shellIcon()).includes('waiting') && !(await shellTab.getAttribute('class')).includes('attention'), 'the count opens that tab and clears its mark: Claude waits')
  check((await page.locator('.terminal-finished').count()) === 0, 'and goes away')
  await sleep(300) // its terminal takes the focus on the next frame
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await shellIcon()).includes('shell'))), 'Claude gone: a shell again')

  // Middle-clicking a tab closes it, asking first while something runs in it.
  const tabCount = () => page.locator('.terminal-tab').count()
  if (process.platform !== 'win32') {
    // Windows has no foreground job to ask the shell about: only a working Claude asks there.
    const tabs = await tabCount()
    await page.keyboard.type('sleep 60\n')
    await sleep(800)
    await shellTab.click({ button: 'middle' })
    const closeButton = page.getByRole('dialog').getByRole('button', { name: 'Close terminal' })
    check(!!(await until(async () => (await closeButton.count()) === 1, 5000)), 'middle-clicking a busy tab asks first')
    check((await page.getByRole('dialog').textContent()).includes('sleep'), 'and names what runs in it')
    // Copy › Identifier left a card id in the selection that a middle click pastes on Linux.
    await sleep(300)
    const shellText = (await page.locator('.xterm-host:visible .xterm-rows').textContent()) ?? ''
    check(!shellText.includes(moverId), 'the middle click pastes nothing into the terminal')
    await shot('17-terminal-close-busy')
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    check((await tabCount()) === tabs, 'Cancel keeps the tab')
    await shellTab.click({ button: 'middle' })
    await closeButton.click()
    check(!!(await until(async () => (await tabCount()) === tabs - 1, 5000)), 'confirming closes it')
  }
  const tabs = await tabCount()
  await page.locator('.terminal-tabs').getByTitle('New shell').click()
  await until(async () => (await tabCount()) === tabs + 1, 10000)
  await sleep(1500)
  await page.locator('.terminal-tab').last().click({ button: 'middle' })
  const closedIdle = await until(async () => (await tabCount()) === tabs, 5000)
  check(!!closedIdle && (await page.getByRole('dialog').count()) === 0, 'middle-clicking an idle shell closes it without asking')

  // ---- a finished card shows no session badge; an open one does ----
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  await page.getByRole('tab', { name: 'Board', exact: true }).click()
  await page.locator('.filter').fill(COMMITTED)
  await page.locator(`.card[data-card="${COMMITTED}"]`).first().waitFor()
  check(readFileSync(cardFileOf(COMMITTED), 'utf8').includes('sessions:') && (await page.locator(`.card[data-card="${COMMITTED}"] .badge.session`).count()) === 0, 'a card in Done keeps its sessions but shows no session badge')
  await page.locator('.filter').fill('')
  check((await page.locator('.column[data-list="todo"] .badge.session').count()) > 0, 'an open card with sessions shows the badge')

  // ---- project colours: a theme picked in the settings, shown at once, saved to theme.json ----
  const rootToken = name => page.evaluate(n => document.documentElement.style.getPropertyValue(n), name)
  const openProjectSettings = async () => {
    await page.locator('.project-row').first().click({ button: 'right' })
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /Settings/ }).click()
  }
  await openProjectSettings()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Cork' }).click()
  check((await rootToken('--bg')) === '#1f1610', 'picking Cork repaints the window before saving')
  await dialog.getByRole('button', { name: 'Tide' }).click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  check((await rootToken('--bg')) === '', 'Cancel puts the colours back')
  await openProjectSettings()
  await dialog.getByRole('button', { name: 'Cork' }).click()
  await dialog.getByLabel('Accent hex').fill('#e0a96d')
  check((await rootToken('--accent')) === '#e0a96d', 'a hex typed in a colour field shows at once')
  await shot('18-theme-settings')
  await dialog.getByRole('button', { name: 'Save' }).click()
  const themeFile = path.join(root, 'theme.json')
  const savedTheme = await until(() => existsSync(themeFile) && JSON.parse(readFileSync(themeFile, 'utf8')))
  check(savedTheme?.colors?.background === '#1f1610' && savedTheme?.colors?.accent === '#e0a96d' && !savedTheme?.name, `Save writes theme.json at the board repo's root (${JSON.stringify(savedTheme)})`)
  check((await rootToken('--bg')) === '#1f1610', 'and the window keeps the colours')
  check((await page.locator('.project-row .theme-swatch').count()) === 1, 'the side panel shows the project its swatch')
  const boardLogHas = text => execFileSync('git', ['log', '--format=%B', '-10'], { cwd: root }).toString().includes(text)
  check(!!(await until(() => boardLogHas("Add the project's theme"), 12000)), 'the board repo commits the theme')
  await shot('19-theme-cork')
  // A Claude session (or the other machine) changes the file: the window follows.
  writeFileSync(themeFile, `${JSON.stringify({ name: 'Cork', colors: { background: '#1f1610', accent: '#d9a46c' } }, null, 2)}\n`)
  check(!!(await until(async () => (await rootToken('--accent')) === '#d9a46c')), 'a theme.json edited on disk shows up live')
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  await page.locator('.board-head').getByRole('button', { name: 'Settings', exact: true }).click()
  check((await dialog.locator('.theme-pointer').textContent()).includes('Cork'), 'board settings name the project colours')
  await dialog.getByRole('button', { name: 'Project colours…' }).click()
  check((await dialog.getByRole('heading').textContent()).includes('Project settings'), 'and open them in the project settings')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // ---- projects: add one, move a board into it, delete a board with cards ----
  const second = path.join(scratch, 'second-board')
  await page.locator('.sidebar-foot').getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('dialog').getByLabel('Board repo folder').fill(second)
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Side project')
  await page.getByRole('dialog').getByRole('button', { name: 'Add project' }).click()
  await page.locator('.project-row', { hasText: 'Side project' }).waitFor()
  check(existsSync(path.join(second, '.git')), 'a new project folder becomes a git repo')
  check(existsSync(path.join(second, 'CLAUDE.md')) && existsSync(path.join(second, 'README.md')), 'with a README and a CLAUDE.md')
  check((await page.locator('.guide-offer').count()) === 0, 'so neither project offers a CLAUDE.md')
  check((await page.locator('.project-row').count()) === 2, 'the side panel shows both projects')
  await page.locator('.tree-row', { hasText: SPARE.title }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Move to project' }).hover()
  await page.getByRole('menuitem', { name: 'Side project' }).click()
  await page.getByRole('button', { name: 'Move board' }).click()
  const movedBoard = await until(() => existsSync(path.join(second, SPARE.path, 'board.json')) && !existsSync(path.join(root, SPARE.path)))
  check(movedBoard, `${SPARE.title} moved into the other project, folder and cards`)
  check(readdirSync(path.join(second, SPARE.path, 'cards')).length === SPARE.files, `with its ${SPARE.files} cards`)
  await page.locator('.project[data-project] .tree-row', { hasText: SPARE.title }).waitFor()
  const secondLogHas = text => {
    try {
      return execFileSync('git', ['log', '--format=%B'], { cwd: second, stdio: 'pipe' }).toString().includes(text)
    } catch {
      return false // no commit yet
    }
  }
  check(!!(await until(() => secondLogHas(`Create board ${SPARE.path}`), 12000)), 'the other project commits the board it received')
  // Each project wears its own colours: the board in front decides.
  await page.locator('.project[data-project] .tree-row', { hasText: SPARE.title }).click()
  check(!!(await until(async () => (await rootToken('--bg')) === '')), 'a board of a project with no theme shows the app colours')
  check((await page.locator('.tab .theme-swatch').count()) >= 1, 'tabs of a themed project carry its swatch')
  await shot('14-projects')
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  check(!!(await until(async () => (await rootToken('--bg')) === '#1f1610')), 'back on the themed project, its colours return')
  await page.locator('.tab', { hasText: SPARE.title }).locator('.tab-close').click()
  await page.locator('.tree-row', { hasText: SPARE.title }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Delete board/ }).click()
  const deleteButton = page.getByRole('dialog').getByRole('button', { name: 'Delete board' })
  check(await deleteButton.isDisabled(), 'deleting a board with cards waits for its name')
  await page.getByRole('dialog').getByLabel(/Type the board's name/).fill(SPARE.title)
  await deleteButton.click()
  check(await until(() => !existsSync(path.join(second, SPARE.path))), 'typing the name deletes the board and its cards')
  const deleted = await until(() => secondLogHas(`Delete board ${SPARE.path}`), 12000)
  check(!!deleted, 'and commits the deletion')
  // A board whose cards are all archived counts as empty: a plain confirm deletes it.
  const retired = path.join(second, 'retired')
  mkdirSync(path.join(retired, 'cards'), { recursive: true })
  writeFileSync(
    path.join(retired, 'cards/RET-1.md'),
    '---\nid: RET-1\ntitle: Old\nlist: todo\npos: 1024\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\narchived: true\n---\n',
  )
  writeFileSync(path.join(retired, 'board.json'), `${JSON.stringify({ key: 'RET', title: 'Retired', lists: [{ id: 'todo', title: 'To do' }] }, null, 2)}\n`)
  const retiredRow = page.locator('.project[data-project] .tree-row', { hasText: 'Retired' })
  await retiredRow.waitFor()
  await retiredRow.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Delete board/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  check(await until(() => !existsSync(retired)), 'a board with only archived cards deletes on a plain confirm')
  check((await page.locator('.toast.error').count()) === 0, 'without an error')

  // Table view.
  await page.locator(`.tab[title$=":${MAIN.path}"]`).click()
  await page.getByRole('tab', { name: 'Table', exact: true }).click()
  check((await page.locator('tbody tr').count()) > 100, 'table lists the cards')
  await shot('07-table')

  // A change made just before quitting: the quit commits and pushes it (the same work an update's
  // install waits for).
  const rsKey = await page.locator(`.tab[title$=":${MAIN.path}"]`).first().getAttribute('title')
  quitCard = await page.evaluate(async key => {
    const board = await window.corkboard.boards.load(key)
    const card = board.cards.find(c => c.list && !c.archived)
    await window.corkboard.cards.update(key, card.id, { title: `${card.title} (renamed at quit)` })
    return card.id
  }, rsKey)
} catch (error) {
  console.log('FAIL', error)
  failures++
  await shot('99-failure').catch(() => {})
} finally {
  await app.close()
}
if (quitCard) {
  const pushed = execFileSync('git', ['show', `main:${MAIN.path}/cards/${quitCard}.md`], { cwd: remote }).toString()
  check(pushed.includes('(renamed at quit)'), `quitting committed and pushed ${quitCard}, changed just before`)
}

writeFileSync(path.join(shots, 'main-process.log'), mainLog.join(''))
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
console.log(`scratch: ${scratch}\nshots: ${shots}`)
process.exit(failures ? 1 : 0)
