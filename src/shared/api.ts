// The bridge the preload script exposes as `window.corkboard`.

import type {
  AppConfig,
  BoardDelta,
  BoardMap,
  BoardMeta,
  BoardNode,
  Card,
  CardPatch,
  CodeCommit,
  LoadedBoard,
  PtyInfo,
  SessionRef,
  TackleRequest,
} from './types'

export type CorkboardApi = {
  config: {
    get(): Promise<AppConfig | null>
    pickRoot(): Promise<AppConfig | null>
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
    filePath(boardPath: string, id: string): Promise<string>
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
    resume(boardPath: string, ref: SessionRef): Promise<PtyInfo>
  }
  shell: {
    openExternal(url: string): void
    openPath(path: string): void
  }
  on: {
    delta(cb: (delta: BoardDelta) => void): () => void
    treeChanged(cb: () => void): () => void
    boardCommitted(cb: (summary: string) => void): () => void
    ptyCreated(cb: (info: PtyInfo) => void): () => void
    ptyData(cb: (id: string, data: string) => void): () => void
    ptyExit(cb: (id: string, code: number) => void): () => void
  }
}
