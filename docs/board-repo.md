# The board repo

Corkboard keeps no database. A project's boards are a git repo of plain files: folders, JSON and Markdown, which people and Claude sessions read and edit by hand as readily as the app does. The `CLAUDE.md` the app offers a board repo describes the same format for the sessions it starts.

## Layout

```
moon-base/                  the board repo
├── CLAUDE.md               the card format, for Claude sessions and hand edits
├── theme.json              the project's colours (optional)
├── project.json            the project's settings: { "work": true } (optional)
└── game/                   a board
    ├── board.json          its key, title, lists, code repo, flow
    ├── map.json            the map view's positions and backdrops
    ├── cards/
    │   ├── MB-1.md
    │   └── MB-2.md
    └── ideas/              a child board: a sub-folder with its own board.json
        ├── board.json
        └── cards/
```

- **`board.json`**: `key` (the card id prefix, unique in the repo), `title`, `lists` (in order, each `{ id, title }` with an optional `color`, `sort` and `archived`), `codeRepo` (the code repo its cards' commits live in, inherited by child boards), `flow.doing` / `flow.done` (the lists a tackle moves a card to, and the one a session moves it to once it's verified), `promptNotes` (added to every prompt the board sends).
- **`cards/<ID>.md`**: one card per file, YAML front matter, then the description in Markdown:

  ```markdown
  ---
  id: MB-12
  title: Footsteps on the metal floors
  list: next            # a list id; null for an idea that lives only on the map
  pos: 11264            # its order in a list sorted by hand
  created: 2026-09-20T12:28:50.000Z
  updated: 2026-09-28T02:21:47.658Z
  labels: [audio]
  links: [MB-3, IDEA-40]   # related cards on any board: the map's lines
  jira: SPDI-42         # a work project's Jira key
  sessions: [...]       # the Claude sessions started for it
  ---
  The description.
  ```

  The app writes the keys it knows in a fixed order and leaves out empty ones, so a move is a one-line diff and a file edited by hand comes back unchanged. A key it doesn't know is kept as it is. Every change stamps `updated`, which settles a sync conflict (below).
- **`map.json`**: the map view's node positions, list backdrops and filters.
- **`theme.json`**: the project's colours (see [Project colours](using.md#project-colours)).
- **`project.json`**: the project's settings; today only `work` (see [Work mode](work-mode.md)).

## Versioned

The app commits the board repo itself a few seconds after the last change, with a message that says what moved (`Move RS-886: todo → done`). So nobody commits in a board repo by hand, and a Claude session working a card edits its file and leaves the commit to the app.

## Synced between machines

With a remote, the app pulls (fetch + rebase) at start, every minute, when its window gets focus and on *Sync* in the sidebar, and pushes a moment after every commit. A conflict is settled without asking where the answer is clear: a card keeps the side edited last (its `updated` stamp), a map keeps every position from both sides, a `board.json` keeps every list, a `theme.json` keeps this machine's. Anything else (a README both machines edited) stops the sync with the rebase aborted, the repo as it was, and a red line in the sidebar.

## Per-machine code repo

`codeRepo` in `board.json` is shared and may be relative to the board repo; board settings also take a *Code repo on this machine*, kept in the app's own config and never synced, for a repo that lives at another path on the other computer.
