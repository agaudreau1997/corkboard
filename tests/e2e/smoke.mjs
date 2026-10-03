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
execFileSync('git', ['clone', '-q', source, root])
for (const dir of [root]) {
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
  const calls = readFileSync(fakeLog, 'utf8').split('\n--\n').filter(Boolean)
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
  await prime.getByRole('button', { name: /Tackle all/ }).click()
  await page.getByRole('menuitem', { name: /in parallel/ }).click()
  await page.getByRole('button', { name: /Start \d+ sessions/ }).click()
  const after = await until(async () => ((await page.locator('.terminal-tab').count()) === before + primeCount ? true : false), 15000)
  check(after, `parallel tackle opened ${primeCount} terminals`)
  await sleep(1500)
  const worktreeCalls = readFileSync(fakeLog, 'utf8').split('\n--\n').filter(Boolean).slice(1)
  check(worktreeCalls.every(c => c.split('\0').includes('-w')), 'each parallel session runs in a worktree')

  // Cloud: asks first, then records the printed URL.
  await page.locator('.column[data-list="tofix"] .card').first().click()
  const cloudId = (await page.locator('.drawer .card-id').textContent()).trim()
  await page.locator('.drawer').getByRole('button', { name: 'Claude Cloud' }).click()
  check((await page.getByRole('dialog').count()) === 1, 'cloud tackle asks for confirmation')
  await page.getByRole('button', { name: 'Start cloud session' }).click()
  const cloudUrl = await until(() => readFileSync(path.join(root, 'robot-shooter/cards', `${cloudId}.md`), 'utf8').includes('claude.ai/code/session_fake123'), 15000)
  check(cloudUrl, 'the cloud session URL printed by claude is saved on the card')

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
