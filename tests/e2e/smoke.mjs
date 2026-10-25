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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { CHILDREN, COMMITTED, IDEAS, KEYED, MAIN, SPARE, TO_FIX, UNKEYED, WORK, writeFixture, writeWorkFixture } from './fixture.mjs'

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
// A code repo with a commit naming a card, so the card shows it, and one naming a Jira key, which
// the work project's card shows (the personal project ignores it: no trailer).
mkdirSync(codeRepo)
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: codeRepo })
execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', `Fix the drill sound\n\nCard: ${COMMITTED}`], { cwd: codeRepo })
execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', `${KEYED.jira} Fix the login form on Safari`], { cwd: codeRepo })
// Its own scratch bare remote, not pushed to yet: the code repo panel pushes it there (setting the
// upstream), and pulls what a second clone pushed.
const codeRemote = path.join(scratch, 'code-remote.git')
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', codeRemote])
execFileSync('git', ['remote', 'add', 'origin', codeRemote], { cwd: codeRepo })
// The work project's board repo: no remote, added to the app during the test.
const workRoot = path.join(scratch, 'client-boards')
mkdirSync(workRoot)
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workRoot })
writeWorkFixture(workRoot, codeRepo)
execFileSync('git', ['add', '-A'], { cwd: workRoot })
execFileSync('git', ['commit', '-q', '-m', 'The client boards'], { cwd: workRoot, env: { ...process.env, ...gitIdentity } })
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
// Records its argv, then parses it the way Claude Code does (--add-dir and --mcp-config take every
// argument up to the next option), so a prompt an option swallowed shows up on screen as "prompt=none". It is a
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
    "  if (a === '--add-dir' || a === '--mcp-config') for (i++; i < argv.length && !argv[i].startsWith('-'); i++);",
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

// The notification program (set in the app's settings): records each event it gets, one per line,
// as a .cmd on Windows and a shell script elsewhere, the two kinds a person would write.
const notifyLog = path.join(scratch, 'notifications.txt')
const fakeNotify = path.join(scratch, process.platform === 'win32' ? 'fake-notify.cmd' : 'fake-notify')
writeFileSync(
  fakeNotify,
  process.platform === 'win32'
    ? `@echo off\r\n>>"${notifyLog}" echo %CORKBOARD_EVENT% %CORKBOARD_PREVIOUS% %3\r\n`
    : `#!/bin/sh\necho "$CORKBOARD_EVENT $CORKBOARD_PREVIOUS $3" >> '${notifyLog}'\n`,
)
chmodSync(fakeNotify, 0o755)
// The desktop notifications, written to a file rather than shown (CORKBOARD_NOTIFY_LOG).
const noticeLog = path.join(scratch, 'desktop-notices.txt')
const notices = () => (existsSync(noticeLog) ? readFileSync(noticeLog, 'utf8').split(/\r?\n/).filter(Boolean) : [])
const notifications = () => (existsSync(notifyLog) ? readFileSync(notifyLog, 'utf8').split(/\r?\n/).filter(Boolean) : [])

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
/** The card files in a cards folder: not the `.tmp` files the store writes before renaming them. */
const cardFiles = dir => readdirSync(dir).filter(n => n.endsWith('.md'))
/** Their texts, without one renamed or removed between the listing and the read. */
const cardTexts = dir =>
  cardFiles(dir).flatMap(n => {
    try {
      return [readFileSync(path.join(dir, n), 'utf8')]
    } catch {
      return []
    }
  })
async function until(fn, ms = 6000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return v
    await sleep(100)
  }
}

// The app's MCP server listens on a port free right now (CORKBOARD_MCP_PORT), never on the
// installed app's or a dev build's own.
const mcpPort = await new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
/** One JSON-RPC call to the MCP server, as a session's Claude Code makes it. */
let rpcId = 0
async function mcpCall(url, token, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}
/** A tool's answer: its JSON, or its error text. */
async function mcpTool(url, token, name, args) {
  const { json } = await mcpCall(url, token, 'tools/call', { name, arguments: args })
  const text = json?.result?.content?.[0]?.text ?? ''
  if (json?.result?.isError) return { error: text }
  return JSON.parse(text)
}

