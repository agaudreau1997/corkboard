import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AppConfig,
  BoardMap,
  BoardMeta,
  Card,
  CardPatch,
  ClaudeInfo,
  NotifyConfig,
  ProjectConfig,
  ProjectSettings,
  ProjectTheme,
  SessionRef,
  SyncStatus,
  TackleRequest,
  TerminalEvent,
  UpdateStatus,
} from '@shared/types'
import { autoUpdater } from 'electron-updater'
import { desktopAvailable, openUrl } from './desktop'
import { codeCommits, commitFiles } from './git'
import { notify } from './notify'
import { boardKey, prepareBoardRepo, Project, projectId, splitKey } from './projects'
import { PtyManager } from './pty'
import { shellProbe } from './shell'
import { CLAUDE, openInDesktop, promptFor, resume, stopDesktopWatches, tackle } from './tackle'
import { releasesPage, updateMode, Updates } from './updates'

// Test seams: a scratch profile, a board root, a hidden window, short delays, a folder picker.
if (process.env.CORKBOARD_USER_DATA) app.setPath('userData', process.env.CORKBOARD_USER_DATA)
const HIDDEN = process.env.CORKBOARD_HIDDEN === '1'
const TIMING = {
  commitDelayMs: Number(process.env.CORKBOARD_COMMIT_DELAY_MS ?? 8000),
  syncIntervalMs: Number(process.env.CORKBOARD_SYNC_INTERVAL_MS ?? 60_000),
}
const UPDATE_CHECK_MS = 4 * 60 * 60_000

let win: BrowserWindow | undefined
const projects = new Map<string, Project>()
const commitCache = new Map<string, { at: number; commits: Awaited<ReturnType<typeof codeCommits>> }>()

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const ptys = new PtyManager({
  created: info => send('pty:created', info),
  data: (id, data) => send('pty:data', id, data),
  exit: (id, code, info, status) => {
    send('pty:exit', id, code)
    void notifyTerminal({ event: 'exit', previous: status, terminal: info, exitCode: code })
  },
  status: (id, status, previous, info) => {
    send('pty:status', id, status)
    void notifyTerminal({ event: status, previous, terminal: info })
  },
})

/**
 * Runs the notification program (app settings) for a terminal event, when one is set. A failure
 * goes to the log and not to the window: the event is already shown there, and the settings'
 * *Try it* is where the person finds out what the program does.
 */
async function notifyTerminal(event: TerminalEvent): Promise<void> {
  const command = (await readSavedConfig()).notify?.command.trim()
  if (!command) return
  try {
    await notify(command, event)
  } catch (error) {
    console.error(`Notification program (${event.event}):`, (error as Error).message)
  }
}

// ---- config ----------------------------------------------------------------------------------

const configFile = () => path.join(app.getPath('userData'), 'config.json')

async function readSavedConfig(): Promise<AppConfig> {
  let saved: Partial<AppConfig> = {}
  try {
    saved = JSON.parse(await fs.readFile(configFile(), 'utf8')) as AppConfig
  } catch {
    /* first run */
  }
  let list = saved.projects ?? []
  let codeRepos = saved.codeRepos ?? {}
  // The single board repo of earlier versions becomes the first project; its per-board code
  // repos were keyed by the board path alone.
  if (!saved.projects && saved.boardRoot) {
    const id = projectId(path.basename(saved.boardRoot), new Set())
    list = [{ id, name: path.basename(saved.boardRoot), boardRoot: saved.boardRoot }]
    codeRepos = Object.fromEntries(Object.entries(codeRepos).map(([k, v]) => [k.includes(':') ? k : boardKey(id, k), v]))
  }
  return { projects: list, codeRepos, ...(saved.notify ? { notify: saved.notify } : {}) }
}

/**
 * What the app opens: the saved projects, with CORKBOARD_ROOT (tests) first when set. With
 * nothing saved there is none, and the window asks for one (*Add project…*).
 */
