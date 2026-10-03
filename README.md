# Corkboard

A desktop kanban and mind-map board whose data is a git repo of plain files, built to hand cards to Claude Code.

- **Boards are folders.** Each board is a folder with a `board.json`; a board folder can hold child boards, so boards nest like folders. The side panel shows the tree; every board you open is a tab; `+` (or right-click → *New board inside…*) creates one.
- **Cards are Markdown files** (`cards/<ID>.md`: YAML front matter, then the description), so a move is a one-line diff and a Claude session can move a card by editing `list:`. The app watches the folder, so that move shows up on screen at once.
- **Versioned.** The app commits the board repo itself a few seconds after the last change, with a message that says what moved (`Move RS-886: todo → done`).
- **Cards ↔ code.** A board names its code repo (`codeRepo`, inherited by child boards). Commits there that carry a `Card: RS-886` trailer show on the card, on any branch.
- **Three views of the same cards.** *Board* (lists as columns, drag and drop; a list over 60 cards shows the first 60 until you ask), *Map* (a free canvas: cards are nodes, `links` are the lines between them; double-click to add an idea that lives only on the map, drag from a card's dot to another card to link them, select a line and press Delete to unlink; positions are kept in `map.json`) and *Table* (sortable, archived cards on request).
- **Tackle with Claude.** From a card: *Tackle locally*, *In a worktree* or *Claude Cloud*. From a list header (*Tackle all*) or a selection (Ctrl/Shift-click cards): one local session for all of them in order, one session per card in parallel (each in its own worktree), or one cloud session. Every session runs in the embedded terminal panel (Ctrl+`), is recorded on its cards (`sessions:`), and can be resumed from the card.

## The tackle buttons

| Button | Runs |
| --- | --- |
| Locally | `claude -n "<ID> <title>" --session-id <uuid> --add-dir <board repo> "<prompt>"` in the board's code repo |
| In a worktree | the same plus `-w card-<id>` (Claude Code makes `.claude/worktrees/card-<id>` on branch `worktree-card-<id>`) |
| Claude Cloud | `claude --cloud "<prompt>"`: a claude.ai/code session on GitHub's copy of the current branch (push first); the URL it prints is saved on the card |

The prompt carries the card's title, description and linked cards, the path of its file, and the rules: put a `Card: <ID>` trailer on every commit, move the card to the board's done list when it is verified (`flow.done` in the board settings; nothing is said when it is unset), and never commit in the board repo. Board settings also hold *Prompt notes*, appended to every prompt, and the list a tackled card moves to (`flow.doing`).

## Running

```bash
npm install
npm run dev        # development, with hot reload
npm run build && npm start
```

The first launch opens `~/Documents/Godot/Projects/deus-board` if it exists, or asks for the board repo folder (the sidebar's footer changes it later).

## Tests

```bash
npm test           # unit tests: card files, the store and its watch, git, prompts
npm run e2e        # builds, then drives the real app on a scratch clone of the board repo
```

The end-to-end test (`tests/e2e/smoke.mjs`) clones a board repo to a temporary folder, points the app at it with a hidden window, and replaces `claude` with a stand-in that records its arguments (`CORKBOARD_CLAUDE_BIN`), so nothing real is started or billed. Screenshots go to `test-results/` (`SHOT_DIR` to change).

Environment seams: `CORKBOARD_ROOT` (board repo), `CORKBOARD_USER_DATA` (profile folder), `CORKBOARD_HIDDEN=1`, `CORKBOARD_COMMIT_DELAY_MS`, `CORKBOARD_CLAUDE_BIN`.

## Importing from Trello

`scripts/import-trello.mts` turns the raw JSON the Trello connector returns (one folder per board) into board folders; its `PLAN` maps Trello boards to folders and keys.

```bash
node scripts/import-trello.mts <export dir> <board repo>
```