const packaged = process.env.CORKBOARD_E2E_EXECUTABLE
// Launched twice: the second time checks what this machine remembers (the side panel's order and
// its rail) after a quit.
const launchApp = () => electron.launch({
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
    CORKBOARD_MCP_PORT: String(mcpPort),
    // The settings' Browse… for the notification program answers the stand-in.
    CORKBOARD_PICK_FILE: fakeNotify,
    CORKBOARD_NOTIFY_LOG: noticeLog,
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
const app = await launchApp()
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
/** The side panel's order as the first run left it, for the restart to check. */
let rememberedOrder
try {
  // ---- the tree and tabs ----
  await page.getByRole('treeitem').first().waitFor()
  // The project's main board (the first top-level one by title, project.json naming none) is the
  // project's row: its child boards and the other top-level board are listed under the project.
  const rows = await page.locator('.tree-row .tree-title').allTextContents()
  check(CHILDREN.every(t => rows.includes(t)) && rows.includes(SPARE.title), `under the project, ${MAIN.title}'s child boards and ${SPARE.title} (${rows.join(', ')})`)
  check(!rows.includes(MAIN.title), `the main board ${MAIN.title} has no row of its own`)
  const projectRow = page.locator('.project-row').first()
  const projectTwisty = projectRow.locator('.twisty')
  check((await projectTwisty.locator('svg').count()) === 1, 'the arrow is a drawn chevron')
  const turned = () => projectTwisty.locator('svg').evaluate(el => getComputedStyle(el).transform)
  const openTurn = await turned()
  await projectTwisty.click()
  check(!!(await until(async () => (await page.locator('.tree-row').count()) === 0)), "the project's arrow folds its boards")
  check(!!(await until(async () => (await turned()) !== openTurn)), 'and the chevron turns')
  check((await page.locator('.tab').count()) === 0, 'without opening a board')
  await projectTwisty.click()
  check(!!(await until(async () => (await page.locator('.tree-row').count()) === rows.length)), 'a second click unfolds them')
  const { version } = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const updateLine = page.locator('.update-line.update-off')
  await until(async () => (await updateLine.count()) === 1)
  const versionLine = await updateLine.textContent().catch(() => 'no line')
  check(versionLine === `Corkboard ${version}`, `the side panel shows the version, with updates off (${versionLine})`)

  await projectRow.click()
  await page.locator('.column').first().waitFor()
  check(((await page.locator('.tab.active').getAttribute('title')) ?? '').endsWith(`:${MAIN.path}`), `a click on the project opens its main board, ${MAIN.title}`)
  check((await page.locator('.tree-row').count()) === rows.length, 'and folds nothing')
  check((await projectRow.getAttribute('class')).includes('active'), "the project's row shows its main board is in front")
  const columns = await page.locator('.column-title').allTextContents()
  check(columns[0] === 'To do' && columns.includes('Next up') && columns.includes('Done'), `kanban columns: ${columns.join(' | ')}`)
  const done = page.locator('.column[data-list="done"]')
  check((await done.locator('.card').count()) === 60 && (await done.getByText(/Show all/).count()) === 1, 'Done column capped at 60 with a Show all')
  // No list names a sort: the done list goes by last update, the others by their positions.
  const firstCard = list => page.locator(`.column[data-list="${list}"] .card`).first().getAttribute('data-card')
  check((await firstCard('done')) === COMMITTED, `the done list shows its last updated card first (${await firstCard('done')})`)
  check((await firstCard('todo')) === `${MAIN.key}-1`, `the other lists keep their cards in their positions (${await firstCard('todo')})`)
  check((await page.locator('.divider-card').count()) > 0, 'dashes cards draw as dividers')
  // A divider is still one 2 px line, in the middle of a grab area about 16 px tall that a hover
  // fills; a right-click near its edge opens its menu.
  const grabDivider = page.locator('.divider-card').first()
  const grabLook = () =>
    grabDivider.evaluate(el => {
      const box = el.getBoundingClientRect()
      const line = el.querySelector('span')
      const r = line.getBoundingClientRect()
      return {
        height: box.height,
        line: getComputedStyle(line).borderTopWidth,
        lineHeight: r.height,
        middle: Math.abs(r.y + r.height / 2 - (box.y + box.height / 2)),
        fill: getComputedStyle(el).backgroundColor,
        cursor: getComputedStyle(el).cursor,
      }
    })
  const grabRest = await grabLook()
  check(
    grabRest.height >= 15.5 && grabRest.line === '2px' && grabRest.lineHeight === 2 && grabRest.middle <= 1 && grabRest.cursor === 'grab',
    `a divider's grab area is about 16 px around its 2 px line (${JSON.stringify(grabRest)})`,
  )
  await grabDivider.scrollIntoViewIfNeeded()
  const grabBox = await grabDivider.boundingBox()
  await page.mouse.move(grabBox.x + grabBox.width / 2, grabBox.y + 2)
  const grabHover = await grabLook()
  check(grabHover.fill !== grabRest.fill, `a hover fills the divider's area (${grabRest.fill} → ${grabHover.fill})`)
  await page.mouse.click(grabBox.x + grabBox.width / 2, grabBox.y + 2, { button: 'right' })
  check((await page.locator('.ctx-menu').count()) === 1, "a right-click at the area's edge opens the divider's menu")
  await page.keyboard.press('Escape')
  await page.locator('.ctx-menu').waitFor({ state: 'detached' })
  // Grabbed by that edge, it drags (the card tray comes up); Escape puts it back.
  await page.mouse.move(grabBox.x + grabBox.width / 2, grabBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(grabBox.x + grabBox.width / 2 + 20, grabBox.y + 30, { steps: 6 })
  check(!!(await page.locator('.drag-tray.up').waitFor({ timeout: 3000 }).then(() => true, () => false)), 'a divider grabbed at the edge of its area drags')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.locator('.drag-tray.up').waitFor({ state: 'detached' })
  // A list as tall as the board runs into the terminal panel; a short one keeps its rounded bottom.
  const meetsPanel = async () => {
    const list = await done.boundingBox()
    const panel = await page.locator('.terminal-panel').boundingBox()
    return Math.abs(list.y + list.height - panel.y) <= 1
  }
  check((await until(async () => (await done.getAttribute('class')).includes('full'))) && (await meetsPanel()), 'a long list meets the terminal panel')
  const shortList = page.locator('.column[data-list]:not(.full)').first()
  check(
    (await shortList.count()) === 1 && (await shortList.evaluate(el => getComputedStyle(el).borderBottomLeftRadius)) !== '0px',
    'a short list keeps its rounded bottom',
  )
  // The board's sideways scrollbar, laid over its bottom edge, still scrolls it.
  await page.setViewportSize({ width: 900, height: 940 }).catch(() => {})
  const boardBar = page.locator('.kanban-scrollbar')
  check(await until(() => boardBar.isVisible()), 'a board wider than the window shows its sideways scrollbar')
  await boardBar.evaluate(el => (el.scrollLeft = 200))
  check(await until(async () => (await page.locator('.kanban').evaluate(el => el.scrollLeft)) === 200), 'the sideways scrollbar scrolls the board')
  await page.locator('.kanban').evaluate(el => (el.scrollLeft = 0))
  await page.setViewportSize({ width: 1500, height: 940 }).catch(() => {})
  await shot('01-kanban')

  // Second tab, map view.
  await page.locator('.tree-row', { hasText: IDEAS.title }).click()
  check((await page.locator('.tab').count()) === 2, 'a second tab opened')
  await page.getByRole('tab', { name: 'Map' }).click()
  await page.locator('.map-node').first().waitFor()
  check((await page.locator('.map-node').count()) > 30, `map draws the open idea cards (${await page.locator('.map-node').count()})`)
  await shot('02-map')

  // ---- mouse 4 and 5 go back and forward through the tabs and their views ----
  const where = () =>
    page.evaluate(() => ({
      tab: document.querySelector('.tab.active')?.getAttribute('title') ?? '',
      view: document.querySelector('.segmented .on')?.textContent ?? '',
    }))
  const mouseNav = button =>
    page.evaluate(b => {
      const opts = { button: b, bubbles: true, cancelable: true }
      document.querySelector('.board-pane').dispatchEvent(new MouseEvent('mousedown', opts))
      return !document.querySelector('.board-pane').dispatchEvent(new MouseEvent('mouseup', opts))
    }, button)
  const isAt = async (tab, view) => {
    const at = await until(async () => {
      const w = await where()
      return w.tab.endsWith(`:${tab}`) && w.view === view && w
    }, 2000)
    return !!at
  }
  const prevented = await mouseNav(3)
  check(prevented && (await isAt(IDEAS.path, 'Board')), `mouse 4 goes back to the tab's board view, and nothing else sees it (${JSON.stringify(await where())})`)
  await mouseNav(3)
  check(await isAt(MAIN.path, 'Board'), `mouse 4 again goes back to the tab before (${JSON.stringify(await where())})`)
  await mouseNav(4)
  await mouseNav(4)
  check(await isAt(IDEAS.path, 'Map'), `mouse 5 goes forward again (${JSON.stringify(await where())})`)
  await mouseNav(3)
  await page.getByRole('tab', { name: 'Table', exact: true }).click()
  await mouseNav(4)
  check(await isAt(IDEAS.path, 'Table'), `a view chosen after going back drops the way forward (${JSON.stringify(await where())})`)
  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  await page.locator('.map-node').first().waitFor()

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

  // Ctrl+Z takes back the map's last changes, the move then the link; Ctrl+Shift+Z puts them back.
  const aFile = path.join(root, IDEAS.path, 'cards', `${aId}.md`)
  const near = (p, q) => Math.abs(p.x - q.x) < 2 && Math.abs(p.y - q.y) < 2
  await page.locator('.map-toolbar .hint').click()
  await page.keyboard.press('Control+z')
  check(await until(async () => near(await b.boundingBox(), nb)), `Ctrl+Z puts ${bId} back where it was`)
  await page.keyboard.press('Control+z')
  check(await until(() => !readFileSync(aFile, 'utf8').includes(bId)), `a second Ctrl+Z unlinks ${aId} and ${bId}`)
  check(await until(async () => (await page.locator('.react-flow__edge').count()) === 0), 'the edge goes with the link')
  await page.keyboard.press('Control+Shift+z')
  check(await until(() => readFileSync(aFile, 'utf8').includes(bId)), 'Ctrl+Shift+Z links them again')
  await page.keyboard.press('Control+y')
  check(await until(async () => !near(await b.boundingBox(), nb)), `Ctrl+Y moves ${bId} again`)
  check(await until(() => readFileSync(path.join(root, IDEAS.path, 'map.json'), 'utf8').includes(`"${bId}"`)), 'the redone move is in map.json')

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
  // The drop is one step: Ctrl+Z takes the card back to its list and its place, Ctrl+Y redoes both.
  await page.keyboard.press('Control+z')
  check(await until(() => readFileSync(moverFile, 'utf8').includes(`list: ${fromList}`)), `Ctrl+Z takes ${mapMoverId} back to ${fromList}`)
  check(await until(async () => {
    const box = await mapMover.boundingBox()
    return Math.abs(box.x - mb.x) < 2 && Math.abs(box.y - mb.y) < 2
  }), `and back where it was on the map`)
  await page.keyboard.press('Control+y')
  check(await until(() => readFileSync(moverFile, 'utf8').includes(`list: ${toList}`)), `Ctrl+Y drops ${mapMoverId} on ${toList} again`)

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
  const cardsBefore = cardFiles(path.join(root, IDEAS.path, 'cards')).length
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
  check((await page.locator('.map-new-card').count()) === 0 && cardFiles(path.join(root, IDEAS.path, 'cards')).length === cardsBefore, 'Escape on a new map card adds nothing')
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.locator('.map-new-card input').waitFor()
  await page.mouse.click(pane.x + pane.width / 2, pane.y + 20)
  await sleep(300)
  check(cardFiles(path.join(root, IDEAS.path, 'cards')).length === cardsBefore, 'an empty new card left by clicking away adds nothing')
  await page.mouse.dblclick(emptyAt.x, emptyAt.y)
  await page.keyboard.type('Typed on the map')
  await page.keyboard.press('Enter')
  check(await until(() => cardFiles(path.join(root, IDEAS.path, 'cards')).length === cardsBefore + 1), 'a typed title adds the card')

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
    const f = cardTexts(dir).find(t => t.includes('title: Grown from a link'))
    return f ? /id: (\S+)/.exec(f)[1] : null
  })
  check(!!grown && (await until(() => readFileSync(path.join(root, IDEAS.path, 'cards', `${linkerId}.md`), 'utf8').includes(grown))), `the new card ${grown} is linked from ${linkerId}`)

  // ---- a new board, a card, a drag ----
  await page.locator('.project-row').first().click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'New board…' }).click()
  await page.getByLabel('Title').fill('Scratch board')
  await page.getByRole('button', { name: 'Create board' }).click()
  await page.locator('.column-title', { hasText: 'To do' }).waitFor()
  check(existsSync(path.join(root, 'scratch-board/board.json')), 'new board folder written')
  check((await page.locator('.tab').count()) === 3, 'new board opened in its own tab')
  const todo = page.locator('.column[data-list="todo"]')
  await todo.getByText('+ Add a card').click()
  const adder = await todo.locator('.add-card-form textarea').evaluate(el => getComputedStyle(el).resize)
  check(adder === 'none', `the add-a-card field has no resize grip (${adder})`)
  const adderFill = await todo.locator('.add-card-form textarea').evaluate(el => getComputedStyle(el).backgroundColor)
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

  // ---- a selection moves together: grab one of the selected cards, drop them all in Done ----
  for (const title of ['Group one', 'Group two']) {
    await todo.getByText('+ Add a card').click()
    await todo.locator('textarea').waitFor()
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await todo.locator('.card', { hasText: title }).waitFor()
  }
  const groupOne = todo.locator('.card', { hasText: 'Group one' })
  const groupTwo = todo.locator('.card', { hasText: 'Group two' })
  await groupOne.click({ modifiers: ['Control'] })
  await groupTwo.click({ modifiers: ['Control'] })
  check((await todo.locator('.card.selected').count()) === 2, 'Ctrl-click selects two cards')
  const gb = await groupTwo.boundingBox()
  const doneBody = await page.locator('.column[data-list="done"] .column-body').boundingBox()
  await page.mouse.move(gb.x + 40, gb.y + 12)
  await page.mouse.down()
  await page.mouse.move(gb.x + 60, gb.y + 20, { steps: 4 })
  await page.locator('.drag-count', { hasText: '2' }).waitFor()
  check((await todo.locator('.card', { hasText: 'Group one' }).count()) === 0, 'the rest of the selection folds into the dragged card')
  await page.mouse.move(doneBody.x + 60, doneBody.y + doneBody.height - 10, { steps: 20 })
  await sleep(150)
  await shot('08b-drag-selection')
  await page.mouse.up()
  const groupFiles = () => cardTexts(path.join(root, 'scratch-board/cards')).filter(t => /title: Group (one|two)/.test(t))
  check(
    await until(() => groupFiles().length === 2 && groupFiles().every(t => t.includes('list: done'))),
    'dragging one selected card moved the whole selection to Done',
  )
  const doneTitles = await page.locator('.column[data-list="done"] .card-title').allTextContents()
  // Done sorts itself by last update, so the pair lands together but in either order.
  const one = doneTitles.indexOf('Group one')
  const two = doneTitles.indexOf('Group two')
  check(one >= 0 && two >= 0 && Math.abs(one - two) === 1, `the selection lands together (${doneTitles.join(', ')})`)
  await sleep(120)
  // A selected card archived from its menu leaves the selection: the bar counts the one left.
  const archiveSelBar = page.locator('.selection-bar span')
  check((await archiveSelBar.textContent()) === '2 selected', 'the dropped pair is still selected')
  await page.locator('.column[data-list="done"] .card', { hasText: 'Group one' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Archive', exact: true }).click()
  check(
    await until(async () => (await archiveSelBar.textContent().catch(() => '')) === '1 selected'),
    `archiving a selected card takes it out of the selection (${await archiveSelBar.textContent().catch(() => 'no bar')})`,
  )
  await page.locator('.column[data-list="done"] .card', { hasText: 'Group two' }).click({ modifiers: ['Control'] })
  check((await page.locator('.selection-bar').count()) === 0, 'and the last one toggles off with Ctrl-click')

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
  const faceBefore = await renamed.evaluate(el => {
    const r = el.querySelector('.card-title').getBoundingClientRect()
    return { title: [r.x, r.y], meta: el.querySelector('.card-meta').getBoundingClientRect().y }
  })
  await renamed.locator('.card-title').dblclick()
  const faceEditing = await renamed.evaluate(el => {
    const r = el.querySelector('.rename-card').getBoundingClientRect()
    return { title: [r.x, r.y], meta: el.querySelector('.card-meta').getBoundingClientRect().y }
  })
  check(
    faceEditing.title[0] === faceBefore.title[0] && faceEditing.title[1] === faceBefore.title[1] && faceEditing.meta === faceBefore.meta,
    `opening a card's title for editing moves nothing (${JSON.stringify(faceBefore)} → ${JSON.stringify(faceEditing)})`,
  )
  const fills = await page.evaluate(() => {
    const bg = sel => getComputedStyle(document.querySelector(sel)).backgroundColor
    return { editing: bg('.card[data-card="SB-1"]'), rest: bg('.card:not([data-card="SB-1"])') }
  })
  check(fills.editing !== fills.rest, `a card being renamed has a fill of its own (${fills.editing} vs ${fills.rest})`)
  check(fills.editing === adderFill, `the add-a-card field has the same fill (${adderFill})`)
  await page.keyboard.type(' and a title long enough to wrap over several lines of the card, to be edited whole')
  const field = await renamed.locator('.rename-card').evaluate(el => {
    const s = getComputedStyle(el)
    return { lines: el.clientHeight / parseFloat(s.lineHeight), scrolls: el.scrollHeight > el.clientHeight, resize: s.resize }
  })
  check(field.lines > 2.5 && !field.scrolls && field.resize === 'none', `a long title grows the field whole, with no scrollbar or grip (${JSON.stringify(field)})`)
  await page.keyboard.press('Control+a')
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

  // ---- a list sorted by last update keeps itself sorted; a change on disk re-sorts it ----
  for (const title of ['Sorted older', 'Sorted newer']) {
    await todo.getByText('+ Add a card').click()
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await todo.locator('.card', { hasText: title }).waitFor()
    await sleep(20)
  }
  const firstInTodo = async () => (await todo.locator('.card .card-title').first().textContent())?.trim()
  check((await firstInTodo()) === 'Sorted older', `a new board's To do keeps its cards in their positions (${await firstInTodo()})`)
  const sortTodo = async name => {
    await todo.locator('.column-head').click({ button: 'right' })
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /Sort cards by/ }).hover()
    await page.locator('.ctx-menu').getByRole('menuitem', { name }).click()
  }
  const todoSort = () => JSON.parse(readFileSync(path.join(root, 'scratch-board/board.json'), 'utf8')).lists.find(l => l.id === 'todo')?.sort
  await sortTodo(/Last updated/)
  check(await until(() => todoSort() === 'updated'), 'Sort cards by › Last updated is kept in board.json')
  check(await until(async () => (await firstInTodo()) === 'Sorted newer'), 'a list sorted by last update shows its last updated card first')
  await sortTodo(/Manual/)
  check(await until(() => todoSort() === 'manual'), 'Sort cards by › Manual is kept in board.json')
  check(await until(async () => (await firstInTodo()) === 'Sorted older'), 'a manual list shows its cards in their positions')
  await sortTodo(/Last updated/)
  check(await until(async () => (await firstInTodo()) === 'Sorted newer'), 'and back to last updated first')
  const olderId = /^id: (\S+)$/m.exec(cardTexts(path.join(root, 'scratch-board/cards')).find(t => t.includes('title: Sorted older')))[1]
  const olderFile = path.join(root, 'scratch-board/cards', `${olderId}.md`)
  const later = new Date(Date.now() + 60000).toISOString()
  writeFileSync(olderFile, readFileSync(olderFile, 'utf8').replace(/^created: .*$/m, line => `${line}\nupdated: ${later}`))
  check(await until(async () => (await firstInTodo()) === 'Sorted older'), 'a card updated on disk rises to the top of its list')

  // ---- the board repo commits itself ----
  const log = await until(() => {
    const out = execFileSync('git', ['log', '--format=%B', '-5'], { cwd: root }).toString()
    return out.includes('SB-1') ? out : ''
  }, 8000)
  check(!!log, `board repo auto-committed:\n${log}`)

  // ---- the code repo panel: the branch, a push that sets the upstream, a commit, a pull ----
  await page.locator(`.tab[title$=":${MAIN.path}"]`).click()
  const repoPanel = page.locator('.repo-panel')
  check(await until(async () => (await repoPanel.locator('.repo-branch').textContent().catch(() => '')) === 'main'), 'the code repo panel shows the branch')
  check((await repoPanel.locator('.repo-note').textContent().catch(() => '')) === 'no upstream', 'and that it has no upstream yet')
  const panelBox = await repoPanel.boundingBox()
  const paneBox = await page.locator('.board-pane').boundingBox()
  const termBox = await page.locator('.terminal-panel').boundingBox()
  check(
    panelBox.y + panelBox.height < termBox.y && Math.abs(paneBox.x + paneBox.width - (panelBox.x + panelBox.width)) < 30,
    'it sits at the board\'s bottom right, above the terminal panel',
  )
  await repoPanel.getByRole('button', { name: 'Push' }).click()
  const pushDialog = page.getByRole('dialog')
  check((await pushDialog.locator('h2').textContent()) === 'Push main to origin?', 'Push asks first, naming the branch and the remote')
  await pushDialog.getByRole('button', { name: 'Push' }).click()
  const ahead = () => repoPanel.locator('.repo-ahead').textContent().catch(() => '')
  check(await until(async () => (await ahead()) === '↑0'), 'the push set the upstream: nothing ahead')
  const remoteHead = () => execFileSync('git', ['rev-parse', 'main'], { cwd: codeRemote }).toString().trim()
  const localHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeRepo }).toString().trim()
  check(remoteHead() === localHead(), 'the branch reached the code repo\'s remote')
  execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', 'Tune the drill'], { cwd: codeRepo })
  check(await until(async () => (await ahead()) === '↑1'), 'a commit made outside the app shows as one ahead')
  writeFileSync(path.join(codeRepo, 'notes.txt'), 'not committed\n')
  // A new file touches nothing git watches: coming back to the window reads it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'))
  check(await until(async () => (await repoPanel.locator('.repo-changed').textContent().catch(() => '')) === '1 changed'), 'an uncommitted file shows as changed, on focus')
  await repoPanel.getByRole('button', { name: 'Push' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Push' }).click()
  check(await until(async () => (await ahead()) === '↑0'), 'Push (confirmed) brings it back to 0')
  check(remoteHead() === localHead(), 'and the commit is on the remote')
  const codeOther = path.join(scratch, 'code-other')
  execFileSync('git', ['clone', '-q', codeRemote, codeOther])
  execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', 'From the other machine'], { cwd: codeOther })
  execFileSync('git', ['push', '-q'], { cwd: codeOther })
  await repoPanel.getByRole('button', { name: 'Pull' }).click()
  check(!!(await until(async () => (await page.locator('.toast').textContent().catch(() => '')) === 'Pulled 1 commit')), 'Pull brought in the other clone\'s commit')
  check(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: codeRepo }).toString().trim() === 'From the other machine', 'fast-forwarding the branch')
  check((await readFileSync(path.join(codeRepo, 'notes.txt'), 'utf8')) === 'not committed\n', 'and leaving the uncommitted file alone')
  await page.locator('.tree-row', { hasText: SPARE.title }).first().click()
  check(await until(async () => (await repoPanel.count()) === 0), 'a board with no code repo shows no panel')
  await page.locator(`.tab[title$=":${SPARE.path}"] .tab-close`).click()

  // ---- card detail, commits and tackling ----
  await page.locator(`.tab[title$=":${MAIN.path}"]`).click()
  await page.locator('.column[data-list="tofix"] .card').first().click()
  await page.locator('.drawer').waitFor()
  const openId = (await page.locator('.drawer .card-id').textContent()).trim()
  check(openId.startsWith(`${MAIN.key}-`), `drawer opened for ${openId}`)
  await shot('04-drawer')
  // Its id copies itself on a click.
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await page.locator('.drawer').getByRole('button', { name: openId, exact: true }).click()
  check((await app.evaluate(({ clipboard }) => clipboard.readText())) === openId, `clicking the drawer's id put ${openId} on the clipboard`)
  check(!!(await until(async () => (await page.locator('.toast').textContent().catch(() => '')) === `Copied ${openId}`, 5000)), 'and says so')

  // A table in the description wraps its headers and stays inside the box: the Table view's rules
  // (nowrap, sticky, a pointer on every row) are scoped to that view.
  const mdTable = await page.locator('.drawer .markdown table').evaluate(table => {
    const box = table.closest('.markdown').getBoundingClientRect()
    const th = getComputedStyle(table.querySelector('th'))
    return { inside: table.getBoundingClientRect().right <= box.right + 0.5, wrap: th.whiteSpace, position: th.position, cursor: getComputedStyle(table.querySelector('tbody tr')).cursor }
  })
  check(mdTable.inside && mdTable.wrap !== 'nowrap' && mdTable.position === 'static' && mdTable.cursor !== 'pointer', `a description's table wraps and stays in its box (${JSON.stringify(mdTable)})`)

  // A description's links open in the browser and leave the window where it was (CORK-68).
  const descLinkCardFile = path.join(root, MAIN.path, 'cards', `${openId}.md`)
  const descLinkBody = readFileSync(descLinkCardFile, 'utf8')
  writeFileSync(descLinkCardFile, `${descLinkBody.replace(/\s+$/, '')}\n\nSee [the docs](https://example.com/desc-link) and [the plan](notes/plan.md).\n`)
  const descLinkWeb = page.locator('.drawer .markdown a', { hasText: 'the docs' })
  await descLinkWeb.waitFor()
  const descLinkPage = page.url()
  await descLinkWeb.click()
  check(!!(await until(() => openedUrls().includes('https://example.com/desc-link'))), "a click on a description's web link opens it in the browser")
  await page.locator('.drawer .markdown a', { hasText: 'the plan' }).click()
  await page.waitForTimeout(300)
  check(page.url() === descLinkPage && openedUrls().every(u => !u.includes('plan.md')), `and the window stays on the app (${page.url()}); a relative link does nothing`)
  // Any navigation away from the app is turned back by the main process, a web page sent to the
  // browser. Emitted as the window gets it: a real one turned back leaves Playwright waiting on it.
  const descNav = url =>
    app.evaluate(({ BrowserWindow }, url) => {
      let prevented = false
      BrowserWindow.getAllWindows()[0].webContents.emit('will-navigate', { preventDefault: () => (prevented = true) }, url)
      return prevented
    }, url)
  check((await descNav('https://example.com/desc-nav')) && !!(await until(() => openedUrls().includes('https://example.com/desc-nav'))), 'a navigation of the window to a web page is turned back and goes to the browser')
  check((await descNav('file:///etc/hostname')) && !openedUrls().includes('file:///etc/hostname'), 'one to a file is turned back and opens nothing')
  check(!(await descNav(descLinkPage)), "the app's own page may load again (a reload)")
  check(page.url() === descLinkPage && (await page.locator('.drawer').count()) === 1, 'and the window keeps the app')
  writeFileSync(descLinkCardFile, descLinkBody)
  await until(async () => (await page.locator('.drawer .markdown a', { hasText: 'the docs' }).count()) === 0)

  // The drawer's due date sets and clears `due:`; the face's ⏰ turns red once it is past (CORK-83).
  const dueInput = page.locator('.drawer .due-input')
  const dueBadge = page.locator(`.card[data-card="${openId}"] .badge`, { hasText: '⏰' })
  const dueUpdated = () => /^updated: (.*)$/m.exec(readFileSync(descLinkCardFile, 'utf8'))?.[1]
  const dueUpdatedBefore = dueUpdated()
  await dueInput.fill('2026-11-02')
  check(await until(() => /^due: 2026-11-02$/m.test(readFileSync(descLinkCardFile, 'utf8'))), 'a date in the drawer writes due: 2026-11-02 into the card file')
  check(dueUpdated() !== dueUpdatedBefore, 'and stamps updated')
  check(await until(async () => (await dueBadge.textContent().catch(() => '')) === '⏰ 2026-11-02'), 'the card shows it on its face')
  await dueInput.fill('2020-01-01')
  check(await until(async () => (await dueBadge.getAttribute('class').catch(() => '')) === 'badge overdue'), 'a past date shows in the danger colour')
  const dueRed = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--red').trim())
  check(!!(await until(async () => (await dueBadge.evaluate(el => getComputedStyle(el).color)) === (await page.evaluate(c => {
    const probe = document.createElement('span')
    probe.style.color = c
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, dueRed)))), `the theme's --red (${dueRed})`)
  await page.locator('.drawer').getByRole('button', { name: 'Clear the due date' }).click()
  check(await until(() => !/^due:/m.test(readFileSync(descLinkCardFile, 'utf8'))), 'clearing it takes due: out of the card file')
  check(await until(async () => (await dueBadge.count()) === 0 && (await dueInput.inputValue()) === ''), 'and the ⏰ off the face')

  // A selection started with a card open starts from that card; the bar's actions need two.
  const other = page.locator(`.kanban .card[data-card]:visible:not([data-card="${openId}"])`).first()
  const otherId = await other.getAttribute('data-card')
  await other.click({ modifiers: ['Control'] })
  const bar = page.locator('.selection-bar')
  check(
    (await bar.locator('span').textContent()) === '2 selected' && (await page.locator(`.card.selected[data-card="${openId}"]`).count()) === 1,
    `Ctrl+click on ${otherId} with ${openId} open selects both`,
  )
  check((await bar.getByRole('button', { name: 'Tackle ▾' }).count()) === 1, 'two selected cards offer Tackle')
  await other.click({ modifiers: ['Control'] })
  check(
    (await bar.locator('span').textContent()) === '1 selected' && (await bar.getByRole('button', { name: /Tackle|Discuss/ }).count()) === 0,
    'one selected card offers no Tackle or Discuss in the bar',
  )
  await bar.getByRole('button', { name: 'Clear' }).click()
  check((await bar.count()) === 0, 'Clear empties the selection')

  // Shift-click selects a range in the board's order as shown (lists left to right, collapsed
  // ones and dividers left out), here from the card open in the drawer, into the next list.
  const rangeCards = await page
    .locator('.kanban .card[data-card]')
    .evaluateAll(els => els.map(e => ({ id: e.dataset.card, list: e.closest('.column').dataset.list })))
  const rangeFrom = rangeCards.findIndex(c => c.id === openId)
  const rangeTo = rangeCards.findIndex((c, i) => i > rangeFrom && c.list !== rangeCards[rangeFrom].list) + 1
  const rangeWant = rangeCards.slice(rangeFrom, rangeTo + 1).map(c => c.id)
  await page.locator(`.kanban .card[data-card="${rangeCards[rangeTo].id}"]`).click({ modifiers: ['Shift'] })
  const rangeGot = await page.locator('.kanban .card.selected').evaluateAll(els => els.map(e => e.dataset.card))
  check(
    rangeWant.length > 2 && rangeGot.length === rangeWant.length && rangeWant.every(id => rangeGot.includes(id)),
    `Shift-click from the open ${openId} selects the cards up to ${rangeCards[rangeTo].id} as shown (${rangeGot.join(',')})`,
  )
  check(await page.evaluate(() => getSelection().toString() === ''), 'and selects no text across them')
  await page.locator(`.kanban .card[data-card="${rangeWant[1]}"]`).click({ modifiers: ['Control'] })
  check(
    (await bar.locator('span').textContent()) === `${rangeWant.length - 1} selected` && (await page.locator(`.card.selected[data-card="${rangeWant[1]}"]`).count()) === 0,
    'Ctrl-click still toggles one card',
  )
  await bar.getByRole('button', { name: 'Clear' }).click()

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

  // ---- images: pastedImage or droppedImage into the description, saved beside the card ----
  // A paste and a drop as the page gets them, with a PNG the page draws: small (kept as it is) or
  // a big one of noise, which no compression shrinks under 1 MB (scaled down to WebP).
  const imageEvent = (selector, kind, big) =>
    page.locator(selector).evaluate(
      async (el, { kind, big }) => {
        const side = big ? 1600 : 24
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = side
        const ctx = canvas.getContext('2d')
        if (big) {
          const data = ctx.createImageData(side, side)
          for (let i = 0; i < data.data.length; i++) data.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256)
          ctx.putImageData(data, 0, 0)
        } else {
          ctx.fillStyle = '#d9645b'
          ctx.fillRect(0, 0, side, side)
        }
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
        const init = { bubbles: true, cancelable: true }
        el.dispatchEvent(kind === 'paste' ? new ClipboardEvent('paste', { ...init, clipboardData: dt }) : new DragEvent('drop', { ...init, dataTransfer: dt }))
        return blob.size
      },
      { kind, big },
    )
  const imageCardFile = path.join(root, MAIN.path, 'cards', `${openId}.md`)
  const imagesDir = path.join(root, MAIN.path, 'cards', openId)
  const imageLinks = () => [...readFileSync(imageCardFile, 'utf8').matchAll(/!\[\]\(([^)]+)\)/g)].map(m => m[1])
  await page.locator('.drawer .section-head').getByRole('button', { name: 'Edit', exact: true }).click()
  const bodyInput = page.locator('.drawer .body-input')
  await bodyInput.evaluate(el => {
    el.focus()
    el.setSelectionRange(0, 0)
  })
  await imageEvent('.drawer .body-input', 'paste', false)
  const pastedImage = await until(() => imageLinks()[0])
  check(new RegExp(`^${openId}/[0-9a-f]{16}\\.png$`).test(pastedImage ?? ''), `a pasted image is written into the description at the cursor: ${pastedImage}`)
  check(!!pastedImage && (await bodyInput.inputValue()).startsWith(`![](${pastedImage})\n`), 'at the top, where the cursor was, on a line of its own')
  check(!!pastedImage && existsSync(path.join(root, MAIN.path, 'cards', pastedImage)), `and saved beside the card, in cards/${openId}/`)
  await page.locator('.drawer .section-head').getByRole('button', { name: 'Preview', exact: true }).click()
  const bigSize = await imageEvent('.drawer .markdown', 'drop', true)
  const droppedImage = await until(() => imageLinks()[1], 20000)
  check(bigSize > 1024 * 1024 && /\.webp$/.test(droppedImage ?? ''), `a ${(bigSize / 1048576).toFixed(1)} MB image dropped on the description goes at its end, scaled down to WebP: ${droppedImage}`)
  check(!!droppedImage && statSync(path.join(root, MAIN.path, 'cards', droppedImage)).size <= 1024 * 1024, 'under 1 MB')
  check(!!(await until(async () => (await page.locator('.toast').textContent().catch(() => '')).includes('Scaled the image down'))), 'and the app says it scaled it')
  const shown = () => page.locator('.drawer .markdown img').evaluateAll(imgs => imgs.map(i => ({ src: i.src, w: i.naturalWidth })))
  const loaded = await until(async () => {
    const imgs = await shown()
    return imgs.length === 2 && imgs.every(i => i.w > 0) ? imgs : null
  })
  check(!!loaded && loaded.every(i => i.src.startsWith('card-image://')), `the description shows both through the app's protocol (${JSON.stringify(loaded ?? (await shown()))})`)
  // One the description names that this machine lacks (not pulled yet) is a placeholder.
  writeFileSync(imageCardFile, readFileSync(imageCardFile, 'utf8').replace(`![](${pastedImage})`, `![](${pastedImage}) ![](${openId}/not-pulled-yet.png)`))
  check(!!(await until(async () => (await page.locator('.drawer .image-missing').count()) === 1)), 'an image not on this machine yet shows a placeholder with its path')
  // The protocol serves nothing outside a board repo, nor a file of the repo that is no image.
  writeFileSync(path.join(scratch, 'outside.png'), readFileSync(path.join(root, MAIN.path, 'cards', pastedImage)))
  const projectOfTab = (await page.locator(`.tab[title$=":${MAIN.path}"]`).first().getAttribute('title')).split(':')[0]
  const refused = await page.evaluate(
    urls => Promise.all(urls.map(src => new Promise(r => Object.assign(new Image(), { onload: () => r(`loaded ${src}`), onerror: () => r(null), src })))),
    [`card-image://${projectOfTab}/..%2Foutside.png`, `card-image://${projectOfTab}/%2E%2E/outside.png`, `card-image://${projectOfTab}/${MAIN.path}/board.json`, `file://${path.join(scratch, 'outside.png')}`],
  )
  check(refused.every(r => r === null), `paths out of the repo, a file that is no image and file: load nothing (${refused.filter(Boolean).join(', ') || 'none loaded'})`)
  check(!!(await until(() => execFileSync('git', ['log', '--format=%B', '-8'], { cwd: root }).toString().includes(`Add an image to ${openId}`), 8000)), 'the board repo commits the images')
  check(readdirSync(imagesDir).every(n => !n.endsWith('.tmp')), 'and leaves no temporary file beside them')

  // ---- a cover: one of the description's images, picked in the drawer, on the card's face ----
  const coverChoices = page.locator('.drawer .covers .cover-choice')
  check((await coverChoices.count()) === 4, `the drawer offers the description's images as covers, and None (${await coverChoices.count()})`)
  await page.locator('.drawer').getByRole('button', { name: `Cover ${droppedImage}` }).click()
  check(!!(await until(() => readFileSync(imageCardFile, 'utf8').includes(`\ncover: ${droppedImage}\n`))), `picking one writes cover: ${droppedImage} into the card file`)
  const faceCover = page.locator(`.card[data-card="${openId}"] .card-cover`)
  const coverBox = await until(async () => {
    const box = await faceCover.evaluate(img => ({ w: img.naturalWidth, h: img.getBoundingClientRect().height, card: img.closest('.card').getBoundingClientRect().width, width: img.getBoundingClientRect().width })).catch(() => null)
    return box && box.w > 0 ? box : null
  })
  check(!!coverBox && coverBox.h <= 140 && Math.abs(coverBox.width - coverBox.card) <= 2, `the card's face shows it across its top, at most 140 px tall (${JSON.stringify(coverBox)})`)
  await shot('04b-card-cover')
  await page.locator('.drawer .covers').getByRole('button', { name: 'None' }).click()
  check(!!(await until(() => !readFileSync(imageCardFile, 'utf8').includes('cover:'))) && (await until(async () => (await faceCover.count()) === 0)), 'None takes the cover off the card and its face')

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
  const firstKind = page.locator('.terminal-tab').first().locator('.term-kind')
  check((await firstKind.getAttribute('class'))?.includes('local') && (await firstKind.textContent()) === '▣', 'a terminal tackle\'s tab shows the terminal glyph')
  check(!(await page.locator('.terminal-tab').first().locator('.term-title').textContent())?.startsWith('☁'), 'its title is the session name alone')
  check(termText.includes('prompt=given'), 'claude received the prompt (no option swallowed it)')
  const calls = sessionCalls()
  const args = calls[0].split('\0')
  check(args.includes('--session-id') && args.includes('--add-dir') && args.includes('-n'), `claude args: ${args.slice(0, 7).join(' ')}`)
  check(args.at(-2)?.includes(`Tackle card ${tackleId}`) ?? false, `the prompt names ${tackleId}`)
  const tackled = readFileSync(path.join(root, MAIN.path, 'cards', `${tackleId}.md`), 'utf8')
  check(tackled.includes('sessions:') && tackled.includes('kind: local'), 'the session is recorded on the card')

  // ---- the MCP server: the session got its config, and its tools change the card ----
  const mcpArg = args.indexOf('--mcp-config')
  const mcpFile = mcpArg > 0 ? args[mcpArg + 1] : ''
  check(!!mcpFile && existsSync(mcpFile), `the session got the MCP server's config (${mcpFile})`)
  const server = mcpFile ? JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers?.corkboard : undefined
  const mcpUrl = server?.url
  const mcpToken = server?.headers?.Authorization?.replace(/^Bearer /, '')
  check(mcpUrl === `http://127.0.0.1:${mcpPort}/mcp` && server?.type === 'http', `on CORKBOARD_MCP_PORT, over HTTP (${mcpUrl})`)
  check(mcpToken === readFileSync(path.join(scratch, 'profile', 'mcp-token'), 'utf8').trim(), 'with the token the app keeps in its user data')
  check(!args.some(a => a.includes(mcpToken)), 'and the token is in no argument')
  check(args.at(-2)?.includes('corkboard tools') ?? false, 'the prompt says to change the card with the tools')
  check((await mcpCall(mcpUrl, undefined, 'tools/list')).status === 401, 'the server turns away a request without the token')
  check((await mcpCall(mcpUrl, 'wrong', 'tools/list')).status === 401, 'and one with the wrong token')
  const listed = await mcpTool(mcpUrl, mcpToken, 'list_boards', {})
  const mcpBoard = listed.flatMap(p => p.boards).find(b => b.cardPrefix === MAIN.key)
  check(!!mcpBoard && mcpBoard.flow?.done === 'done', `list_boards names ${MAIN.title} with its flow (${mcpBoard?.board})`)
  const mcpBefore = Date.now()
  const doneByTool = await mcpTool(mcpUrl, mcpToken, 'move_card', { id: tackleId, flow: 'done' })
  check(doneByTool.list === 'done' && Date.parse(doneByTool.updated) >= mcpBefore - 1000, `move_card moved ${tackleId} to done, stamped by the app (${doneByTool.updated})`)
  check(await until(() => /^list: done$/m.test(readFileSync(path.join(root, MAIN.path, 'cards', `${tackleId}.md`), 'utf8'))), 'the card file has it')
  check(!!(await until(async () => (await page.locator(`.column[data-list="done"] .card[data-card="${tackleId}"]`).count()) === 1)), 'and the board on screen shows it')
  const noList = await mcpTool(mcpUrl, mcpToken, 'move_card', { id: tackleId, list: 'no-such-list' })
  check(noList.error?.includes('has no list no-such-list') ?? false, `a list that is not there is refused (${noList.error})`)

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
  check(linkParams.get('q')?.includes(`if your working directory is not ${codeRepo}, move the session there first`) ?? false, 'the prompt asks the session to check its folder and move there')
  check(await until(() => readFileSync(cardFileOf(tackleId), 'utf8').includes('kind: desktop')), 'the desktop session is recorded')
  check(await until(async () => (await page.locator('.drawer .sessions li', { hasText: 'waiting' }).count()) === 1), 'waiting until its prompt is sent')
  // The desktop app indexes the session and writes its transcript once the prompt is sent. The link
  // can't pick a branch, and a draft sent with its branch blank starts in a scratch workspace.
  const desktopIndex = path.join(scratch, 'desktop-sessions', 'account', 'org')
  const desktopScratch = path.join(scratch, 'desktop-scratch', 'scratch-e2e')
  mkdirSync(desktopIndex, { recursive: true })
  writeFileSync(
    path.join(desktopIndex, 'local_e2e-1.json'),
    JSON.stringify({ sessionId: 'local_e2e-1', cliSessionId: 'cli-e2e-1', cwd: desktopScratch, createdAt: Date.now() }),
  )
  const transcriptDir = path.join(scratch, 'claude-projects', desktopScratch.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(
    path.join(transcriptDir, 'cli-e2e-1.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: linkParams.get('q') }] } }) + '\n',
  )
  check(await until(() => readFileSync(cardFileOf(tackleId), 'utf8').includes('desktopId: local_e2e-1')), 'the card links the session the desktop app opened, outside the code repo too')
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

  // The board in front is the main one: its menu is the project's *Main board*.
  const boardTitle = MAIN.title
  const callsBeforeBoardTalk = sessionCalls().length
  await page.locator('.project-row').first().click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Main board/ }).hover()
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Discuss \/ triage/ }).hover()
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'In a terminal' }).click()
  const boardTalk = await until(() => sessionCalls().slice(callsBeforeBoardTalk)[0], 15000)
  const boardPrompt = boardTalk?.split('\0').at(-2) ?? ''
  check(boardPrompt.startsWith(`Let's triage the whole "${boardTitle}" board`), `Discuss / triage on a board opens one session for all of ${boardTitle}`)
  check(boardPrompt.includes(`${talkId}: `) && boardPrompt.includes('   List: '), 'its prompt lists every card with its list')
  await shot('05-terminal')
  const openPanel = await page.locator('.terminal-panel').boundingBox()
  const fullList = await page.locator('.column.full').first().boundingBox().catch(() => null)
  check(
    openPanel.height > 100 && !!fullList && Math.abs(fullList.y + fullList.height - openPanel.y) <= 1,
    'with the terminal panel open, a long list still meets its top edge',
  )

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
  const worktreeGlyphs = await page.locator('.terminal-tab').evaluateAll((tabs, from) => tabs.slice(from).map(t => t.querySelector('.term-kind.local-worktree')?.textContent), before)
  check(worktreeGlyphs.length === primeCount && worktreeGlyphs.every(g => g === '⌥'), `a worktree tackle's tab shows the worktree glyph: ${worktreeGlyphs.join(' ')}`)
  const worktreeTip = await page.locator('.terminal-tab').nth(before).getAttribute('title')
  check(!!worktreeTip?.includes('Worktree session') && worktreeTip.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`), 'its tooltip names the kind and the worktree\'s folder')

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
  // Pinned by its id, so a card the cloud sessions still being recorded from the step above move
  // or touch between two clicks can't take its place.
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
  // The app may push a commit of its own (the last drags, committed after their delay) between the
  // pull above and this push, as another machine would; the push then rebases and goes again.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('git', ['push', '-q'], { cwd: otherMachine, stdio: 'pipe' })
      break
    } catch (error) {
      if (attempt === 4) throw error
      execFileSync('git', ['pull', '-q', '--rebase'], { cwd: otherMachine })
    }
  }
  await syncNow()
  const pulled = await until(async () => (await page.locator(`.card[data-card="${TO_FIX}"]`, { hasText: 'Renamed on the other machine' }).count()) === 1, 15000)
  check(pulled, "the other machine's rename showed up after a sync")
  await shot('11-synced')

  // ---- the notification program: set in the app's settings, tried from there ----
  await page.locator('.sidebar-foot').getByRole('button', { name: 'Corkboard settings…' }).click()
  const settings = page.getByRole('dialog')
  check((await settings.getByRole('heading', { level: 2 }).textContent()) === 'Corkboard settings', "the side panel's foot opens the app's settings, named so")
  check(await settings.getByRole('checkbox', { name: 'Desktop notifications' }).isChecked(), 'desktop notifications are on to begin with')
  await settings.getByRole('button', { name: 'Browse…' }).click()
  check(!!(await until(async () => (await settings.locator('input:not([type=checkbox])').inputValue()) === fakeNotify)), 'Browse… fills in the notification program')
  await settings.getByRole('button', { name: 'Try it' }).click()
  check(!!(await until(async () => (await settings.locator('.notify-try.success').count()) === 1, 10000)), 'Try it runs it and says so')
  check(notifications().some(l => l.startsWith('test shell')), 'and the program got the test event')
  await shot('11-settings-notify')
  await settings.getByRole('button', { name: 'Save' }).click()
  await until(async () => (await page.getByRole('dialog').count()) === 0)
  const savedNotify = JSON.parse(readFileSync(path.join(scratch, 'profile', 'config.json'), 'utf8')).notify
  check(savedNotify?.command === fakeNotify && savedNotify.desktop === undefined, 'Save keeps it in the app config, desktop notifications left on')

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

  // Copy and paste: Ctrl+C copies a selection instead of interrupting; the right-click menu pastes.
  const shellRows = page.locator('.xterm-host:visible .xterm-rows')
  const shellScreen = page.locator('.xterm-host:visible .xterm-screen') // over the rows: takes the clicks
  const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText())
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await shellScreen.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Select all' }).click()
  await page.keyboard.press('Control+C')
  check(!!(await until(async () => (await clipboardText()).includes('corkboard-42'), 5000)), 'Ctrl+C copies the selection from a terminal')
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-$((2*3))'))
  await shellScreen.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Paste' }).click()
  await page.keyboard.press('Enter')
  const pasted = await until(async () => ((await shellRows.textContent()) ?? '').includes('pasted-6'), 10000)
  check(!!pasted, "the terminal menu's Paste types the clipboard into the shell")

  // Links: a URL printed as text, and an OSC 8 one (as Claude Code writes), each on its own row at
  // the top. A plain click leaves them be; Ctrl+click opens them in the browser.
  await page.keyboard.type("clear; printf 'https://example.com/plain\\n\\e]8;;https://example.com/osc8\\e\\\\docs\\e]8;;\\e\\\\\\n'\n")
  const linkRow = text => shellRows.locator('> div').filter({ hasText: new RegExp(`^${text}`) }).first()
  check(!!(await until(async () => (await linkRow('docs').count()) > 0, 5000)), 'the shell printed the links')
  const clickRow = async (text, ctrl) => {
    const box = await linkRow(text).boundingBox()
    await page.mouse.move(box.x + 12, box.y + box.height / 2)
    await sleep(200) // xterm finds the link on hover
    if (ctrl) await page.keyboard.down('Control')
    await page.mouse.down()
    await page.mouse.up()
    if (ctrl) await page.keyboard.up('Control')
  }
  await clickRow('https://example.com/plain', false)
  await sleep(500)
  check(!openedUrls().includes('https://example.com/plain'), 'a plain click on a URL in a terminal opens nothing')
  await clickRow('https://example.com/plain', true)
  check(!!(await until(() => openedUrls().includes('https://example.com/plain'))), 'Ctrl+click opens a URL from a terminal')
  await clickRow('docs', true)
  check(!!(await until(() => openedUrls().includes('https://example.com/osc8'))), 'Ctrl+click opens an OSC 8 link from a terminal')

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
  // The program heard each change, in order (the fake turn starts at Claude's prompt, works, stops,
  // then leaves), with the status before it and the tab's title.
  const heard = await until(async () => {
    const turn = notifications().filter(l => !l.startsWith('test ')).map(l => l.split(' ').slice(0, 2).join(' '))
    return turn.join(',').includes('waiting shell,working waiting,waiting working,shell waiting') ? turn : null
  }, 10000)
  check(!!heard, `the notification program ran on each state change: ${notifications().join(' | ')}`)
  check(notifications().some(l => l === 'waiting working shell'), "with the tab's title (`shell`) as its third argument")
  // The window of the test is never in front, so the turn's end came as a desktop notification too.
  check(notices().join('|') === 'Claude is waiting for you\tshell', `the end of the turn showed a desktop notification: ${notices().join(' | ')}`)

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
  // Count the crossfades: a theme change goes through a view transition, a pick in the editor doesn't.
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document)
    window.fades = 0
    document.startViewTransition = update => (window.fades++, start(update))
  })
  const fades = () => page.evaluate(() => window.fades)
  const openProjectSettings = async () => {
    await page.locator('.project-row').first().click({ button: 'right' })
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /Project settings…/ }).click()
  }
  await openProjectSettings()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Cork' }).click()
  check((await rootToken('--bg')) === '#1f1610', 'picking Cork repaints the window before saving')
  await dialog.getByRole('button', { name: 'Tide' }).click()
  check((await fades()) === 0, 'picks in the theme editor swap the colours without a fade')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  check(!!(await until(async () => (await rootToken('--bg')) === '')), 'Cancel puts the colours back')
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
  const heading = () => dialog.getByRole('heading', { level: 2 }).textContent()
  check((await page.locator('.board-head').getByRole('button', { name: 'Terminal' }).count()) === 0, "the board header has no Terminal button: the panel's New shell does it")
  await page.locator('.board-head').getByRole('button', { name: 'Board settings', exact: true }).click()
  const boardHeading = await heading()
  check(boardHeading.includes('Board settings') && boardHeading.includes(`${MAIN.title}, in project`), `the board settings say whose they are (${boardHeading})`)
  check((await dialog.locator('.theme-pointer').textContent()).includes('Cork'), 'board settings name the project colours')
  const repoGroup = dialog.locator('.field-group', { has: page.getByRole('heading', { name: 'Code repo' }) })
  check((await repoGroup.getByRole('textbox').count()) === 2, 'the code repo fields sit together under one heading')
  check(/Uses .+: /.test(await repoGroup.locator('.code-repo-used').textContent()), 'and say which path is in use and why')
  check((await repoGroup.locator('.scope-tag').count()) === 1, "this machine's path is marked as this machine's only")
  await shot('18b-board-settings')
  await dialog.getByRole('button', { name: 'Project settings…' }).click()
  check((await heading()).includes('Project settings'), 'and open them in the project settings')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('.board-head').getByRole('button', { name: 'Project settings', exact: true }).click()
  check((await heading()).startsWith('Project settings'), "the header's Project settings opens the project's dialog")
  check((await page.locator('.board-head .head-settings .theme-swatch').count()) === 1, 'and carries the project swatch')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // ---- a project icon: picked in the settings, scaled down, shown in place of the swatch ----
  const iconPng = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 200
      canvas.height = 100
      const context = canvas.getContext('2d')
      context.fillStyle = '#e0a96d'
      context.fillRect(0, 0, 200, 100)
      return canvas.toDataURL('image/png').split(',')[1]
    }),
    'base64',
  )
  await openProjectSettings()
  await dialog.locator('input[type=file]').setInputFiles({ name: 'moon.png', mimeType: 'image/png', buffer: iconPng })
  check(!!(await until(async () => (await dialog.locator('.icon-preview .project-icon').count()) === 1)), 'a picked image shows in the project settings')
  await dialog.getByRole('button', { name: 'Save' }).click()
  const projectFile = path.join(root, 'project.json')
  const savedIcon = await until(() => existsSync(projectFile) && JSON.parse(readFileSync(projectFile, 'utf8')).icon)
  check(typeof savedIcon === 'string' && savedIcon.startsWith('data:image/png;base64,'), 'Save writes the icon to project.json as a data URI')
  const iconSize = await page.evaluate(
    src => new Promise(resolve => {
      const image = new Image()
      image.onload = () => resolve([image.naturalWidth, image.naturalHeight])
      image.onerror = () => resolve([0, 0])
      image.src = src
    }),
    savedIcon || '',
  )
  check(iconSize[0] === 64 && iconSize[1] === 32, `scaled down to 64 px, its proportions kept (${iconSize.join('×')})`)
  check(
    !!(await until(async () => (await page.locator('.project-row .project-icon').count()) === 1)) &&
      (await page.locator('.project-row .theme-swatch').count()) === 0,
    'the side panel shows the icon in place of the swatch',
  )
  check((await page.locator('.board-head .head-settings .project-icon').count()) === 1, "and so does the header's Project settings button")
  check(!!(await until(() => boardLogHas("Set the project's icon"), 12000)), 'the board repo commits the icon')
  await openProjectSettings()
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  check(!!(await until(() => !existsSync(projectFile))), 'clearing the icon takes it out of project.json (and the file, with nothing else in it)')
  check(!!(await until(async () => (await page.locator('.project-row .theme-swatch').count()) === 1)), 'and the swatch is back')

  // ---- projects: add one, move a board into it, delete a board with cards ----
  // The side panel's own space has a menu: below the projects, and its header. A row keeps its own.
  await until(async () => (await page.getByRole('dialog').count()) === 0)
  const treeBox = await page.locator('.sidebar .tree').boundingBox()
  // A locator's click, which waits for the point to reach the tree: the colours' crossfade (a view
  // transition) covers the window for a moment after the icon was cleared.
  await page.locator('.sidebar .tree').click({ button: 'right', position: { x: treeBox.width / 2, y: treeBox.height - 12 } })
  const panelAdd = page.locator('.ctx-menu').getByRole('menuitem', { name: 'Add project…' })
  check(!!(await until(async () => (await panelAdd.count()) === 1)), 'a right-click below the projects offers Add project…')
  await panelAdd.click()
  check(!!(await until(async () => (await page.getByRole('dialog').getByLabel('Board repo folder').count()) === 1)), 'which opens the Add project dialog')
  await page.keyboard.press('Escape')
  await until(async () => (await page.getByRole('dialog').count()) === 0)
  await page.locator('.sidebar-head .brand').click({ button: 'right' })
  check((await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Add project…' }).count()) === 1, "and so does a right-click on the side panel's header")
  await page.keyboard.press('Escape')
  await page.locator('.project-row').first().click({ button: 'right' })
  const rowMenuItems = await page.locator('.ctx-menu [role="menuitem"]').allTextContents()
  check(!rowMenuItems.some(t => t.includes('Add project')) && rowMenuItems.some(t => t.includes('New board')), "a project's row keeps its own menu")
  await page.keyboard.press('Escape')
  const second = path.join(scratch, 'second-board')
  await page.locator('.sidebar-head').getByRole('button', { name: '+' }).click()
  await page.getByRole('dialog').getByLabel('Board repo folder').fill(second)
  await page.getByRole('dialog').getByLabel(/^Name/).fill('Side project')
  // A folder with no board: the project's main board is made with it.
  const boardTitleField = page.getByRole('dialog').getByLabel('Board title')
  check(!!(await until(async () => (await boardTitleField.count()) === 1)), 'Add project on a new folder asks for its main board')
  const askedKey = await page.getByRole('dialog').getByLabel('Card key').inputValue()
  check((await boardTitleField.inputValue()) === 'Side project' && askedKey === 'SP', `titled after the project, its key derived (${askedKey})`)
  await page.getByRole('dialog').getByRole('button', { name: 'Add project' }).click()
  await page.locator('.project-row', { hasText: 'Side project' }).waitFor()
  check(existsSync(path.join(second, '.git')), 'a new project folder becomes a git repo')
  const sideMeta = await until(() => existsSync(path.join(second, 'side-project', 'board.json')) && JSON.parse(readFileSync(path.join(second, 'side-project', 'board.json'), 'utf8')))
  check(sideMeta?.title === 'Side project' && sideMeta?.key === 'SP' && sideMeta?.lists?.length === 3, 'with its main board, the default lists in it')
  check(JSON.parse(readFileSync(path.join(second, 'project.json'), 'utf8')).board === 'side-project', 'named in its project.json')
  check(!!(await until(async () => ((await page.locator('.tab.active').getAttribute('title')) ?? '') === 'side-project:side-project')), 'and opened')
  check((await page.locator('.project[data-project="side-project"] .empty-project').count()) === 0, 'so the project offers no + New board')
  check((await page.locator('.sidebar-foot').getByRole('button', { name: /Add project/ }).count()) === 0, 'the + beside the title replaces the footer\'s Add project link')
  check(existsSync(path.join(second, 'CLAUDE.md')) && existsSync(path.join(second, 'README.md')), 'with a README and a CLAUDE.md')
  check((await page.locator('.guide-offer').count()) === 0, 'so neither project offers a CLAUDE.md')
  check((await page.locator('.project-row').count()) === 2, 'the side panel shows both projects')
  // The main board stays while it is the main one: its menu says why, and the app refuses.
  await page.locator('.project-row').first().click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /Main board/ }).hover()
  const mainDelete = page.getByRole('menuitem', { name: /Delete board/ })
  const mainMove = page.getByRole('menuitem', { name: /Move to project/ })
  check(await mainDelete.isDisabled(), "the main board's Delete board… is disabled")
  check(await mainMove.isDisabled(), 'and so is its Move to project')
  check((await mainDelete.textContent()).includes('the main board'), `with a hint saying why (${await mainDelete.textContent()})`)
  await page.keyboard.press('Escape')
  const firstProject = await page.locator('.project').first().getAttribute('data-project')
  const keptMain = await page.evaluate(key => window.corkboard.boards.remove(key).then(() => 'deleted', e => e.message), `${firstProject}:${MAIN.path}`)
  check(keptMain.includes('main board') && existsSync(path.join(root, MAIN.path, 'board.json')), `and the app refuses to delete it (${keptMain})`)
  // Another main board, picked in the project settings: project.json names it, the row opens it.
  const pickMain = async title => {
    await openProjectSettings()
    await dialog.getByLabel('Main board').selectOption({ label: title })
    await dialog.getByRole('button', { name: 'Save' }).click()
  }
  const namedMain = () => existsSync(projectFile) && JSON.parse(readFileSync(projectFile, 'utf8')).board
  await pickMain(SPARE.title)
  check((await until(namedMain)) === SPARE.path, `picking ${SPARE.title} as the main board writes it to project.json`)
  check(!!(await until(async () => (await page.locator('.tree-row', { hasText: MAIN.title }).count()) === 1 && (await page.locator('.tree-row', { hasText: SPARE.title }).count()) === 0)), `${MAIN.title} gets a row under the project, ${SPARE.title} loses its own`)
  await page.locator('.project-row').first().click()
  check(!!(await until(async () => ((await page.locator('.tab.active').getAttribute('title')) ?? '').endsWith(`:${SPARE.path}`))), 'and the project opens it')
  await page.locator('.tab.active .tab-close').click()
  await pickMain(MAIN.title)
  check((await until(async () => namedMain() === MAIN.path)) === true, `picking ${MAIN.title} again`)
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  await page.locator('.tree-row', { hasText: SPARE.title }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Move to project' }).hover()
  await page.getByRole('menuitem', { name: 'Side project' }).click()
  await page.getByRole('button', { name: 'Move board' }).click()
  const movedBoard = await until(() => existsSync(path.join(second, SPARE.path, 'board.json')) && !existsSync(path.join(root, SPARE.path)))
  check(movedBoard, `${SPARE.title} moved into the other project, folder and cards`)
  check(cardFiles(path.join(second, SPARE.path, 'cards')).length === SPARE.files, `with its ${SPARE.files} cards`)
  await page.locator('.project[data-project] .tree-row', { hasText: SPARE.title }).waitFor()
  check((await page.locator('.tab[title="side-project:side-project"]').count()) === 1, "the receiving project's main board keeps its tab through the move")
  const secondLogHas = text => {
    try {
      return execFileSync('git', ['log', '--format=%B'], { cwd: second, stdio: 'pipe' }).toString().includes(text)
    } catch {
      return false // no commit yet
    }
  }
  check(!!(await until(() => secondLogHas(`Create board ${SPARE.path}`), 12000)), 'the other project commits the board it received')
  // Each project wears its own colours: the board in front decides, but a terminal keeps its own.
  const themedTerminal = page.locator('.terminal-tab', { has: page.locator('.theme-swatch') }).first()
  check((await themedTerminal.count()) === 1, "a terminal of the themed project carries its swatch")
  await themedTerminal.click()
  const terminalBg = () =>
    page.evaluate(() => {
      const scroller = document.querySelector('.xterm-host[style*="block"] .xterm-scrollable-element')
      return scroller ? getComputedStyle(scroller).backgroundColor : null
    })
  const themedBg = await terminalBg()
  check(!!themedBg && themedBg !== 'rgb(16, 18, 22)', `the terminal wears its project's background (${themedBg})`)
  await page.locator('.project[data-project] .tree-row', { hasText: SPARE.title }).click()
  check(!!(await until(async () => (await rootToken('--bg')) === '')), 'a board of a project with no theme shows the app colours')
  await sleep(300)
  check((await terminalBg()) === themedBg, `and the terminal keeps its project's (${await terminalBg()})`)
  check((await page.locator('.tab .theme-swatch').count()) >= 1, 'tabs of a themed project carry its swatch')
  await shot('14-projects')
  const fadesBefore = await fades()
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  check(!!(await until(async () => (await rootToken('--bg')) === '#1f1610')), 'back on the themed project, its colours return')
  check((await fades()) > fadesBefore, 'and fade in')
  // A click while the window fades reaches the page under the snapshot: slow the fade to be sure
  // it is still running when the click lands.
  const slow = await page.addStyleTag({ content: '::view-transition-group(root) { animation-duration: 3s }' })
  await page.locator('.tab', { hasText: SPARE.title }).click()
  await until(async () => (await rootToken('--bg')) === '')
  await shot('19b-theme-fading')
  const fading = () => page.evaluate(() => document.documentElement.getAnimations({ subtree: true }).some(a => a.effect?.pseudoElement?.startsWith('::view-transition')))
  check(await fading(), 'switching projects starts a crossfade')
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  check(!!(await until(async () => ((await page.locator('.tab.active').getAttribute('title')) ?? '').endsWith(`:${MAIN.path}`), 1000)), 'a click during the fade is not lost')
  await page.evaluate(el => el.remove(), slow)
  await until(async () => !(await fading()))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const fadesReduced = await fades()
  await page.locator('.tab', { hasText: SPARE.title }).click()
  await until(async () => (await rootToken('--bg')) === '')
  await page.locator(`.tab[title$=":${MAIN.path}"]`).first().click()
  check(!!(await until(async () => (await rootToken('--bg')) === '#1f1610')) && (await fades()) === fadesReduced, 'with reduced motion the colours swap without a fade')
  await page.emulateMedia({ reducedMotion: null })
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

  // ---- work mode: a project whose code repo never sees a card id ----
  await page.locator('.sidebar-head').getByRole('button', { name: '+' }).click()
  await page.getByRole('dialog').getByLabel('Board repo folder').fill(workRoot)
  await page.getByRole('dialog').getByLabel(/^Name/).fill(WORK.project)
  await sleep(500)
  check((await page.getByRole('dialog').getByLabel('Board title').count()) === 0, 'a repo that has boards is added without asking for one')
  await page.getByRole('dialog').getByRole('button', { name: 'Add project' }).click()
  const workRow = page.locator('.project-row', { hasText: WORK.project })
  await workRow.waitFor()
  const openWorkSettings = async () => {
    await workRow.click({ button: 'right' })
    await page.locator('.ctx-menu').getByRole('menuitem', { name: /Project settings…/ }).click()
  }
  await openWorkSettings()
  check(await dialog.getByLabel('Work mode').isChecked(), 'the project settings show work mode on, read from project.json')
  await shot('20-work-settings')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await workRow.click()
  const keyedCard = page.locator(`.card[data-card="${KEYED.id}"]`)
  await keyedCard.click()
  await page.locator('.drawer').waitFor()
  check((await page.locator('.drawer .jira-input').inputValue()) === KEYED.jira, 'the drawer shows the card its Jira key')
  check((await until(async () => (await page.locator('.drawer .commits li').count()) === 1)) === true, `${KEYED.id} lists the code repo's commit that names ${KEYED.jira} (no Card: trailer)`)
  check((await page.locator('.drawer .commits .subject').textContent()).includes('Fix the login form on Safari'), 'the right commit')
  await shot('21-work-drawer')
  // Tackled in a worktree: the branch is the key as written, the prompt names the key, no card id
  // but in the card's file path.
  const callsBeforeWork = sessionCalls().length
  await page.locator('.drawer').getByRole('button', { name: 'Worktree', exact: true }).click()
  const keyedCall = await until(() => sessionCalls()[callsBeforeWork], 15000)
  const keyedArgs = keyedCall.split('\0')
  check(keyedArgs[keyedArgs.indexOf('-w') + 1] === KEYED.jira, `the worktree is named ${KEYED.jira}, the key in its own case (got ${keyedArgs[keyedArgs.indexOf('-w') + 1]})`)
  const keyedPrompt = keyedArgs.at(-2) ?? ''
  check(keyedPrompt.startsWith(`Tackle ${KEYED.jira} from the task board: ${KEYED.title}`), 'the prompt opens with the Jira key')
  check(keyedPrompt.includes(`Name the Jira key ${KEYED.jira} in every commit message`) && keyedPrompt.includes('Never write a card id of the task board'), 'and carries the work-mode rule')
  const workIds = text => text.replace(path.join(workRoot, WORK.path, 'cards', `${KEYED.id}.md`), '').replace(path.join(workRoot, WORK.path, 'cards', `${UNKEYED.id}.md`), '').match(new RegExp(`\\b${WORK.key}-\\d+\\b`, 'g')) ?? []
  check(workIds(keyedPrompt).length === 0, `no card id in the prompt but in the file path (${workIds(keyedPrompt).join(' ') || 'none'})`)
  check(!keyedPrompt.includes('Put a `Card:') && keyedPrompt.includes('asks for `Card:` trailers: put none'), 'and asks for no Card: trailer, overriding the CLAUDE.md that does')
  // Without a key: the session asks for one; the worktree is named after the title.
  const unkeyedCard = page.locator(`.card[data-card="${UNKEYED.id}"]`)
  await unkeyedCard.click()
  check((await page.locator('.drawer .jira-input').inputValue()) === '', 'a card without a key shows an empty Jira field')
  await page.locator('.drawer').getByRole('button', { name: 'Worktree', exact: true }).click()
  const unkeyedCall = await until(() => sessionCalls()[callsBeforeWork + 1], 15000)
  const unkeyedArgs = unkeyedCall.split('\0')
  check(unkeyedArgs[unkeyedArgs.indexOf('-w') + 1] === UNKEYED.worktree, `a card with no key gets a worktree named after its title (got ${unkeyedArgs[unkeyedArgs.indexOf('-w') + 1]})`)
  const unkeyedPrompt = unkeyedArgs.at(-2) ?? ''
  check(unkeyedPrompt.startsWith(`Tackle this card from the task board: ${UNKEYED.title}`) && unkeyedPrompt.includes('ask me for it before your first commit'), 'its prompt opens with the title and asks for the key')
  check(workIds(unkeyedPrompt).length === 0, 'with no card id but in the file path')
  // The copy menu: the Jira key in place of the trailer, Markdown without the id.
  await keyedCard.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Jira key/ }).waitFor()
  check((await page.getByRole('menuitem', { name: /Commit trailer/ }).count()) === 0, 'a work card offers its Jira key to copy, and no Commit trailer')
  await page.getByRole('menuitem', { name: /Markdown/ }).click()
  check((await app.evaluate(({ clipboard }) => clipboard.readText())) === `[${KEYED.jira}] ${KEYED.title}`, 'Copy › Markdown names the Jira key, not the card id')
  await keyedCard.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Jira key/ }).click()
  check((await app.evaluate(({ clipboard }) => clipboard.readText())) === KEYED.jira, 'Copy › Jira key puts the key on the clipboard')
  // Typing a key into the drawer writes it to the card, upper case.
  await unkeyedCard.click()
  await page.locator('.drawer .jira-input').fill('spdi-77')
  await page.locator('.drawer .jira-input').press('Enter')
  check(await until(() => readFileSync(path.join(workRoot, WORK.path, 'cards', `${UNKEYED.id}.md`), 'utf8').includes('jira: SPDI-77')), 'a key typed in the drawer lands in the card file, upper case')
  // Work mode off from the settings: project.json goes and the trailer comes back.
  await openWorkSettings()
  await dialog.getByLabel('Work mode').uncheck()
  await dialog.getByRole('button', { name: 'Save' }).click()
  check(await until(() => !existsSync(path.join(workRoot, 'project.json'))), 'unticking work mode removes project.json')
  // The line may sit in a commit with the tackles' moves: the body is read too.
  const workLogHas = text => execFileSync('git', ['log', '--format=%B', '-5'], { cwd: workRoot, stdio: 'pipe' }).toString().includes(text)
  check(!!(await until(() => workLogHas('Turn work mode off'), 12000)), 'and the board repo commits the change by name')
  await keyedCard.click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('menuitem', { name: 'Copy' }).hover()
  await page.getByRole('menuitem', { name: /Commit trailer/ }).waitFor()
  check((await page.getByRole('menuitem', { name: /Jira key/ }).count()) === 0, 'a personal card offers the Commit trailer again')
  await page.keyboard.press('Escape')
  await openWorkSettings()
  await dialog.getByLabel('Work mode').check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  check(await until(() => existsSync(path.join(workRoot, 'project.json')) && JSON.parse(readFileSync(path.join(workRoot, 'project.json'), 'utf8')).work === true), 'ticking it writes project.json back')

  // ---- the side panel's order: a board among its siblings, a project among the projects ----
  const savedOrder = () => JSON.parse(readFileSync(path.join(scratch, 'profile', 'config.json'), 'utf8')).order ?? {}
  // Drags a row by its ⣿ handle to just above another row (the dragged block's middle then lies
  // above every other one, so it lands first).
  const dragByHandle = async (from, to) => {
    await from.hover()
    const hb = await from.locator('.drag-handle').first().boundingBox()
    const tb = await to.boundingBox()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 8, { steps: 3 })
    await page.mouse.move(tb.x + tb.width / 2, tb.y - 6, { steps: 15 })
    await page.mouse.up()
    // dnd-kit swallows clicks for 50 ms after a drop (the one a drop would otherwise make).
    await sleep(150)
  }
  const firstProjectId = await page.locator('.project').first().getAttribute('data-project')
  const siblingRows = page.locator(`.project[data-project="${firstProjectId}"] > [role="group"] > [role="treeitem"] > .tree-row`)
  const siblingTitles = () => siblingRows.locator('.tree-title').allTextContents()
  const titlesBefore = await siblingTitles()
  const lastBoard = titlesBefore.at(-1)
  check((await siblingRows.first().locator('.drag-handle').evaluate(el => getComputedStyle(el).visibility)) === 'hidden', 'a row hides its ⣿ handle until hovered')
  const tabBeforeDrag = await page.locator('.tab.active').getAttribute('title')
  await dragByHandle(siblingRows.last(), siblingRows.first())
  check(!!(await until(async () => (await siblingTitles())[0] === lastBoard)), `dragging ${lastBoard} by its handle puts it first among its siblings (${(await siblingTitles()).join(', ')})`)
  check(!!(await until(() => savedOrder().boards?.length === titlesBefore.length)), `the order is saved in this machine's config (${JSON.stringify(savedOrder().boards)})`)
  check((await page.locator('.tab.active').getAttribute('title')) === tabBeforeDrag, 'a drag opens nothing')
  const projectIds = () => page.locator('.project').evaluateAll(els => els.map(el => el.dataset.project))
  const idsBefore = await projectIds()
  const lastProject = idsBefore.at(-1)
  await dragByHandle(page.locator('.project-row').last(), page.locator('.project-row').first())
  check(!!(await until(async () => (await projectIds())[0] === lastProject)), `dragging the project ${lastProject} puts it first (${(await projectIds()).join(', ')})`)
  check(!!(await until(() => savedOrder().projects?.[0] === lastProject)), `the project order is saved too (${JSON.stringify(savedOrder().projects)})`)
  rememberedOrder = { projects: await projectIds(), project: firstProjectId, boards: await siblingTitles() }

  // ---- the side panel folds to a rail of project marks ----
  const projectNames = await page.locator('.project-name').allTextContents()
  await page.locator('.sidebar-head').getByRole('button', { name: 'Collapse the side panel' }).click()
  check(!!(await until(async () => (await page.locator('.sidebar.rail').count()) === 1)), "the header's button folds the side panel to a rail")
  const railIds = () => page.locator('.rail-mark').evaluateAll(els => els.map(el => el.dataset.project))
  check(JSON.stringify(await railIds()) === JSON.stringify(rememberedOrder.projects), `with a mark per project, in the side panel's order (${await railIds()})`)
  const railTitles = await page.locator('.rail-mark').evaluateAll(els => els.map(el => el.title))
  check(JSON.stringify(railTitles) === JSON.stringify(projectNames), `each named in its tooltip (${railTitles.join(', ')})`)
  check((await page.locator('.rail-mark .project-icon, .rail-mark .theme-swatch').count()) === projectNames.length, "each mark the project's icon or swatch")
  const railLeftovers = await page.locator('.sidebar .project-row, .sidebar .tree-row, .sidebar-foot, .sidebar .resize-x, .sidebar .brand').count()
  check(railLeftovers === 0, `and nothing else: no rows, footer, title or resize handle (${railLeftovers})`)
  const railWidth = (await page.locator('.sidebar').boundingBox()).width
  const mainLeft = (await page.locator('main.main').boundingBox()).x
  check(railWidth <= 49 && mainLeft <= 49, `the main view takes the freed width (rail ${railWidth} px, main view from ${mainLeft})`)
  await page.locator('.rail-mark[data-project="side-project"]').click()
  check(!!(await until(async () => (await page.locator('.tab.active').getAttribute('title')) === 'side-project:side-project')), "a click on a project's mark opens its main board")
  check((await page.locator('.rail-mark.active').getAttribute('data-project')) === 'side-project', 'and the mark shows its project is in front')
  await page.locator('.sidebar-head').getByRole('button', { name: 'Expand the side panel' }).click()
  check(!!(await until(async () => (await page.locator('.project-row').count()) === projectNames.length)), 'its button unfolds the side panel again')
  check((await page.locator('.sidebar-foot').count()) === 1 && (await page.locator('.sidebar .resize-x').count()) === 1, 'with its footer and resize handle')
  check((await page.locator('.sidebar').boundingBox()).width > 150, 'at its width before')
  // Folded again for the restart, which finds it so.
  await page.locator('.sidebar-head').getByRole('button', { name: 'Collapse the side panel' }).click()
  await page.locator('.sidebar.rail').waitFor()

  // Table view.
  await page.locator(`.tab[title$=":${MAIN.path}"]`).click()
  await page.getByRole('tab', { name: 'Table', exact: true }).click()
  check((await page.locator('.table-view tbody tr').count()) > 100, 'table lists the cards')
  const viewTh = await page.locator('.table-view th').first().evaluate(th => ({ wrap: getComputedStyle(th).whiteSpace, position: getComputedStyle(th).position }))
  check(viewTh.wrap === 'nowrap' && viewTh.position === 'sticky', `the Table view's headers keep their own rules (${JSON.stringify(viewTh)})`)
  await shot('07-table')
  // Shift-click selects the rows from the last one Ctrl-clicked, as sorted.
  if (await page.locator('.drawer').count()) await page.locator('.drawer').getByRole('button', { name: 'Close', exact: true }).click()
  const tableRows = page.locator('.table-view tbody tr')
  const tableRangeIds = await tableRows.evaluateAll(rows => rows.slice(1, 5).map(r => r.querySelector('td').textContent))
  await tableRows.nth(1).click({ modifiers: ['Control'] })
  await tableRows.nth(4).click({ modifiers: ['Shift'] })
  const tableRangeGot = await page.locator('.table-view tbody tr.selected').evaluateAll(rows => rows.map(r => r.querySelector('td').textContent))
  check(
    tableRangeGot.join(',') === tableRangeIds.join(','),
    `Shift-click in the table selects the rows from the anchor (${tableRangeGot.join(',')})`,
  )
  check(await page.evaluate(() => getSelection().toString() === ''), 'and selects no text across them')
  await page.locator('.selection-bar').getByRole('button', { name: 'Clear' }).click()

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

