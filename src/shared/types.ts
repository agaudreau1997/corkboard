// The board repo's data model, shared by the main process, the renderer and the importer.
//
// On disk a board is a folder holding `board.json`, a `cards/` folder of one Markdown file per
// card (`cards/<ID>.md`, YAML front matter + a Markdown body) and an optional `map.json` (the
// map view's node positions). Any other sub-folder holding a `board.json` is a child board.

export type ListDef = {
  /** Stable id a card's `list` field names (a slug of the first title). */
  id: string
  title: string
  /** Hidden from the board view; its cards keep their list. */
  archived?: boolean
  /** Its colour; unset, the colour of its place in the board's palette. */
  color?: string
}

export type BoardMeta = {
  /** Card id prefix, unique in the repo: cards of this board are `<key>-<n>`. */
  key: string
  title: string
  lists: ListDef[]
  /** Absolute path of the code repo the cards' commits live in; inherited by child boards. */
  codeRepo?: string
  /** Lists the tackle buttons move cards to; unset means "leave the card where it is". */
  flow?: { doing?: string; done?: string }
  /** Extra instructions appended to every prompt a tackle button sends. */
  promptNotes?: string
  created?: string
  trello?: { url: string; id?: string }
}

export type SessionRef = {
  /** Claude Code session id (a UUID we mint for local runs; cloud runs record the one it prints). */
  id?: string
  kind: 'local' | 'local-worktree' | 'cloud' | 'desktop'
  started: string
  /** Where the session runs, needed to resume it (a worktree has its own folder). */
  cwd?: string
  /** claude.ai/code URL of a cloud session, when it printed one. */
  url?: string
  /** Every card the session was given (a list tackle shares one session). */
  cards?: string[]
  /** The name it was started under (`claude -n`), shown on the card. */
  name?: string
  /** The Claude desktop app's own id for the session (`local_…`), once found in its index. */
  desktopId?: string
  /** A discussion (talk the card through, no implementing) rather than a tackle. */
  purpose?: 'discuss'
}

export type Card = {
  id: string
  title: string
  /** A list id of the board, or null for a card that only lives on the map (an idea). */
  list: string | null
  /** Order inside its list, smaller first. */
  pos: number
  created?: string
  updated?: string
  due?: string
  complete?: boolean
  archived?: boolean
  labels: string[]
  /** Ids of related cards (any board): the map view's edges. */
  links: string[]
  trello?: string
  sessions: SessionRef[]
  /** Markdown body: the description. */
  body: string
  /** Front-matter keys this app does not know, kept verbatim on write. */
  extra: Record<string, unknown>
}

export type MapNodePos = { x: number; y: number }

/** A list's backdrop on the map: its cards sit on it; dropping a card on it moves it there. */
export type MapArea = { x: number; y: number; w: number; h: number }

export type BoardMap = {
  nodes: Record<string, MapNodePos>
  /** Backdrops by list id. */
  areas?: Record<string, MapArea>
  /** List ids whose cards the map leaves out. */
  hiddenLists?: string[]
  /** Show cards with no list ("ideas"). Default true. */
  showUnlisted?: boolean
}

/** One node of the sidebar's tree. `path` is relative to the board root, '/'-separated. */
export type BoardNode = {
  path: string
  title: string
  key: string
  listCount: number
  cardCount: number
  /** Its lists (archived ones included), for "move to" menus. */
  lists: ListDef[]
  children: BoardNode[]
}

export type LoadedBoard = {
  path: string
  meta: BoardMeta
  /** codeRepo after this machine's override and inheritance from parent boards, absolute. */
  codeRepo?: string
  /** True when codeRepo is this machine's own setting rather than board.json's. */
  codeRepoLocal?: boolean
  cards: Card[]
  map: BoardMap
}

export type CodeCommit = {
  sha: string
  short: string
  author: string
  date: string
  subject: string
  /** Card ids from the commit's `Card:` trailers. */
  cards: string[]
}

export type CardPatch = Partial<Omit<Card, 'id' | 'extra'>>

export type BoardDelta = {
  path: string
  /** Cards whose file changed (or appeared), parsed fresh. */
  cards: Card[]
  /** Ids whose file went away. */
  removed: string[]
  meta?: BoardMeta
  map?: BoardMap
}

export type TackleMode = 'desktop' | 'local' | 'local-worktree' | 'cloud'

export type TackleRequest = {
  boardPath: string
  cardIds: string[]
  mode: TackleMode
  /** For several cards: one session for all, or one per card. */
  split?: 'together' | 'each'
  /** Title of the list, when the cards are a whole list. */
  listTitle?: string
  /** Title of the board, when the cards are a whole board. */
  boardTitle?: string
  /** Talk the cards through (no implementing, the cards stay put) instead of working on them. */
  purpose?: 'tackle' | 'discuss'
}

export type PtyInfo = { id: string; title: string; cwd: string; cardIds?: string[] }

/**
 * What runs in a terminal tab, from the title Claude Code sets: `working` while it works,
 * `waiting` when it is at its prompt or asking something (your turn), `shell` with no Claude
 * in front (or one that sets no title).
 */
export type TerminalStatus = 'shell' | 'working' | 'waiting'

/** One board repo the app shows, as this machine knows it (app config, never synced). */
export type ProjectConfig = {
  id: string
  name: string
  /** The board repo's folder. */
  boardRoot: string
  /** The code folder on this machine its boards' sessions start in, unless a board names its own. */
  codeRepo?: string
}

export type AppConfig = {
  projects: ProjectConfig[]
  /** This machine's code repo for a board (by board key), overriding board.json's codeRepo. */
  codeRepos?: Record<string, string>
  /** Before projects: the one board repo. Read once, as the first project. */
  boardRoot?: string
}

/** A project in the side panel: its boards' paths are board keys (`<project id>:<path>`). */
export type ProjectNode = {
  id: string
  name: string
  root: string
  codeRepo?: string
  sync: SyncStatus
  /** Whether the repo has its CLAUDE.md (the card format, for sessions and hand edits). */
  guide: boolean
  boards: BoardNode[]
}

export type SyncStatus = {
  state: 'idle' | 'local' | 'syncing' | 'synced' | 'offline' | 'conflict'
  /** When the last sync went through. */
  at?: number
  message?: string
  /** Commits the last sync brought in and sent out. */
  pulled?: number
  pushed?: number
}

export type ClaudeInfo = { version?: string; path?: string; error?: string }