async function readConfig(): Promise<AppConfig> {
  const saved = await readSavedConfig()
  const env = process.env.CORKBOARD_ROOT
  if (!env) return saved
  const others = saved.projects.filter(p => path.resolve(p.boardRoot) !== path.resolve(env))
  const id = projectId(path.basename(env), new Set(others.map(p => p.id)))
  return { ...saved, projects: [{ id, name: path.basename(env), boardRoot: env }, ...others] }
}

async function writeConfig(update: (config: AppConfig) => AppConfig): Promise<AppConfig> {
  // Starts from what the app has open, the test's project included (left out of the file below).
  const next = update(await readConfig())
  const env = process.env.CORKBOARD_ROOT
  // The test's project is not saved: it comes from the environment every time.
  const toSave = env ? { ...next, projects: next.projects.filter(p => path.resolve(p.boardRoot) !== path.resolve(env)) } : next
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(configFile(), `${JSON.stringify(toSave, null, 2)}\n`)
  return next
}

function localReposFor(config: AppConfig, id: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, repo] of Object.entries(config.codeRepos ?? {})) {
    if (!key.includes(':')) continue
    const { projectId: pid, rel } = splitKey(key)
    if (pid === id) out[rel] = repo
  }
  return out
}

let opened: Promise<void> | undefined

/** Opens every configured project once; later calls wait for the same opening. */
function openProjects(): Promise<void> {
  opened ??= (async () => {
    const config = await readConfig()
    for (const pc of config.projects) await openProject(pc, config)
  })()
  return opened
}

async function openProject(pc: ProjectConfig, config: AppConfig): Promise<Project | undefined> {
  if (projects.has(pc.id)) return projects.get(pc.id)
  if (!existsSync(pc.boardRoot)) return undefined
  const project = new Project(
    pc,
    localReposFor(config, pc.id),
    {
      delta: delta => send('board:delta', delta),
      treeChanged: () => send('boards:treeChanged'),
      committed: (id, summary) => send('git:boardCommitted', id, summary),
      syncStatus: (id, status) => send('sync:status', id, status),
    },
    TIMING,
  )
  projects.set(pc.id, project)
  await project.open()
  return project
}

function projectOf(key: string): { project: Project; rel: string } {
  const { projectId: id, rel } = splitKey(key)
  const project = projects.get(id)
  if (!project) throw new Error(`No project ${id} is open.`)
  return { project, rel }
}

function store(key: string) {
  const { project, rel } = projectOf(key)
  return { store: project.store, rel, project }
}

function codeRepoOf(key: string): string | undefined {
  const { project, rel } = projectOf(key)
  return project.store.board(rel).codeRepo
}

