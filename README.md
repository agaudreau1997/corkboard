# Corkboard

A desktop kanban and mind-map board whose data is a git repo of plain files, built to hand cards to Claude Code.

- **Boards are folders.** Each board is a folder with a `board.json`; a board folder can hold child boards, so boards nest like folders. The side panel shows the tree; every board you open is a tab; `+` (or right-click → *New board inside…*) creates one.
- **Cards are Markdown files** (`cards/<ID>.md`: YAML front matter, then the description), so a move is a one-line diff and a Claude session can move a card by editing `list:`. The app watches the folder, so that move shows up on screen at once.
- **Versioned.** The app commits the board repo itself a few seconds after the last change, with a message that says what moved (`Move RS-886: todo → done`).
- **Synced between machines.** With a remote, the app pulls (fetch + rebase) at start, every minute, when its window gets focus and on *Sync* in the sidebar, and pushes a moment after every commit. A conflict is settled without asking where the answer is clear: a card keeps the side edited last (its `updated` stamp), a map keeps every position from both sides, a `board.json` keeps every list. Anything else (a README both machines edited) stops the sync with the rebase aborted, the repo as it was, and a red line in the sidebar.
- **Per-machine code repo.** `codeRepo` in `board.json` is shared and may be relative to the board repo; board settings also take a *Code repo on this machine*, kept in the app's own config and never synced, for a repo that lives at another path on the other computer.
- **Cards ↔ code.** A board names its code repo (`codeRepo`, inherited by child boards). Commits there that carry a `Card: RS-886` trailer show on the card, on any branch.
- **Three views of the same cards.** *Board* (lists as columns, drag and drop; dragging a card raises a tray at the bottom with *Map only (idea)* and *Archive* drop zones; drag the empty background to pan, with momentum; *+ Add a list* at the end, double-click a list title to rename it, a list over 60 cards shows the first 60 until you ask), *Map* (a free canvas: cards are nodes, `links` are the lines between them; double-click to add an idea that lives only on the map, drag from a card's dot to another card to link them, select a line and press Delete to unlink; positions are kept in `map.json`) and *Table* (sortable, archived cards on request).
- **Tackle with Claude.** From a card: *Tackle locally*, *In a worktree* or *Claude Cloud*. From a list header (*Tackle all*) or a selection (Ctrl/Shift-click cards): one local session for all of them in order, one session per card in parallel (each in its own worktree), or one cloud session. Every session runs in the embedded terminal panel (Ctrl+`), is recorded on its cards (`sessions:`), and can be resumed from the card.

## Right-click menus

- **Card**: open; tackle (locally, in a worktree, in Claude Cloud; or the selection); move to another list or to a list of another board (the card keeps its id, so its commits and links still find it); move to top / bottom; link to a card on any board; copy the id, title, `Card:` trailer, Markdown or file path; select; mark complete; duplicate; open the file; archive.
- **List** (or its `⋯`): add a card; rename; tackle all (one local session, in parallel with a worktree each, one cloud session, or one cloud session per card); select all cards; sort by number, age, last update or title; move left / right; move the list and its cards to another board; collapse; copy as a Markdown checklist; archive its cards; archive the list (restore it in the board settings).
- **Board** (side panel): open in a view, new board inside, settings, a terminal in its code repo, copy its key, delete (empty boards only).

## The tackle buttons

| Button | Runs |
| --- | --- |
| Locally | `claude -n "<ID> <title>" --session-id <uuid> --add-dir <board repo> "<prompt>"` in the board's code repo |
| In a worktree | the same plus `-w card-<id>` (Claude Code makes `.claude/worktrees/card-<id>` on branch `worktree-card-<id>`) |
| Claude Cloud | `claude --cloud "<prompt>"`: a claude.ai/code session on GitHub's copy of the current branch (push first); the URL it prints is saved on the card |

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

Environment seams: `CORKBOARD_ROOT` (board repo), `CORKBOARD_USER_DATA` (profile folder), `CORKBOARD_HIDDEN=1` (an offscreen window: a hidden one stops animating after its first screenshot), `CORKBOARD_COMMIT_DELAY_MS`, `CORKBOARD_SYNC_INTERVAL_MS` (0 = no periodic sync), `CORKBOARD_CLAUDE_BIN`.

## Importing from Trello

`scripts/import-trello.mts` turns the raw JSON the Trello connector returns (one folder per board) into board folders; its `PLAN` maps Trello boards to folders and keys.

```bash
node scripts/import-trello.mts <export dir> <board repo>
```
