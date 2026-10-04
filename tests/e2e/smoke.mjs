// End-to-end smoke test: drives the built app with Playwright on a scratch clone of a board repo,
// with a stand-in `claude` that records its arguments, so nothing real is started or billed.
//
//   npm run build && node tests/e2e/smoke.mjs [board repo to clone]
//
// Screenshots go to $SHOT_DIR (default: ./test-results). Exits 1 on the first failed check.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
// The board repo as it was imported (its first commit), so the checks never depend on what the
// boards hold today.
const seed = path.join(scratch, 'seed')
execFileSync('git', ['clone', '-q', source, seed])
const firstCommit = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: seed }).toString().trim().split('\n')[0]
execFileSync('git', ['checkout', '-q', '-B', 'main', firstCommit], { cwd: seed })
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
execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', 'Fix eye attacks\n\nCard: RS-967'], { cwd: codeRepo })
const rsMeta = JSON.parse(readFileSync(path.join(root, 'robot-shooter/board.json'), 'utf8'))
rsMeta.codeRepo = codeRepo
writeFileSync(path.join(root, 'robot-shooter/board.json'), `${JSON.stringify(rsMeta, null, 2)}\n`)
execFileSync('git', ['commit', '-qam', 'e2e: point at the scratch code repo'], { cwd: root })

const fakeLog = path.join(scratch, 'claude-calls.txt')
const urlLog = path.join(scratch, 'opened-urls.txt')
const openedUrls = () => (existsSync(urlLog) ? readFileSync(urlLog, 'utf8').split('\n').filter(Boolean) : [])
/** The stand-in's calls that started sessions (the app also asks it for --version). */
const sessionCalls = () =>
  existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n--\n').filter(c => c && !c.startsWith('--version')) : []
