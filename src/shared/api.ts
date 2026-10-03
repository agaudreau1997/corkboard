// The bridge the preload script exposes as `window.corkboard`.

import type {
  AppConfig,
  BoardDelta,
  BoardMap,
  BoardMeta,
  BoardNode,
  Card,
  CardPatch,
  ClaudeInfo,
  CodeCommit,
  LoadedBoard,
  PtyInfo,
  SessionRef,
  SyncStatus,
  TackleRequest,
} from './types'

export type CorkboardApi = {
  config: {
    get(): Promise<AppConfig | null>
    pickRoot(): Promise<AppConfig | null>
    /** This machine's code repo for a board (null clears it); answers the board as it now resolves. */
    setCodeRepo(boardPath: string, repo: string | null): Promise<LoadedBoard>
    pickFolder(title: string): Promise<string | null>
  }
  boards: {
    tree(): Promise<BoardNode[]>
    load(path: string): Promise<LoadedBoard>
    create(parent: string, title: string, key?: string): Promise<string>
    updateMeta(path: string, patch: Partial<BoardMeta>): Promise<BoardMeta>
    remove(path: string): Promise<void>
    /** Every card id in the repo with its title and board, for link pickers. */
    index(): Promise<{ id: string; title: string; boardPath: string; boardTitle: string }[]>
  }
  cards: {
    create(
      boardPath: string,
      fields: { title: string; list: string | null; pos?: number; body?: string; links?: string[] },
    ): Promise<Card>
    update(boardPath: string, id: string, patch: CardPatch): Promise<Card>
    updateMany(boardPath: string, patches: { id: string; patch: CardPatch }[]): Promise<Card[]>
    /** To another list of the same board, or to another board (the id stays). */
    move(fromPath: string, id: string, toPath: string, list: string | null, pos?: number): Promise<Card>
    duplicate(boardPath: string, id: string): Promise<Card>
    filePath(boardPath: string, id: string): Promise<string>
  }
  lists: {
    /** Moves a list and its cards to the end of another board; answers the list's id there. */
    move(fromPath: string, listId: string, toPath: string): Promise<string>
  }
  sync: {
    now(): Promise<SyncStatus>
    status(): Promise<SyncStatus>
  }
  claude: {
    info(): Promise<ClaudeInfo>
    /** Runs `claude update` in a terminal tab. */
    update(boardPath?: string): Promise<PtyInfo>
    /** Whether claude:// links open the Claude desktop app here. */
    desktopAvailable(): Promise<boolean>
  }
  clipboard: {
    write(text: string): void
  }
  map: {
    save(boardPath: string, map: BoardMap): Promise<void>
  }
  git: {
    cardCommits(boardPath: string): Promise<CodeCommit[]>
    commitFiles(boardPath: string, sha: string): Promise<{ status: string; file: string }[]>
    commitBoardNow(): Promise<string | undefined>
  }
  pty: {
    create(opts: { title: string; boardPath?: string; cwd?: string }): Promise<PtyInfo>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    list(): Promise<PtyInfo[]>
  }
  tackle: {
    start(req: TackleRequest): Promise<PtyInfo[]>
    /** Opens a recorded session again; null when the desktop app took it. */
    resume(boardPath: string, ref: SessionRef): Promise<PtyInfo | null>
    /** Opens a terminal session in the Claude desktop app. */
    openInDesktop(ref: SessionRef): Promise<void>
  }
  shell: {
    openExternal(url: string): void
    openPath(path: string): void
  }
  on: {
    delta(cb: (delta: BoardDelta) => void): () => void
    treeChanged(cb: () => void): () => void
    boardCommitted(cb: (summary: string) => void): () => void
    syncStatus(cb: (status: SyncStatus) => void): () => void
    ptyCreated(cb: (info: PtyInfo) => void): () => void
    ptyData(cb: (id: string, data: string) => void): () => void
    ptyExit(cb: (id: string, code: number) => void): () => void
  }
}