async function pickFolder(title: string): Promise<string | null> {
  if (process.env.CORKBOARD_PICK_FOLDER) return process.env.CORKBOARD_PICK_FOLDER
  const result = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function pickFile(title: string): Promise<string | null> {
  if (process.env.CORKBOARD_PICK_FILE) return process.env.CORKBOARD_PICK_FILE
  const result = await dialog.showOpenDialog(win!, { title, properties: ['openFile'] })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

// ---- moves between projects --------------------------------------------------------------------

async function moveCard(fromKey: string, id: string, toKey: string, list: string | null, pos?: number): Promise<Card> {
  const from = projectOf(fromKey)
  const to = projectOf(toKey)
  if (from.project === to.project) return from.project.store.moveCard(from.rel, id, to.rel, list, pos)
  const card = from.project.store.board(from.rel).cards.find(c => c.id === id)
  if (!card) throw new Error(`No card ${id}`)
  if (to.project.store.findCard(id)) throw new Error(`${to.project.name} already has a card ${id}.`)
  const adopted = await to.project.store.adoptCard(to.rel, { ...card, list, ...(pos === undefined ? {} : { pos }) })
  await from.project.store.dropCard(from.rel, id)
  return adopted
}

async function moveList(fromKey: string, listId: string, toKey: string): Promise<string> {
  const from = projectOf(fromKey)
  const to = projectOf(toKey)
  if (from.project === to.project) return from.project.store.moveList(from.rel, listId, to.rel)
  const source = from.project.store.board(from.rel)
  const list = source.meta.lists.find(l => l.id === listId)
  if (!list) throw new Error(`No list ${listId}`)
  const target = to.project.store.board(to.rel)
  let id = list.id
  for (let n = 2; target.meta.lists.some(l => l.id === id); n++) id = `${list.id}-${n}`
  await to.project.store.updateMeta(to.rel, { lists: [...target.meta.lists, { ...list, id }] })
  for (const card of source.cards.filter(c => c.list === listId)) await moveCard(fromKey, card.id, toKey, id, card.pos)
  await from.project.store.updateMeta(from.rel, { lists: source.meta.lists.filter(l => l.id !== listId) })
  return id
}

/**
 * Moves a board folder (its child boards with it) to the top of another project's repo. Card ids
 * travel with it, so its keys must be free there.
 */
async function moveBoardToProject(key: string, targetId: string): Promise<string> {
  const from = projectOf(key)
  const target = projects.get(targetId)
  if (!target) throw new Error(`No project ${targetId}`)
  if (target === from.project) throw new Error('The board is already in that project.')
  const keys = from.project.store.keysUnder(from.rel)
  const taken = new Set(target.store.allBoards().map(b => b.meta.key))
  const clash = keys.filter(k => taken.has(k))
  if (clash.length) throw new Error(`${target.name} already uses the key${clash.length > 1 ? 's' : ''} ${clash.join(', ')}.`)
  const name = path.basename(from.rel)
  let dest = name
  for (let n = 2; existsSync(path.join(target.root, dest)); n++) dest = `${name}-${n}`
  await fs.cp(path.join(from.project.root, from.rel), path.join(target.root, dest), { recursive: true })
  await from.project.store.deleteBoard(from.rel, true)
  await target.store.reload()
  from.project.committer.touch()
  target.committer.touch()
  return target.key(dest)
}

// ---- IPC -------------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('config:get', async () => {
    await openProjects()
    return readConfig()
  })

  ipcMain.handle('projects:list', async () => {
    await openProjects()
    return [...projects.values()].map(p => p.node())
  })
  ipcMain.handle('projects:pickFolder', (_e, title: string) => pickFolder(title))
  ipcMain.handle('projects:add', async (_e, opts: { boardRoot: string; name?: string; codeRepo?: string }) => {
    await openProjects()
    const root = path.resolve(opts.boardRoot)
    if ([...projects.values()].some(p => p.root === root)) throw new Error('That board repo is already a project.')
    await prepareBoardRepo(root)
    const name = opts.name?.trim() || path.basename(root)
    const pc: ProjectConfig = {
      id: projectId(name, new Set(projects.keys())),
      name,
      boardRoot: root,
      ...(opts.codeRepo ? { codeRepo: opts.codeRepo } : {}),
    }
    const config = await writeConfig(c => ({ ...c, projects: [...c.projects, pc] }))
    await openProject(pc, config)
    send('boards:treeChanged')
    return pc.id
  })
  ipcMain.handle('projects:update', async (_e, id: string, patch: { name?: string; codeRepo?: string | null }) => {
    const project = projects.get(id)
    if (!project) throw new Error(`No project ${id}`)
    const config = await writeConfig(c => ({
      ...c,
      projects: c.projects.map(p => {
        if (p.id !== id) return p
        const next = { ...p, ...(patch.name !== undefined ? { name: patch.name.trim() || p.name } : {}) }
        if (patch.codeRepo !== undefined) {
          if (patch.codeRepo) next.codeRepo = patch.codeRepo
          else delete next.codeRepo
        }
        return next
      }),
    }))
    const pc = config.projects.find(p => p.id === id)
    if (pc) {
      project.name = pc.name
      project.setCodeRepo(pc.codeRepo, localReposFor(config, id))
    }
    commitCache.clear()
    send('boards:treeChanged')
  })
  ipcMain.handle('projects:setTheme', async (_e, id: string, theme: ProjectTheme | null) => {
    const project = projects.get(id)
    if (!project) throw new Error(`No project ${id}`)
    await project.store.saveTheme(theme)
  })
  ipcMain.handle('projects:setSettings', async (_e, id: string, settings: ProjectSettings) => {
    const project = projects.get(id)
    if (!project) throw new Error(`No project ${id}`)
    await project.store.saveSettings(settings)
    commitCache.clear()
  })
  ipcMain.handle('projects:addGuide', async (_e, id: string) => {
    const project = projects.get(id)
    if (!project) throw new Error(`No project ${id}`)
    await project.addGuide()
    send('boards:treeChanged')
  })
  ipcMain.handle('projects:remove', async (_e, id: string) => {
    const project = projects.get(id)
    if (!project) return
    await project.close()
    projects.delete(id)
    await writeConfig(c => ({ ...c, projects: c.projects.filter(p => p.id !== id) }))
    send('boards:treeChanged')
  })

  ipcMain.handle('config:setCodeRepo', async (_e, key: string, repo: string | null) => {
    const { project } = projectOf(key)
    const config = await writeConfig(c => {
      const codeRepos = { ...(c.codeRepos ?? {}) }
      if (repo) codeRepos[key] = repo
      else delete codeRepos[key]
      return { ...c, codeRepos }
    })
    project.setCodeRepo(project.codeRepo, localReposFor(config, project.id))
    commitCache.clear()
    return projectOf(key).project.board(projectOf(key).rel)
  })
  ipcMain.handle('config:pickFolder', (_e, title: string) => pickFolder(title))
  ipcMain.handle('config:pickFile', (_e, title: string) => pickFile(title))
  ipcMain.handle('config:setNotify', async (_e, notify: NotifyConfig | null) => {
    const command = notify?.command.trim()
    await writeConfig(c => {
      const { notify: _, ...rest } = c
      return command ? { ...rest, notify: { command } } : rest
    })
  })
  // Runs a program as the notifications would, with a `test` event; answers what went wrong.
  ipcMain.handle('config:tryNotify', async (_e, command: string): Promise<string | null> => {
    const terminal = { id: 'test', title: 'Test', cwd: os.homedir() }
    try {
      await notify(command, { event: 'test', previous: 'shell', terminal })
      return null
    } catch (error) {
      return (error as Error).message
    }
  })

  ipcMain.handle('boards:load', (_e, key: string) => {
    const { project, rel } = projectOf(key)
    return project.board(rel)
  })
  ipcMain.handle('boards:create', async (_e, parentKey: string, title: string, key?: string) => {
    // A board at a project's top level has the parent `<project id>:`.
    const { project, rel } = projectOf(parentKey)
    return project.key(await project.store.createBoard(rel, title, key))
  })
  ipcMain.handle('boards:updateMeta', (_e, key: string, patch: Partial<BoardMeta>) => {
    const s = store(key)
    return s.store.updateMeta(s.rel, patch)
  })
  ipcMain.handle('boards:remove', (_e, key: string, force?: boolean) => {
    const s = store(key)
    return s.store.deleteBoard(s.rel, !!force)
  })
  ipcMain.handle('boards:moveToProject', (_e, key: string, targetId: string) => moveBoardToProject(key, targetId))
  ipcMain.handle('boards:index', () =>
    [...projects.values()].flatMap(project =>
      project.store.allBoards().flatMap(b =>
        b.cards
          .filter(c => !c.archived)
          .map(c => ({ id: c.id, title: c.title, boardPath: project.key(b.path), boardTitle: b.meta.title })),
      ),
    ),
  )

  ipcMain.handle('cards:create', (_e, key: string, fields) => {
    const s = store(key)
    return s.store.createCard(s.rel, fields)
  })
  ipcMain.handle('cards:update', (_e, key: string, id: string, patch: CardPatch) => {
    const s = store(key)
    return s.store.updateCard(s.rel, id, patch)
  })
  ipcMain.handle('cards:updateMany', (_e, key: string, patches: { id: string; patch: CardPatch }[]) => {
    const s = store(key)
    return s.store.updateCards(s.rel, patches)
  })
  ipcMain.handle('cards:move', (_e, from: string, id: string, to: string, list: string | null, pos?: number) =>
    moveCard(from, id, to, list, pos),
  )
  ipcMain.handle('cards:duplicate', (_e, key: string, id: string) => {
    const s = store(key)
    return s.store.duplicateCard(s.rel, id)
  })
  ipcMain.handle('cards:filePath', (_e, key: string, id: string) => {
    const s = store(key)
    return s.store.cardFile(s.rel, id)
  })
  ipcMain.handle('lists:move', (_e, from: string, listId: string, to: string) => moveList(from, listId, to))
  ipcMain.handle('map:save', (_e, key: string, map: BoardMap) => {
    const s = store(key)
    return s.store.saveMap(s.rel, map)
  })

  ipcMain.handle('git:cardCommits', async (_e, key: string) => {
    const repo = codeRepoOf(key)
    if (!repo || !existsSync(repo)) return []
    // A work project's cards are also found by their Jira keys, so the cache is per set of keys.
    const { project, rel } = projectOf(key)
    const keys = project.store.settings.work
      ? project.store.board(rel).cards.flatMap(c => (c.jira ? [c.jira.toUpperCase()] : [])).sort()
      : []
    const cacheKey = `${repo}\0${keys.join(',')}`
    const cached = commitCache.get(cacheKey)
    if (cached && Date.now() - cached.at < 10_000) return cached.commits
    const commits = await codeCommits(repo, keys).catch(() => [])
    commitCache.set(cacheKey, { at: Date.now(), commits })
    return commits
  })
  ipcMain.handle('git:commitFiles', async (_e, key: string, sha: string) => {
    const repo = codeRepoOf(key)
    return repo ? commitFiles(repo, sha) : []
  })
  ipcMain.handle('sync:now', async (_e, id?: string) => {
    const list = id ? [projects.get(id)].filter((p): p is Project => !!p) : [...projects.values()]
    const results = await Promise.all(list.map(p => p.sync.sync()))
    return results[0] ?? ({ state: 'local' } as SyncStatus)
  })

  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)))
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('claude:info', () => claudeInfo())
  ipcMain.handle('claude:update', (_e, key?: string) => {
    const repo = key ? codeRepoOf(key) : undefined
    return ptys.create({ title: 'claude update', cwd: repo && existsSync(repo) ? repo : os.homedir(), command: [CLAUDE, 'update'] })
  })
  ipcMain.handle('claude:desktopAvailable', () => desktopAvailable())

  ipcMain.handle('updates:status', () => updates?.status ?? updatesOff)
  ipcMain.handle('updates:check', () => updates?.check())
  ipcMain.handle('updates:install', () => updates?.install())

  ipcMain.handle('pty:create', (_e, opts: { title: string; boardPath?: string; cwd?: string }) => {
    let cwd = opts.cwd
    if (!cwd && opts.boardPath) {
      const { project } = projectOf(opts.boardPath)
      const repo = codeRepoOf(opts.boardPath)
      cwd = repo && existsSync(repo) ? repo : project.root
    }
    return ptys.create({ title: opts.title, cwd: cwd ?? os.homedir(), boardKey: opts.boardPath })
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.handle('pty:list', () => ptys.list())
  ipcMain.handle('pty:running', (_e, id: string) => ptys.running(id))

  const open = (url: string) => shell.openExternal(url)
  ipcMain.handle('tackle:start', (_e, req: TackleRequest) => {
    const { project, rel } = projectOf(req.boardPath)
    return tackle({ ...req, boardPath: rel }, project.store, ptys, open, req.boardPath)
  })
  ipcMain.handle('tackle:prompt', (_e, req: TackleRequest) => {
    const { project, rel } = projectOf(req.boardPath)
    return promptFor({ ...req, boardPath: rel }, project.store)
  })
  ipcMain.handle('tackle:resume', (_e, key: string, ref: SessionRef) => {
    const { project, rel } = projectOf(key)
    return resume(project.store, ptys, rel, ref, open, key)
  })
  ipcMain.handle('tackle:openInDesktop', (_e, ref: SessionRef) => openInDesktop(ref, open))

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void openUrl(url, open)
  })
  ipcMain.on('shell:openPath', (_e, target: string) => {
    const resolved = path.resolve(target)
    if ([...projects.values()].some(p => resolved.startsWith(p.root))) void shell.openPath(resolved)
  })
}