const fakeClaude = path.join(scratch, 'fake-claude')
// Records its argv, then parses it the way Claude Code does (--add-dir takes every argument up to
// the next option), so a prompt an option swallowed shows up on screen as "prompt=none".
writeFileSync(
  fakeClaude,
  [
    '#!/bin/bash',
    `printf '%s\\0' "$@" >> ${JSON.stringify(fakeLog)}`,
    `printf '\\n--\\n' >> ${JSON.stringify(fakeLog)}`,
    'cloud=no; [ "$1" = "--cloud" ] && cloud=yes',
    'prompt=none',
    'while [ $# -gt 0 ]; do case "$1" in',
    '  --add-dir) shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do shift; done ;;',
    '  -n|--session-id|-w|--resume) shift 2 ;;',
    '  --cloud) [ $# -gt 1 ] && prompt=given; shift 2 ;;',
    '  --version|update) shift ;;',
    '  *) prompt=given; shift ;;',
    'esac; done',
    'echo "FAKE CLAUDE in $PWD prompt=$prompt"',
    'if [ $cloud = yes ]; then echo "Created https://claude.ai/code/session_fake123"; fi',
    '',
  ].join('\n'),
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
    // claude:// links are written to a file, and the desktop app's session index is a scratch one.
    CORKBOARD_OPEN_URL_LOG: urlLog,
    CORKBOARD_DESKTOP_SESSIONS_DIR: path.join(scratch, 'desktop-sessions'),
    CORKBOARD_CLAUDE_PROJECTS_DIR: path.join(scratch, 'claude-projects'),
    CORKBOARD_DESKTOP_POLL_MS: '300',
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

  // ---- backdrops: one per list; dropping a card on another moves it there ----
  const ideasMeta = JSON.parse(readFileSync(path.join(root, 'robot-shooter/ideas/board.json'), 'utf8'))
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
  const moverFile = path.join(root, 'robot-shooter/ideas/cards', `${mapMoverId}.md`)
  check(await until(() => readFileSync(moverFile, 'utf8').includes(`list: ${toList}`)), `dropping ${mapMoverId} on the ${toList} backdrop moved it there`)
  const savedMap = JSON.parse(readFileSync(path.join(root, 'robot-shooter/ideas/map.json'), 'utf8'))
  check(!!savedMap.areas?.[fromList] && !!savedMap.areas?.[toList], 'backdrops are saved in map.json')

  // Right-click a backdrop: Automatically lay out puts its cards back in columns inside it.
  await secondArea.locator('.area-head').click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Automatically lay out/ }).click()
  const laidOut = await until(() => {
    const map = JSON.parse(readFileSync(path.join(root, 'robot-shooter/ideas/map.json'), 'utf8'))
    const a = map.areas[toList]
    const p = map.nodes[mapMoverId]
    return a && p && p.x >= a.x && p.y >= a.y && p.x + 230 <= a.x + a.w && p.y <= a.y + a.h ? map : null
  })
  check(!!laidOut, 'Automatically lay out keeps the cards inside their backdrop')
  await shot('13-map-backdrops')

  // Double-click empty space: an input; Escape (or nothing typed) adds no card.
  const cardsBefore = readdirSync(path.join(root, 'robot-shooter/ideas/cards')).length
  const pane = await page.locator('.react-flow__pane').boundingBox()
  // A spot where the pointer meets the canvas itself (not a card, the controls or the minimap).
  const findEmpty = () => page.evaluate(box => {
    for (let y = box.y + 40; y < box.y + box.height - 40; y += 23) {
      for (let x = box.x + 80; x < box.x + box.width - 260; x += 37) {
        const el = document.elementFromPoint(x, y)
        if (el?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    return null
  }, pane)
  const emptyAt = await findEmpty()
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.locator('.map-new-card input').waitFor()
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await page.locator('.map-new-card').count()) === 0 && readdirSync(path.join(root, 'robot-shooter/ideas/cards')).length === cardsBefore, 'Escape on a new map card adds nothing')
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.locator('.map-new-card input').waitFor()
  await page.mouse.click(pane.x + pane.width / 2, pane.y + 20)
  await sleep(300)
  check(readdirSync(path.join(root, 'robot-shooter/ideas/cards')).length === cardsBefore, 'an empty new card left by clicking away adds nothing')
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.keyboard.type('Typed on the map')
  await page.keyboard.press('Enter')
  check(await until(() => readdirSync(path.join(root, 'robot-shooter/ideas/cards')).length === cardsBefore + 1), 'a typed title adds the card')

  // Drag a card's dot to empty space: an input for a new card linked from it.
  const linker = page.locator('.react-flow__node-card').first()
  const linkerId = await linker.getAttribute('data-id')
  await linker.hover()
  const dot = await linker.locator('.react-flow__handle-right').boundingBox()
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
  await page.mouse.down()
  const freeAt = await findEmpty()
  await page.mouse.move(freeAt.x, freeAt.y, { steps: 15 })
  await page.mouse.up()
  await page.locator('.map-new-card input').waitFor()
  check((await page.locator('.map-new-card', { hasText: `linked from ${linkerId}` }).count()) === 1, 'dragging a dot to empty space opens a linked new card')
  await page.keyboard.type('Grown from a link')
  await page.keyboard.press('Enter')
  const grown = await until(() => {
    const dir = path.join(root, 'robot-shooter/ideas/cards')
    const f = readdirSync(dir).map(n => readFileSync(path.join(dir, n), 'utf8')).find(t => t.includes('title: Grown from a link'))
    return f ? /id: (\S+)/.exec(f)[1] : null
  })
  check(!!grown && (await until(() => readFileSync(path.join(root, 'robot-shooter/ideas/cards', `${linkerId}.md`), 'utf8').includes(grown))), `the new card ${grown} is linked from ${linkerId}`)

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

  // ---- the board repo commits itself ----
  const log = await until(() => {
    const out = execFileSync('git', ['log', '--format=%B', '-5'], { cwd: root }).toString()
    return out.includes('SB-1') ? out : ''
  }, 8000)
  check(!!log, `board repo auto-committed:\n${log}`)

  // ---- card detail, commits and tackling ----
  await page.locator('.tab[title$=":robot-shooter"]').click()
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
  const tackled = readFileSync(path.join(root, 'robot-shooter/cards', `${tackleId}.md`), 'utf8')
  check(tackled.includes('sessions:') && tackled.includes('kind: local'), 'the session is recorded on the card')

  // Forget it again from the drawer.
  await page.locator('.drawer .sessions li').first().waitFor()
  await page.locator('.drawer').getByRole('button', { name: 'Forget this session' }).first().click()
  const forgotten = await until(() => !readFileSync(path.join(root, 'robot-shooter/cards', `${tackleId}.md`), 'utf8').includes('sessions:'))
  check(forgotten, 'forgetting the session takes it off the card')
  check((await page.locator('.drawer .sessions li').count()) === 0, 'and off the drawer')

  // ---- Claude desktop: a claude://code/new link, then the session found in its index ----
  const cardFileOf = id => path.join(root, 'robot-shooter/cards', `${id}.md`)
  await page.locator('.drawer').getByRole('button', { name: 'Claude desktop' }).click()
  const newLink = await until(() => openedUrls().find(u => u.startsWith('claude://code/new?')))
  check(!!newLink, 'Claude desktop opened a claude://code/new link')
  const linkParams = new URL(newLink).searchParams
  check(linkParams.get('q')?.startsWith(`Tackle card ${tackleId}`) ?? false, 'the link carries the prompt')
  check(linkParams.getAll('folder').join() === [codeRepo, root].join(), `with the code repo and the board repo as folders`)
  check(await until(() => readFileSync(cardFileOf(tackleId), 'utf8').includes('kind: desktop')), 'the desktop session is recorded')
  check((await page.locator('.drawer .sessions li', { hasText: 'waiting' }).count()) === 1, 'waiting until its prompt is sent')
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
  const cloudUrl = await until(() => readFileSync(path.join(root, 'robot-shooter/cards', `${cloudId}.md`), 'utf8').includes('claude.ai/code/session_fake123'), 15000)
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
  const otherCard = path.join(otherMachine, 'robot-shooter/cards/RS-961.md')
  writeFileSync(otherCard, readFileSync(otherCard, 'utf8').replace(/^title: .*$/m, 'title: Renamed on the other machine').replace(/^updated: .*$/m, `updated: ${new Date().toISOString()}`))
  execFileSync('git', ['commit', '-qam', 'Rename RS-961 elsewhere'], { cwd: otherMachine })
  execFileSync('git', ['push', '-q'], { cwd: otherMachine })
  await syncNow()
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

  // ---- a finished card shows no session badge; an open one does ----
  await page.locator('.tab[title="deus-board:robot-shooter"], .tab[title$=":robot-shooter"]').first().click()
  await page.getByRole('tab', { name: 'Board', exact: true }).click()
  await page.locator('.filter').fill('RS-967')
  await page.locator('.card[data-card="RS-967"]').first().waitFor()
  check(readFileSync(cardFileOf('RS-967'), 'utf8').includes('sessions:') && (await page.locator('.card[data-card="RS-967"] .badge.session').count()) === 0, 'a card in Done keeps its sessions but shows no session badge')
  await page.locator('.filter').fill('')
  check((await page.locator('.column[data-list="todo"] .badge.session').count()) > 0, 'an open card with sessions shows the badge')

  // ---- projects: add one, move a board into it, delete a board with cards ----
  const second = path.join(scratch, 'second-board')
  await page.locator('.sidebar-foot').getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('dialog').getByLabel('Board repo folder').fill(second)
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Side project')
  await page.getByRole('dialog').getByRole('button', { name: 'Add project' }).click()
  await page.locator('.project-row', { hasText: 'Side project' }).waitFor()
  check(existsSync(path.join(second, '.git')), 'a new project folder becomes a git repo')
  check((await page.locator('.project-row').count()) === 2, 'the side panel shows both projects')
  await page.locator('.tree-row', { hasText: 'Untitled shooter' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Move to project' }).hover()
  await page.getByRole('menuitem', { name: 'Side project' }).click()
  await page.getByRole('button', { name: 'Move board' }).click()
  const movedBoard = await until(() => existsSync(path.join(second, 'untitled-shooter/board.json')) && !existsSync(path.join(root, 'untitled-shooter')))
  check(movedBoard, 'Untitled shooter moved into the other project, folder and cards')
  check(readdirSync(path.join(second, 'untitled-shooter/cards')).length === 29, 'with its 29 cards')
  await page.locator('.project[data-project] .tree-row', { hasText: 'Untitled shooter' }).waitFor()
  const secondLogHas = text => {
    try {
      return execFileSync('git', ['log', '--format=%B'], { cwd: second, stdio: 'pipe' }).toString().includes(text)
    } catch {
      return false // no commit yet
    }
  }
  check(!!(await until(() => secondLogHas('Create board untitled-shooter'), 12000)), 'the other project commits the board it received')
  await shot('14-projects')
  await page.locator('.tree-row', { hasText: 'Untitled shooter' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Delete board/ }).click()
  const deleteButton = page.getByRole('dialog').getByRole('button', { name: 'Delete board' })
  check(await deleteButton.isDisabled(), 'deleting a board with cards waits for its name')
  await page.getByRole('dialog').getByLabel(/Type the board's name/).fill('Untitled shooter')
  await deleteButton.click()
  check(await until(() => !existsSync(path.join(second, 'untitled-shooter'))), 'typing the name deletes the board and its cards')
  const deleted = await until(() => secondLogHas('Delete board untitled-shooter'), 12000)
  check(!!deleted, 'and commits the deletion')

  // Table view.
  await page.locator('.tab[title$=":robot-shooter"]').click()
  await page.getByRole('tab', { name: 'Table', exact: true }).click()
  check((await page.locator('tbody tr').count()) > 100, 'table lists the cards')
  await shot('07-table')
} catch (error) {
  console.log('FAIL', error)
  failures++
  await shot('99-failure').catch(() => {})
} finally {
  await app.close()
}

writeFileSync(path.join(shots, 'main-process.log'), mainLog.join(''))
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
console.log(`scratch: ${scratch}\nshots: ${shots}`)
process.exit(failures ? 1 : 0)
