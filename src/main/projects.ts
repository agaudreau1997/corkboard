// A project is one board repo: its own store (and watch), auto-committer and sync. The renderer
// names a board `<project id>:<path in the repo>`, a key this module translates both ways.

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { BOARD_GUIDE_FILE, boardGuide } from '@shared/boardguide'
import { slugify } from '@shared/cardfile'
import { mainBoardOf, patchSettings } from '@shared/project'
import type {
  BoardDelta,
  BoardNode,
  LoadedBoard,
  ProjectConfig,
  ProjectNode,
  SyncStatus,
} from '@shared/types'
import { AutoCommitter, git, isRepo } from './git'
import { BoardStore } from './store'
import { BoardSync } from './sync'

export type ProjectEvents = {
  delta: (delta: BoardDelta) => void
  treeChanged: () => void
  committed: (projectId: string, summary: string) => void
  syncStatus: (projectId: string, status: SyncStatus) => void
}

export function boardKey(projectId: string, rel: string): string {
  return `${projectId}:${rel}`
}

export function splitKey(key: string): { projectId: string; rel: string } {
  const i = key.indexOf(':')
  if (i < 0) throw new Error(`Not a board key: ${key}`)
  return { projectId: key.slice(0, i), rel: key.slice(i + 1) }
}

export class Project {
  readonly id: string
  name: string
  readonly root: string
  codeRepo?: string
  readonly store: BoardStore
  readonly committer: AutoCommitter
  readonly sync: BoardSync

  constructor(
    config: ProjectConfig,
    localRepos: Record<string, string>,
    private events: ProjectEvents,
    timing: { commitDelayMs: number; syncIntervalMs: number },
  ) {
    this.id = config.id
    this.name = config.name
    this.root = path.resolve(config.boardRoot)
    this.codeRepo = config.codeRepo
    this.store = new BoardStore(this.root, localRepos, config.codeRepo)
    this.committer = new AutoCommitter(this.root, timing.commitDelayMs, summary => {
      events.committed(this.id, summary)
      this.sync.schedulePush()
    })
    this.sync = new BoardSync(this.root, this.committer, status => events.syncStatus(this.id, status), timing.syncIntervalMs)
  }

  async open(): Promise<void> {
    await this.store.init()
    this.store.watch({
      onDelta: delta => {
        this.events.delta(this.keyedDelta(delta))
        this.committer.touch()
      },
      onTreeChanged: () => {
        this.events.treeChanged()
        this.committer.touch()
      },
    })
    this.sync.start()
  }

  async close(): Promise<void> {
    this.store.close()
    this.sync.stop()
    await this.committer.flush()
  }

  key(rel: string): string {
    return boardKey(this.id, rel)
  }

  node(): ProjectNode {
    const rekey = (nodes: BoardNode[]): BoardNode[] =>
      nodes.map(n => ({ ...n, path: this.key(n.path), children: rekey(n.children) }))
    const tree = this.store.tree()
    const main = mainBoardOf(this.store.settings, tree)
    return {
      id: this.id,
      name: this.name,
      root: this.root,
      codeRepo: this.codeRepo,
      sync: this.sync.status,
      ...(this.store.theme ? { theme: this.store.theme } : {}),
      guide: this.hasGuide(),
      work: !!this.store.settings.work,
      ...(this.store.settings.icon ? { icon: this.store.settings.icon } : {}),
      ...(main !== undefined ? { mainBoard: this.key(main) } : {}),
      boards: rekey(tree),
    }
  }

  /** The folder of its main board (see `mainBoardOf`); undefined in a repo with no board. */
  mainBoard(): string | undefined {
    return mainBoardOf(this.store.settings, this.store.tree())
  }

  /**
   * Refuses to take the main board away (a delete, a move to another project): a project is
   * always opened at its main board, so another has to be picked first.
   */
  keepMainBoard(rel: string, doing: string): void {
    if (rel !== this.mainBoard()) return
    const title = this.store.board(rel).meta.title
    throw new Error(`“${title}” is ${this.name}'s main board, so it can't be ${doing}: pick another main board in its Project settings first.`)
  }

  /**
   * Makes the main board of a project that has none, as *New board…* makes a board (the default
   * lists), and names it in `project.json`: a project has no purpose without one.
   */
  async makeMainBoard(title: string, key?: string): Promise<string> {
    const rel = await this.store.createBoard('', title, key)
    await this.store.saveSettings(patchSettings(this.store.settings, { board: rel }))
    return rel
  }

  board(rel: string): LoadedBoard {
    return { ...this.store.board(rel), path: this.key(rel) }
  }

  keyedDelta(delta: BoardDelta): BoardDelta {
    return { ...delta, path: this.key(delta.path) }
  }

  /** Whether the repo has the CLAUDE.md the prompts point sessions to. */
  hasGuide(): boolean {
    return existsSync(path.join(this.root, BOARD_GUIDE_FILE))
  }

  /** Adds the board guide when it is missing (never over one written by hand). */
  async addGuide(): Promise<void> {
    if (this.hasGuide()) return
    await writeGuide(this.root, { work: !!this.store.settings.work })
    // The watch reports board files only: the commit has to be asked for.
    this.committer.touch()
  }

  setCodeRepo(codeRepo: string | undefined, localRepos: Record<string, string>): void {
    this.codeRepo = codeRepo
    this.store.setLocalRepos(localRepos, codeRepo)
  }
}

/**
 * A folder for a new project's board repo: made if missing, and a git repo afterwards (an empty
 * folder is initialised, with a README and the board guide; an existing repo is used as it is).
 */
export async function prepareBoardRepo(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  if (await isRepo(root)) return
  await git(root, ['init', '-q'])
  const readme = path.join(root, 'README.md')
  if (!existsSync(readme)) {
    await fs.writeFile(readme, `# ${path.basename(root)}\n\nTask boards, opened with Corkboard.\n`)
  }
  if (!existsSync(path.join(root, BOARD_GUIDE_FILE))) await writeGuide(root)
}

async function writeGuide(root: string, opts: { work?: boolean } = {}): Promise<void> {
  await fs.writeFile(path.join(root, BOARD_GUIDE_FILE), boardGuide(path.basename(root), opts))
}

/**
 * Whether a folder holds a board anywhere below it (a `board.json`), for *Add project* to ask for
 * the main board of one that has none. A folder that isn't there has none.
 */
export async function hasBoards(root: string, depth = 4): Promise<boolean> {
  if (existsSync(path.join(root, 'board.json'))) return true
  if (depth === 0) return false
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'cards') continue
    if (await hasBoards(path.join(root, entry.name), depth - 1)) return true
  }
  return false
}

export function projectId(name: string, taken: Set<string>): string {
  const base = slugify(name) || 'project'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}