/** `claude --version` as the terminals would run it: through a login shell, for nvm's PATH. */
function claudeInfo(): Promise<ClaudeInfo> {
  return new Promise(resolve => {
    const probe = shellProbe({
      unix: `command -v ${CLAUDE} && ${CLAUDE} --version`,
      windows: `(Get-Command ${CLAUDE}).Source; & ${CLAUDE} --version`,
    })
    execFile(probe.file, probe.args, { timeout: 20_000, env: process.env, windowsHide: true }, (error, stdout) => {
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
      const version = /(\d+\.\d+\.\d+)/.exec(lines.find(l => /Claude Code/i.test(l)) ?? lines.at(-1) ?? '')?.[1]
      const where = lines.find(l => l.startsWith('/') || /^[A-Za-z]:\\/.test(l))
      resolve(version ? { version, path: where } : { error: error?.message ?? 'claude not found' })
    })
  })
}

// ---- updates ---------------------------------------------------------------------------------

let updates: Updates | undefined
let updatesOff: UpdateStatus = { current: app.getVersion(), state: 'off' }

/** Starts checking for updates, when this copy is one that updates (see updates.ts). */
function startUpdates(): void {
  const resource = (name: string) => {
    try {
      return readFileSync(path.join(process.resourcesPath, name), 'utf8').trim()
    } catch {
      return undefined
    }
  }
  const mode = updateMode({
    packaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    releases: releasesPage(resource('app-update.yml')),
    packageType: resource('package-type'),
    rpmOwned: () => {
      try {
        execFileSync('rpm', ['-qf', process.execPath], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    nsisInstalled: () => readdirSync(path.dirname(process.execPath)).some(f => /^Uninstall .*\.exe$/i.test(f)),
  })
  if (mode.kind === 'off') {
    updatesOff = { ...updatesOff, message: mode.why }
    return
  }
  updates = new Updates(autoUpdater, {
    current: app.getVersion(),
    releases: mode.releases,
    notifyOnly: mode.kind === 'notify',
    prepareQuit,
    relaunch: () => {
      app.relaunch()
      app.quit()
    },
    onStatus: status => send('updates:changed', status),
  })
  updates.start(UPDATE_CHECK_MS)
}

// ---- window ----------------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Corkboard',
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // A test's hidden window renders offscreen: a plain hidden window stops its animation
      // frames after the first capture, and the clicks that follow never see a stable element.
      offscreen: HIDDEN,
      backgroundThrottling: !HIDDEN,
    },
  })
  win.on('ready-to-show', () => {
    if (!HIDDEN) win?.show()
  })
  // Coming back to the window is when the other machine's changes matter.
  win.on('focus', () => {
    for (const project of projects.values()) project.sync.syncIfStale()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void openUrl(url, u => shell.openExternal(u))
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  startUpdates()
})

let shutdown: Promise<void> | undefined
let readyToQuit = false

/**
 * What happens before the process goes, once: the terminals stop, and what is pending is committed
 * and pushed, but never holding the quit for long. A quit waits for it, and so does an update's
 * install, which starts before the quit.
 */
function prepareQuit(): Promise<void> {
  shutdown ??= (async () => {
    try {
      ptys.killAll()
      stopDesktopWatches()
      updates?.stop()
      const pending = [...projects.values()].map(async p => {
        p.store.close()
        p.sync.stop()
        await p.sync.flush()
      })
      await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 10_000))])
    } catch (error) {
      console.error('Before quitting:', error)
    } finally {
      // Whatever happened, the quit goes through.
      readyToQuit = true
    }
  })()
  return shutdown
}

app.on('before-quit', event => {
  if (readyToQuit) return
  event.preventDefault()
  void prepareQuit().finally(() => app.quit())
})

app.on('window-all-closed', () => app.quit())
