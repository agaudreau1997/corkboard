// End-to-end smoke test: drives the built app with Playwright on a scratch clone of a board repo,
// with a stand-in `claude` that records its arguments, so nothing real is started or billed.
//
//   npm run build && node tests/e2e/smoke.mjs [board repo to clone]
//
// Screenshots go to $SHOT_DIR (default: ./test-results). Exits 1 on the first failed check.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '../..')
const source = process.argv[2] ?? path.join(os.homedir(), 'Documents/Godot/Projects/deus-board')
const shots = process.env.SHOT_DIR ?? path.join(appDir, 'test-results')
mkdirSync(shots, { recursive: true })

const scratch = mkdtempSync(path.join(os.tmpdir(), 'corkboard-e2e-'))
const root = path.join(scratch, 'board')
const codeRepo = path.join(scratch, 'code')
// A scratch bare remote, so the app's sync pushes there and never to the real board repo; a
// second clone of it plays the other machine.
const remote = path.join(scratch, 'remote.git')
const otherMachine = path.join(scratch, 'other-machine')
execFileSync('git', ['clone', '-q', '--bare', source, remote])
execFileSync('git', ['clone', '-q', remote, root])
execFileSync('git', ['clone', '-q', remote, otherMachine])
for (const dir of [root, otherMachine]) {
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
}
// A code repo with a commit naming a card, so the card shows it.
mkdirSync(codeRepo)
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: codeRepo })
execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', 'Fix eye attacks\n\nCard: RS-967'], { cwd: codeRepo })
const rsMeta = JSON.parse(readFileSync(path.join(root, 'robot-shooter/board.json'), 'utf8'))
rsMeta.codeRepo = codeRepo
writeFileSync(path.join(root, 'robot-shooter/board.json'), `${JSON.stringify(rsMeta, null, 2)}\n`)
execFileSync('git', ['commit', '-qam', 'e2e: point at the scratch code repo'], { cwd: root })

const fakeLog = path.join(scratch, 'claude-calls.txt')
/** The stand-in's calls that started sessions (the app also asks it for --version). */
const sessionCalls = () =>
  existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n--\n').filter(c => c && !c.startsWith('--version')) : []
const fakeClaude = path.join(scratch, 'fake-claude')
writeFileSync(
  fakeClaude,
  `#!/bin/bash\nprintf '%s\\0' "$@" >> ${JSON.stringify(fakeLog)}\nprintf '\\n--\\n' >> ${JSON.stringify(fakeLog)}\n` +
    `echo "FAKE CLAUDE in $PWD"\nif [ "$1" = "--cloud" ]; then echo "Created https://claude.ai/code/session_fake123"; fi\n`,
)
chmodSync(fakeClaude, 0o755)

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

const app = await electron.launch({
  args: [path.join(appDir, 'out/main/index.js')],
  cwd: appDir,
  env: {
    ...process.env,
    CORKBOARD_ROOT: root,
    CORKBOARD_USER_DATA: path.join(scratch, 'profile'),
    CORKBOARD_HIDDEN: process.env.CORKBOARD_HIDDEN ?? '1',
    CORKBOARD_COMMIT_DELAY_MS: '600',
    CORKBOARD_SYNC_INTERVAL_MS: '0',
    CORKBOARD_CLAUDE_BIN: fakeClaude,
  },
})
const page = await app.firstWindow()
page.on('pageerror', e => {
  console.log('PAGE ERROR', e.message)
  failures++
})
page.on('console', m => m.type() === 'error' && console.log('console.error:', m.text()))
await page.setViewportSize({ width: 1500, height: 940 }).catch(() => {})
const shot = async name => page.screenshot({ path: path.join(shots, `${name}.png`) })

