// A project is one board repo: its own store (and watch), auto-committer and sync. The renderer
// names a board `<project id>:<path in the repo>`, a key this module translates both ways.

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { slugify } from '@shared/cardfile'
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
    return {
      id: this.id,
      name: this.name,
      root: this.root,
      codeRepo: this.codeRepo,
      sync: this.sync.status,
      ...(this.store.theme ? { theme: this.store.theme } : {}),
      boards: rekey(this.store.tree()),
    }
  }

  board(rel: string): LoadedBoard {
    return { ...this.store.board(rel), path: this.key(rel) }
  }

  keyedDelta(delta: BoardDelta): BoardDelta {
    return { ...delta, path: this.key(delta.path) }
  }

  setCodeRepo(codeRepo: string | undefined, localRepos: Record<string, string>): void {
    this.codeRepo = codeRepo
    this.store.setLocalRepos(localRepos, codeRepo)
  }
}

/**
 * A folder for a new project's board repo: made if missing, and a git repo afterwards (an empty
 * folder is initialised; an existing repo is used as it is).
 */
export async function prepareBoardRepo(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  if (await isRepo(root)) return
  await git(root, ['init', '-q'])
  const readme = path.join(root, 'README.md')
  if (!existsSync(readme)) {
    await fs.writeFile(readme, `# ${path.basename(root)}\n\nTask boards, opened with Corkboard.\n`)
  }
}

export function projectId(name: string, taken: Set<string>): string {
  const base = slugify(name) || 'project'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}
