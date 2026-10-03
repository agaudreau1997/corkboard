# Corkboard

A desktop kanban and mind-map board whose data is a git repo of plain files, built to hand cards to Claude Code.

- **Projects.** The side panel's top level is projects: each is one board repo, with its own sync and a code folder on this machine (*Settings…* in its menu) that its boards' sessions start in unless a board names its own. *+ Add project* takes an existing board repo (a clone of it) or an empty or new folder, which becomes a git repo. Removing a project only takes it off the list. A board moves to another project with its child boards and card ids (*Move to project* in its menu, refused when a key is taken there).
- **Boards are folders.** Each board is a folder with a `board.json`; a board folder can hold child boards, so boards nest like folders. Every board you open is a tab; `+` (or right-click → *New board inside…*) creates one. *Delete board…* removes an empty board at once and one with cards (and child boards) once its name is typed; all of it stays in the repo's git history.
- **Cards are Markdown files** (`cards/<ID>.md`: YAML front matter, then the description), so a move is a one-line diff and a Claude session can move a card by editing `list:`. The app watches the folder, so that move shows up on screen at once.
- **Versioned.** The app commits the board repo itself a few seconds after the last change, with a message that says what moved (`Move RS-886: todo → done`).
- **Synced between machines.** With a remote, the app pulls (fetch + rebase) at start, every minute, when its window gets focus and on *Sync* in the sidebar, and pushes a moment after every commit. A conflict is settled without asking where the answer is clear: a card keeps the side edited last (its `updated` stamp), a map keeps every position from both sides, a `board.json` keeps every list. Anything else (a README both machines edited) stops the sync with the rebase aborted, the repo as it was, and a red line in the sidebar.
- **Per-machine code repo.** `codeRepo` in `board.json` is shared and may be relative to the board repo; board settings also take a *Code repo on this machine*, kept in the app's own config and never synced, for a repo that lives at another path on the other computer.
- **Cards ↔ code.** A board names its code repo (`codeRepo`, inherited by child boards). Commits there that carry a `Card: RS-886` trailer show on the card, on any branch.
- **Three views of the same cards.** *Board* (lists as columns, drag and drop; dragging a card raises a tray at the bottom with *Map only (idea)* and *Archive* drop zones; drag the empty background to pan, with momentum; *+ Add a list* at the end, drag a list by its header to reorder the lists (each keeps its colour), double-click a list title to rename it, a list over 60 cards shows the first 60 until you ask), *Map* (a free canvas: cards are nodes, `links` are the lines between them. Every list has a backdrop its cards sit on, dragged by its header (its cards come along) and resized from its corners; dropping a card on another list's backdrop moves it to that list; right-click a backdrop for *Automatically lay out* (its cards in columns inside it), *Fit to its cards*, *Add a card here*. Double-click opens a title input for a new card (in the backdrop under it, else an idea with no list); dragging a card's dot onto another card links them, onto empty space opens the input for a new card linked from it; Escape or an empty title adds nothing. Positions and backdrops are kept in `map.json`) and *Table* (sortable, archived cards on request).
- **Tackle with Claude.** From a card: *Tackle locally*, *In a worktree* or *Claude Cloud*. From a list header (*Tackle all*) or a selection (Ctrl/Shift-click cards): one local session for all of them in order, one session per card in parallel (each in its own worktree), or one cloud session. Every session runs in the embedded terminal panel (Ctrl+`), is recorded on its cards (`sessions:`), and can be resumed from the card; the card face shows a ▶ badge for them until the card is done (in the board's done list, or marked complete), the drawer keeps them after.

## Right-click menus

- **Card**: open; tackle (locally, in a worktree, in Claude Cloud; or the selection); move to another list or to a list of another board (the card keeps its id, so its commits and links still find it); move to top / bottom; link to a card on any board; copy the id, title, `Card:` trailer, Markdown or file path; select; mark complete; duplicate; open the file; archive.
- **List** (or its `⋯`): add a card; rename; tackle all (one local session, in parallel with a worktree each, one cloud session, or one cloud session per card); select all cards; sort by number, age, last update or title; move left / right; move the list and its cards to another board; collapse; copy as a Markdown checklist; archive its cards; archive the list (restore it in the board settings).
- **Board** (side panel): open in a view, new board inside, settings, a terminal in its code repo, copy its key, delete (empty boards only).

## The tackle buttons

| Button | Runs |
| --- | --- |
| Claude desktop | opens `claude://code/new?q=<prompt>&folder=<code repo>&folder=<board repo>`: a new Code session in the Claude desktop app, the prompt filled in (a prompt over 14,000 characters goes in a temporary file the link points to) |
| Terminal | `claude --add-dir <board repo> -n "<ID> <title>" --session-id <uuid> "<prompt>"` in the board's code repo (`--add-dir` first: it takes every folder up to the next option, and placed last it swallowed the prompt) |
| In a worktree | the same plus `-w card-<id>` (Claude Code makes `.claude/worktrees/card-<id>` on branch `worktree-card-<id>`) |
| Claude Cloud | `claude --cloud "<prompt>"`: a claude.ai/code session on GitHub's copy of the current branch (push first); the URL it prints is saved on the card |

**The desktop app's links** are not a documented API; they were read from the app (2.19675): `claude://code/new?q=&folder=` (repeatable folder), `claude://code/continue?session=local_<id>` (one of its sessions) and `claude://resume?session=<uuid>` (imports a CLI session). After a desktop tackle the app watches the desktop app's own session index (`~/.config/Claude/claude-code-sessions/**/local_*.json`: its id, the CLI session id, the folder, the start time) for a session in the code repo whose transcript starts with the prompt, for up to 30 minutes, and puts both ids on the card: its *Open* button reopens it in the desktop app. A terminal session's *Desktop* button imports it into the desktop app. If an app update moves these, a desktop tackle still opens the session; only the link back to the card is lost.

The prompt carries the card's title, description and linked cards, the path of its file, and the rules: put a `Card: <ID>` trailer on every commit, move the card to the board's done list when it is verified (`flow.done` in the board settings; nothing is said when it is unset), and never commit in the board repo. Board settings also hold *Prompt notes*, appended to every prompt, and the list a tackled card moves to (`flow.doing`).

## Claude Code

The app runs whatever `claude` your login shell finds, the same one your own terminal uses; the sidebar shows its version, and *Update* runs `claude update` in a terminal tab. It does not pin its own copy: a second Claude Code inside the app would update separately from the one you use in a terminal, and Claude Code already keeps itself current.

## Running

```bash
npm install
npm run dev        # development, with hot reload
npm run build && npm start
```

The first launch opens `~/Documents/Godot/Projects/deus-board` if it exists, or asks for the board repo folder (the sidebar's footer changes it later).

To start it from the desktop menu (and get its icon on the taskbar, which a Wayland session takes from the menu entry): `npm run install-launcher` (`bash scripts/install-launcher.sh --remove` takes it out). The icon is `build/icon.svg`, drawn by `scripts/make-icon.py` (`npm run icon` re-renders the PNGs with Inkscape).

**Windows.** The terminals run PowerShell there (`pwsh` when installed: Windows PowerShell 5.1 drops the double quotes inside an argument it passes to a program, and prompts have quotes), with the command handed over as JSON in an environment variable rather than pasted into a command line. That path is written but not yet run on Windows.

## Tests

```bash
npm test           # unit tests: card files, the store and its watch, git, sync between two clones, prompts
npm run e2e        # builds, then drives the real app on a scratch clone of the board repo
```

The end-to-end test (`tests/e2e/smoke.mjs`) clones a board repo to a temporary folder, points the app at it with a hidden window, and replaces `claude` with a stand-in that records its arguments (`CORKBOARD_CLAUDE_BIN`), so nothing real is started or billed. Screenshots go to `test-results/` (`SHOT_DIR` to change).

The test clones the board repo into a scratch bare remote and works on a clone of that, so the app's sync pushes there, never to the real remote; a second clone plays the other machine.

The test starts from the board repo's first commit (the Trello import), so what the boards hold today never changes what it checks, and it never opens the real board repo: `CORKBOARD_ROOT` is its only project. The app's own output is saved as `main-process.log` beside the screenshots.

Environment seams: `CORKBOARD_ROOT` (a test's only project), `CORKBOARD_USER_DATA` (profile folder), `CORKBOARD_PICK_FOLDER` (what the folder picker answers), `CORKBOARD_HIDDEN=1` (an offscreen window: a hidden one stops animating after its first screenshot), `CORKBOARD_COMMIT_DELAY_MS`, `CORKBOARD_SYNC_INTERVAL_MS` (0 = no periodic sync), `CORKBOARD_CLAUDE_BIN`.

## Importing from Trello

`scripts/import-trello.mts` turns the raw JSON the Trello connector returns (one folder per board) into board folders; its `PLAN` maps Trello boards to folders and keys.

```bash
node scripts/import-trello.mts <export dir> <board repo>
```