try {
  // ---- the tree and tabs ----
  await page.getByRole('treeitem').first().waitFor()
  const rows = await page.locator('.tree-row .tree-title').allTextContents()
  check(rows.includes('Robot shooter') && rows.includes('Untitled shooter'), `tree roots: ${rows.join(', ')}`)
  await page.locator('.tree-row', { hasText: 'Robot shooter' }).first().locator('.twisty').click()
  const children = await page.locator('.tree-row .tree-title').allTextContents()
  check(['Ideas', 'Narrative & lore', 'Performance'].every(t => children.includes(t)), 'child boards listed under Robot shooter')

  await page.locator('.tree-row', { hasText: 'Robot shooter' }).first().click()
  await page.locator('.column').first().waitFor()
  const columns = await page.locator('.column-title').allTextContents()
  check(columns[0] === 'todo' && columns.includes('ToDoing Prime') && columns.includes('Done'), `kanban columns: ${columns.join(' | ')}`)
  const done = page.locator('.column[data-list="done"]')
  check((await done.locator('.card').count()) === 60 && (await done.getByText(/Show all/).count()) === 1, 'Done column capped at 60 with a Show all')
  check((await page.locator('.divider-card').count()) > 0, 'dashes cards draw as dividers')
  await shot('01-kanban')

  // Second tab, map view.
  await page.locator('.tree-row', { hasText: 'Ideas' }).click()
  check((await page.locator('.tab').count()) === 2, 'a second tab opened')
  await page.getByRole('tab', { name: 'Map' }).click()
  await page.locator('.map-node').first().waitFor()
  check((await page.locator('.map-node').count()) > 30, `map draws the open idea cards (${await page.locator('.map-node').count()})`)
  await shot('02-map')

  // Link two ideas by dragging handle to node.
  const nodes = page.locator('.react-flow__node')
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
    readFileSync(path.join(root, 'robot-shooter/ideas/cards', `${aId}.md`), 'utf8').includes(bId),
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
    const map = JSON.parse(readFileSync(path.join(root, 'robot-shooter/ideas/map.json'), 'utf8'))
    return map.nodes[bId]
  })
  check(!!placed, `moving ${bId} saved its position to map.json`)
  await sleep(300)
  const cAfter = await c.boundingBox()
  check(Math.abs(cAfter.x - cBefore.x) < 1 && Math.abs(cAfter.y - cBefore.y) < 1, 'the other cards stay where they were')
  const pinned = Object.keys(JSON.parse(readFileSync(path.join(root, 'robot-shooter/ideas/map.json'), 'utf8')).nodes).length
  check(pinned === (await page.locator('.map-node').count()), `the drag pinned every card on the map (${pinned})`)
  await shot('03-map-linked')

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
  await page.locator('.column[data-list="bugs"] .column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Collapse list' }).click()
  check((await page.locator('.column.collapsed[data-list="bugs"]').count()) === 1, 'the list menu collapses a list')
  await page.locator('.column.collapsed[data-list="bugs"]').click()

  // ---- a change made on disk shows up live (what a Claude session does) ----
  const file = path.join(root, 'scratch-board/cards/SB-1.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('list: done', 'list: doing'))
  const live = await until(async () => (await page.locator('.column[data-list="doing"] .card', { hasText: 'Drag me to done' }).count()) === 1)
  check(live, 'a card file edited on disk moved columns on screen')

  // ---- the board repo commits itself ----
  const log = await until(() => {
    const out = execFileSync('git', ['log', '--format=%B', '-5'], { cwd: root }).toString()
    return out.includes('SB-1') ? out : ''
  }, 8000)
  check(!!log, `board repo auto-committed:\n${log}`)

  // ---- card detail, commits and tackling ----
  await page.locator('.tab[title="robot-shooter"]').click()
  await page.locator('.column[data-list="tofix"] .card').first().click()
  await page.locator('.drawer').waitFor()
  const openId = (await page.locator('.drawer .card-id').textContent()).trim()
  check(openId.startsWith('RS-'), `drawer opened for ${openId}`)
  await shot('04-drawer')

  // RS-967 has a commit in the scratch code repo.
  await page.locator('.filter').fill('RS-967')
  await page.locator('.card', { hasText: 'RS-967' }).first().click()
  check((await until(async () => (await page.locator('.drawer .commits li').count()) === 1)) === true, 'RS-967 lists its Card: commit')
  check((await page.locator('.card[data-card="RS-967"] .badge.commit').count()) === 1, 'the card face shows the commit badge')
  await page.locator('.filter').fill('')

  const tackleId = (await page.locator('.drawer .card-id').textContent()).trim()
  await page.locator('.drawer').getByRole('button', { name: 'Tackle locally' }).click()
  await page.locator('.terminal-tab').first().waitFor()
  const termText = await until(async () => {
    const t = await page.locator('.xterm-rows').first().textContent()
    return t?.includes('FAKE CLAUDE') ? t : ''
  }, 15000)
  check(!!termText, 'tackle opened a terminal running claude')
  const calls = sessionCalls()
  const args = calls[0].split('\0')
  check(args.includes('--session-id') && args.includes('--add-dir') && args.includes('-n'), `claude args: ${args.slice(0, 7).join(' ')}`)
  check(args.at(-2)?.includes(`Tackle card ${tackleId}`) ?? false, `the prompt names ${tackleId}`)
  const tackled = readFileSync(path.join(root, 'robot-shooter/cards', `${tackleId}.md`), 'utf8')
  check(tackled.includes('sessions:') && tackled.includes('kind: local'), 'the session is recorded on the card')
  await shot('05-terminal')

  // Tackle a whole list in parallel: one terminal per card.
  const before = await page.locator('.terminal-tab').count()
  const prime = page.locator('.column[data-list="todo"]')
  const primeCount = await prime.locator('.card').count()
  await prime.locator('.column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Tackle all' }).hover()
  await page.getByRole('menuitem', { name: /Locally, in parallel/ }).click()
  await page.getByRole('button', { name: /Start \d+ sessions/ }).click()
  const after = await until(async () => ((await page.locator('.terminal-tab').count()) === before + primeCount ? true : false), 15000)
  check(after, `parallel tackle opened ${primeCount} terminals`)
  await sleep(1500)
  const worktreeCalls = sessionCalls().slice(1)
  check(worktreeCalls.every(c => c.split('\0').includes('-w')), 'each parallel session runs in a worktree')

  // Cloud: asks first, then records the printed URL.
  await page.locator('.column[data-list="tofix"] .card').first().click()
  const cloudId = (await page.locator('.drawer .card-id').textContent()).trim()
  await page.locator('.drawer').getByRole('button', { name: 'Claude Cloud' }).click()
  check((await page.getByRole('dialog').count()) === 1, 'cloud tackle asks for confirmation')
  await page.getByRole('button', { name: 'Start cloud session' }).click()
  const cloudUrl = await until(() => readFileSync(path.join(root, 'robot-shooter/cards', `${cloudId}.md`), 'utf8').includes('claude.ai/code/session_fake123'), 15000)
  check(cloudUrl, 'the cloud session URL printed by claude is saved on the card')

  // Cloud, one session per card, from the list menu.
  const callsBefore = sessionCalls().length
  await prime.locator('.column-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Tackle all' }).hover()
  await page.getByRole('menuitem', { name: /one session per card/ }).click()
  await page.getByRole('button', { name: new RegExp(`Start ${primeCount} cloud sessions`) }).click()
  const cloudEach = await until(() => {
    const calls = sessionCalls().slice(callsBefore)
    return calls.length === primeCount && calls.every(c => c.startsWith('--cloud')) ? calls : null
  }, 15000)
  check(!!cloudEach, `cloud one-per-card started ${primeCount} cloud sessions`)

  // ---- card menu: copy the id, move the card to another board ----
  const mover = page.locator('.column[data-list="todo"] .card').first()
  const moverId = await mover.getAttribute('data-card')
  await mover.click({ button: 'right' })
  await shot('09-card-menu')
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Identifier/ }).click()
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(copied === moverId, `Copy › Identifier put ${copied} on the clipboard`)

  await page.locator(`.card[data-card="${moverId}"]`).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Move to board' }).hover()
  await page.getByRole('menuitem', { name: 'Robot shooter / Ideas' }).hover()
  await sleep(150)
  await shot('10-move-to-board')
  await page.getByRole('menuitem', { name: 'Considering' }).click()
  const movedFile = path.join(root, 'robot-shooter/ideas/cards', `${moverId}.md`)
  const movedOver = await until(() => existsSync(movedFile) && !existsSync(path.join(root, 'robot-shooter/cards', `${moverId}.md`)))
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
  await page.locator('.sidebar-foot').getByRole('button', { name: 'Sync' }).click()
  const synced = await until(async () => (await page.locator('.sync-synced').count()) === 1, 15000)
  check(synced, 'the sync line reads Synced')
  const remoteLog = execFileSync('git', ['log', '--format=%B', '-30', 'main'], { cwd: remote }).toString()
  check(remoteLog.includes('SB-1'), 'the board commits reached the remote')
  execFileSync('git', ['pull', '-q'], { cwd: otherMachine })
  const otherCard = path.join(otherMachine, 'robot-shooter/cards/RS-961.md')
  writeFileSync(otherCard, readFileSync(otherCard, 'utf8').replace(/^title: .*$/m, 'title: Renamed on the other machine').replace(/^updated: .*$/m, `updated: ${new Date().toISOString()}`))
  execFileSync('git', ['commit', '-qam', 'Rename RS-961 elsewhere'], { cwd: otherMachine })
  execFileSync('git', ['push', '-q'], { cwd: otherMachine })
  await page.locator('.sidebar-foot').getByRole('button', { name: 'Sync' }).click()
  const pulled = await until(async () => (await page.locator('.card[data-card="RS-961"]', { hasText: 'Renamed on the other machine' }).count()) === 1, 15000)
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

  // Table view.
  await page.getByRole('tab', { name: 'Table' }).click()
  check((await page.locator('tbody tr').count()) > 100, 'table lists the cards')
  await shot('07-table')
} catch (error) {
  console.log('FAIL', error)
  failures++
  await shot('99-failure').catch(() => {})
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
console.log(`scratch: ${scratch}\nshots: ${shots}`)
process.exit(failures ? 1 : 0)