// ---- after a restart: what this machine remembers ----
if (rememberedOrder) {
  const again = await launchApp()
  const pageAgain = await again.firstWindow()
  pageAgain.on('pageerror', e => {
    console.log('PAGE ERROR (restart)', e.message)
    failures++
  })
  try {
    await pageAgain.setViewportSize({ width: 1500, height: 940 }).catch(() => {})
    await pageAgain.locator('.sidebar').waitFor()
    const railAgain = await until(async () => {
      const ids = await pageAgain.locator('.rail-mark').evaluateAll(els => els.map(el => el.dataset.project))
      return ids.length === rememberedOrder.projects.length && ids
    })
    check(JSON.stringify(railAgain) === JSON.stringify(rememberedOrder.projects), `after a restart the side panel is still folded to its rail, marks in order (${railAgain})`)
    await pageAgain.locator('.sidebar-head').getByRole('button', { name: 'Expand the side panel' }).click()
    const idsAgain = () => pageAgain.locator('.project').evaluateAll(els => els.map(el => el.dataset.project))
    const restartedIds = await until(async () => {
      const ids = await idsAgain()
      return ids.length === rememberedOrder.projects.length && ids
    })
    check(JSON.stringify(restartedIds) === JSON.stringify(rememberedOrder.projects), `after a restart the projects keep the dragged order (${restartedIds})`)
    const titlesAgain = await pageAgain
      .locator(`.project[data-project="${rememberedOrder.project}"] > [role="group"] > [role="treeitem"] > .tree-row .tree-title`)
      .allTextContents()
    check(JSON.stringify(titlesAgain) === JSON.stringify(rememberedOrder.boards), `and the boards theirs (${titlesAgain.join(', ')})`)
  } catch (error) {
    console.log('FAIL (restart)', error)
    failures++
    await pageAgain.screenshot({ path: path.join(shots, '99-restart-failure.png') }).catch(() => {})
  } finally {
    await again.close()
  }
}

writeFileSync(path.join(shots, 'main-process.log'), mainLog.join(''))
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
console.log(`scratch: ${scratch}\nshots: ${shots}`)
process.exit(failures ? 1 : 0)
