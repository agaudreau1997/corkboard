import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig, BoardMap, BoardMeta, CardPatch, SessionRef, TackleRequest } from '@shared/types'
import { AutoCommitter, codeCommits, commitFiles } from './git'
import { PtyManager } from './pty'
import { BoardStore } from './store'
import { resume, tackle } from './tackle'

// Test seams: a scratch profile, a board root, a hidden window, a short commit delay.
if (process.env.CORKBOARD_USER_DATA) app.setPath('userData', process.env.CORKBOARD_USER_DATA)
const HIDDEN = process.env.CORKBOARD_HIDDEN === '1'
const COMMIT_DELAY_MS = Number(process.env.CORKBOARD_COMMIT_DELAY_MS ?? 8000)
const DEFAULT_ROOT = path.join(os.homedir(), 'Documents/Godot/Projects/deus-board')

let win: BrowserWindow | undefined
let store: BoardStore | undefined
let committer: AutoCommitter | undefined
const commitCache = new Map<string, { at: number; commits: Awaited<ReturnType<typeof codeCommits>> }>()

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const ptys = new PtyManager({
  created: info => send('pty:created', info),
  data: (id, data) => send('pty:data', id, data),
  exit: (id, code) => send('pty:exit', id, code),
})

// ---- config ----------------------------------------------------------------------------------

const configFile = () => path.join(app.getPath('userData'), 'config.json')

async function readConfig(): Promise<AppConfig | null> {
  if (process.env.CORKBOARD_ROOT) return { boardRoot: process.env.CORKBOARD_ROOT }
  try {
    const config = JSON.parse(await fs.readFile(configFile(), 'utf8')) as AppConfig
    if (config.boardRoot && existsSync(config.boardRoot)) return config
  } catch {
    /* first run */
  }
  return existsSync(DEFAULT_ROOT) ? { boardRoot: DEFAULT_ROOT } : null
}

async function writeConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(configFile(), `${JSON.stringify(config, null, 2)}\n`)
}

async function openRoot(root: string): Promise<void> {
  store?.close()
  await committer?.flush()
  store = new BoardStore(root)
  await store.init()
  committer = new AutoCommitter(root, COMMIT_DELAY_MS, summary => send('git:boardCommitted', summary))
  store.watch({
    onDelta: delta => {
      send('board:delta', delta)
      committer?.touch()
    },
    onTreeChanged: () => {
      send('boards:treeChanged')
      committer?.touch()
    },
  })
}

function requireStore(): BoardStore {
  if (!store) throw new Error('No board repo is open.')
  return store
}

// ---- IPC -------------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('config:get', async () => {
    const config = await readConfig()
    if (config && (!store || store.root !== path.resolve(config.boardRoot))) await openRoot(config.boardRoot)
    return config
  })
  ipcMain.handle('config:pickRoot', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose the board repo',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const config = { boardRoot: result.filePaths[0] }
    await writeConfig(config)
    await openRoot(config.boardRoot)
    return config
  })

  ipcMain.handle('boards:tree', () => requireStore().tree())
  ipcMain.handle('boards:load', (_e, p: string) => requireStore().board(p))
  ipcMain.handle('boards:create', (_e, parent: string, title: string, key?: string) =>
    requireStore().createBoard(parent, title, key),
  )
  ipcMain.handle('boards:updateMeta', (_e, p: string, patch: Partial<BoardMeta>) =>
    requireStore().updateMeta(p, patch),
  )
  ipcMain.handle('boards:remove', (_e, p: string) => requireStore().deleteBoard(p))
  ipcMain.handle('boards:index', () =>
    requireStore()
      .allBoards()
      .flatMap(b =>
        b.cards
          .filter(c => !c.archived)
          .map(c => ({ id: c.id, title: c.title, boardPath: b.path, boardTitle: b.meta.title })),
      ),
  )

  ipcMain.handle('cards:create', (_e, p: string, fields) => requireStore().createCard(p, fields))
  ipcMain.handle('cards:update', (_e, p: string, id: string, patch: CardPatch) =>
    requireStore().updateCard(p, id, patch),
  )
  ipcMain.handle('cards:filePath', (_e, p: string, id: string) => requireStore().cardFile(p, id))
  ipcMain.handle('map:save', (_e, p: string, map: BoardMap) => requireStore().saveMap(p, map))

  ipcMain.handle('git:cardCommits', async (_e, p: string) => {
    const repo = requireStore().board(p).codeRepo
    if (!repo || !existsSync(repo)) return []
    const cached = commitCache.get(repo)
    if (cached && Date.now() - cached.at < 10_000) return cached.commits
    const commits = await codeCommits(repo).catch(() => [])
    commitCache.set(repo, { at: Date.now(), commits })
    return commits
  })
  ipcMain.handle('git:commitFiles', async (_e, p: string, sha: string) => {
    const repo = requireStore().board(p).codeRepo
    return repo ? commitFiles(repo, sha) : []
  })
  ipcMain.handle('git:commitBoardNow', () => committer?.flush())

  ipcMain.handle('pty:create', (_e, opts: { title: string; boardPath?: string; cwd?: string }) => {
    const s = requireStore()
    const repo = opts.boardPath ? s.board(opts.boardPath).codeRepo : undefined
    const cwd = opts.cwd ?? (repo && existsSync(repo) ? repo : s.root)
    return ptys.create({ title: opts.title, cwd })
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.handle('pty:list', () => ptys.list())

  ipcMain.handle('tackle:start', (_e, req: TackleRequest) => tackle(req, requireStore(), ptys))
  ipcMain.handle('tackle:resume', (_e, p: string, ref: SessionRef) => resume(requireStore(), ptys, p, ref))

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.on('shell:openPath', (_e, target: string) => {
    if (store && path.resolve(target).startsWith(store.root)) void shell.openPath(target)
  })
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
})

let quitting = false
app.on('before-quit', event => {
  if (quitting) return
  // Commit what is pending before the process goes.
  event.preventDefault()
  quitting = true
  ptys.killAll()
  store?.close()
  void (committer?.flush() ?? Promise.resolve()).finally(() => app.quit())
})

app.on('window-all-closed', () => app.quit())
