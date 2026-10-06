# Corkboard

A desktop kanban and mind-map board whose data is a git repo of plain files, built to hand cards to Claude Code.

- **Projects.** The side panel's top level is projects: each is one board repo, with its own sync and a code folder on this machine (*Settings…* in its menu) that its boards' sessions start in unless a board names its own. *+ Add project* takes an existing board repo (a clone of it) or an empty or new folder, which becomes a git repo with a README and a `CLAUDE.md` describing the card format (for Claude sessions and anyone editing cards by hand). A board repo without a `CLAUDE.md` gets an offer of one under its boards, never the file unasked; after *No thanks* the project's menu still has *Add a CLAUDE.md*. Removing a project only takes it off the list. A board moves to another project with its child boards and card ids (*Move to project* in its menu, refused when a key is taken there).
- **Project colours.** A project can wear colours of its own, so a glance at the window says which one is in front. *Settings…* in its menu (or *Project colours…* in a board's settings) offers themes to start from (*Cork*, the icon's; *Moss*, *Tide*, *Plum*, *Ember*; *Paper*, a light one) and a picker per colour (background, cards, text, borders, accent, links, success, danger); the window shows them as you pick, and the side panel and the tabs carry each themed project's swatch. They live in `theme.json` at the root of the board repo, so every machine shows them, and an edit there, by hand or by a Claude session, shows at once. A colour left unset is mixed from the others; `"tokens": { "--panel": "#16161d" }` pins any of the stylesheet's shades exactly, to match a design system.
- **Boards are folders.** Each board is a folder with a `board.json`; a board folder can hold child boards, so boards nest like folders. Every board you open is a tab; `+` (or right-click → *New board inside…*) creates one. *Delete board…* removes an empty board (archived cards don't count) at once and one with cards (and child boards) once its name is typed; all of it stays in the repo's git history.
- **Cards are Markdown files** (`cards/<ID>.md`: YAML front matter, then the description), so a move is a one-line diff and a Claude session can move a card by editing `list:`. The app watches the folder, so that move shows up on screen at once.
- **Versioned.** The app commits the board repo itself a few seconds after the last change, with a message that says what moved (`Move RS-886: todo → done`).
- **Synced between machines.** With a remote, the app pulls (fetch + rebase) at start, every minute, when its window gets focus and on *Sync* in the sidebar, and pushes a moment after every commit. A conflict is settled without asking where the answer is clear: a card keeps the side edited last (its `updated` stamp), a map keeps every position from both sides, a `board.json` keeps every list, a `theme.json` keeps this machine's. Anything else (a README both machines edited) stops the sync with the rebase aborted, the repo as it was, and a red line in the sidebar.
- **Per-machine code repo.** `codeRepo` in `board.json` is shared and may be relative to the board repo; board settings also take a *Code repo on this machine*, kept in the app's own config and never synced, for a repo that lives at another path on the other computer.
- **Cards ↔ code.** A board names its code repo (`codeRepo`, inherited by child boards). Commits there that carry a `Card: RS-886` trailer show on the card, on any branch. Click one in the drawer for the files it touched; *Copy* (on hover) or its right-click menu copies its SHA.
- **Three views of the same cards.** *Board* (lists as columns, drag and drop; dragging a card raises a tray at the bottom with *Map only (idea)* and *Archive* drop zones; drag the empty background to pan, with momentum; *+ Add a list* at the end, drag a list by its header to reorder the lists (each keeps its colour), double-click a list title to rename it, a list over 60 cards shows the first 60 until you ask), *Map* (a free canvas: cards are nodes, `links` are the lines between them. Every list has a backdrop its cards sit on, dragged by its header (its cards come along) and resized from its corners; dropping a card on another list's backdrop moves it to that list; right-click a backdrop for *Automatically lay out* (its cards in columns inside it), *Fit to its cards*, *Add a card here*. Double-click opens a title input for a new card (in the backdrop under it, else an idea with no list); dragging a card's dot onto another card links them, onto empty space opens the input for a new card linked from it; Escape or an empty title adds nothing. Positions and backdrops are kept in `map.json`) and *Table* (sortable, archived cards on request).
- **Tackle with Claude.** From a card: *Tackle locally*, *In a worktree* or *Claude Cloud*. From a list header (*Tackle all*) or a selection (Ctrl/Shift-click cards): one local session for all of them in order, one session per card in parallel (each in its own worktree), or one cloud session. Every session runs in the embedded terminal panel (Ctrl+`), is recorded on its cards (`sessions:`), and can be resumed from the card; the card face shows a ▶ badge for them until the card is done (in the board's done list, or marked complete), the drawer keeps them after.

- **Terminal tabs show what Claude is doing.** Each tab's icon: a spinner while Claude works, a green dot when it's your turn (Claude at its prompt or asking something), `❯` for a plain shell, a square once the shell ended (red for a failure). A turn that ends in a tab you aren't looking at pulses and bolds the tab, and a count by *Terminals* jumps to it. The app reads this from the terminal title Claude Code sets (`◐`/`◑` while it works, `✳` when it stops, cleared on exit; read from 2.1.289), so a `claude` typed in a shell tab shows too; with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` set the tab stays a shell. A middle click on a tab closes it, like `×`; either asks first while Claude is working in it or a command runs in its foreground (a dev server, an editor: on Linux and macOS), not when it sits at a prompt.

- **Discuss before tackling.** *Discuss* on a card (its drawer, or its menu) and *Discuss / triage* on a list or a selection open one conversation, in Claude desktop or a terminal, that may not implement anything: no code changes, no new files, no commits in the code repo unless you ask in it. Claude reads the cards and the code and talks them through (what's unclear, risks, scope, splitting; for a list: still relevant, ready, to split, merge, move or archive), and once you agree it writes the outcome into the card files themselves, which is how a card gets its details before it's tackled. A discussion leaves the cards in their lists and shows as ✎ on the card.

## Right-click menus

- **Card**: open; tackle (in Claude desktop, a terminal, a worktree, Claude Cloud; or the selection); discuss; move to another list or to a list of another board (the card keeps its id, so its commits and links still find it); move to top / bottom; link to a card on any board; copy the id, title, `Card:` trailer, Markdown, file path, or the tackle or discuss prompt (to paste into a Claude session of your own); select; mark complete; duplicate; open the file; archive.
- **List** (or its `⋯`): add a card; rename; tackle all (Claude desktop together or one per card, a terminal session, terminals in parallel with a worktree each, one cloud session, or one per card); discuss / triage; select all cards; *Sort cards by* last update (a card that changes or lands in the list goes to the top; the default for the board's done list), age, number or title, kept in `board.json` and applied as cards change, or *Manual* for drag-and-drop order (the default for every other list); move left / right; move the list and its cards to another board; collapse; copy as a Markdown checklist; archive its cards; archive the list (restore it in the board settings).
- **Board** (side panel): open in a view, new board inside, settings, a terminal in its code repo, copy its key, delete (empty boards only).

## The tackle buttons

| Button | Runs |
| --- | --- |
| Claude desktop | opens `claude://code/new?q=<prompt>&folder=<code repo>`: a new Code session in the Claude desktop app, in the code repo once you trust it (the app asks each time), the prompt filled in (a prompt over 14,000 characters goes in a temporary file the link points to). The link can't pick a branch, and a draft sent with its branch blank starts with no folder: pick the branch before sending. The prompt names the code repo, and a session that started anywhere else moves itself there with the desktop app's `change_directory` tool (you approve the folder), or stops and says so |
| Terminal | `claude --add-dir <board repo> -n "<ID> <title>" --session-id <uuid> "<prompt>"` in the board's code repo (`--add-dir` first: it takes every folder up to the next option, and placed last it swallowed the prompt) |
| In a worktree | the same plus `-w card-<id>` (Claude Code makes `.claude/worktrees/card-<id>` on branch `worktree-card-<id>`) |
| Claude Cloud | `claude --cloud "<prompt>"`: a claude.ai/code session on GitHub's copy of the current branch (push first); the URL it prints is saved on the card |

**The desktop app's links** were read from the app (2.19675): `claude://code/new?q=&folder=` (one folder: given two, the app ignores both and opens the last folder it used; no branch, which Anthropic's page on the link confirms: it takes `q`, `folder` and `file`), `claude://code/continue?session=local_<id>` (one of its sessions) and `claude://resume?session=<uuid>` (imports a CLI session); only the first is documented. After a desktop tackle the app watches the desktop app's own session index (`~/.config/Claude/claude-code-sessions/**/local_*.json`: its id, the CLI session id, the folder, the start time) for a session whose transcript starts with the prompt, in whatever folder it started (the index keeps a scratch workspace's after the session moves), for up to 30 minutes, and puts both ids on the card: its *Open* button reopens it in the desktop app. A terminal session's *Desktop* button imports it into the desktop app. If an app update moves these, a desktop tackle still opens the session; only the link back to the card is lost.

The prompt carries the card's title, description and linked cards, the path of its file (with a pointer to the board repo's `CLAUDE.md`, when it has one), and the rules: put a `Card: <ID>` trailer on every commit, move the card to the board's done list when it is verified (`flow.done` in the board settings; nothing is said when it is unset), and never commit in the board repo. Board settings also hold *Prompt notes*, appended to every prompt, and the list a tackled card moves to (`flow.doing`).

## Claude Code

The app runs whatever `claude` your login shell finds, the same one your own terminal uses; the sidebar shows its version, and *Update* runs `claude update` in a terminal tab. It does not pin its own copy: a second Claude Code inside the app would update separately from the one you use in a terminal, and Claude Code already keeps itself current.

## Running

```bash
npm install
npm run dev        # development, with hot reload
npm run build && npm start
```

The first launch asks for a project: *Add project…* takes a board repo (a clone of one) or an empty or new folder, which becomes one. The side panel's *+ Add project* adds more.

To start it from the desktop menu (and get its icon on the taskbar, which a Wayland session takes from the menu entry): `npm run install-launcher` (`bash scripts/install-launcher.sh --remove` takes it out). The icon is `build/icon.svg`, drawn by `scripts/make-icon.py` (`npm run icon` re-renders the PNGs with Inkscape).

**Windows.** The terminals run PowerShell there (`pwsh` when installed: Windows PowerShell 5.1 drops the double quotes inside an argument it passes to a program, and prompts have quotes), with the command handed over as JSON in an environment variable rather than pasted into a command line. That path is written but not yet run on Windows.

`npm run dist` packages it for Windows into `dist/`: `Corkboard Setup <version>.exe` (an installer with a Start menu entry and an uninstaller), `Corkboard <version>.exe` (a single portable exe that unpacks itself on each start), and `win-unpacked/Corkboard.exe` (the app as a plain folder). The settings are in `electron-builder.yml`. The exes are unsigned, so SmartScreen warns on first run (*More info → Run anyway*).

`npm run dist:linux` packages it for Linux into `dist/`: `Corkboard-<version>.AppImage` (one file that runs on any distribution; it needs FUSE 2, `fuse-libs` on Fedora) and `linux-unpacked/corkboard` (the app as a plain folder). An AppImage doesn't add itself to the desktop menu: `npm run install-launcher:appimage` copies the newest one to `~/.local/lib/corkboard/Corkboard.AppImage` and points the menu entry (and the taskbar icon) at it; run it again after a rebuild. `npm run dist:linux:rpm` builds `corkboard-<version>.x86_64.rpm` instead (installs under `/opt/Corkboard` with its own menu entry: `sudo dnf install ./dist/corkboard-*.rpm`); electron-builder's bundled `fpm` needs `libcrypt.so.1` for it, which Fedora ships in `libxcrypt-compat`. On Linux node-pty runs the `pty.node` that `npm install` compiled (it is an N-API addon, so no rebuild against Electron), so build where `npm install` ran; the package leaves out node-pty's Windows and macOS prebuilds. `CORKBOARD_E2E_EXECUTABLE=dist/linux-unpacked/corkboard node tests/e2e/smoke.mjs` runs the end-to-end test against the packaged app.

## Releases

Releases are built in CI and published on GitHub, never from someone's machine. To cut one:

```bash
npm version patch -m "Release %s"
git push --follow-tags
```

`npm version` (`patch` or `minor`) sets the version in `package.json`, commits it and tags that commit `v<version>`; `package.json` is the source of truth, and the release workflow refuses a tag that doesn't match it. The tag starts `.github/workflows/release.yml`, which makes a **draft** release and fills it: the unit tests, then the AppImage and the rpm built on Ubuntu 22.04 (in one run, so `latest-linux.yml` lists both; on an older Ubuntu, so node-pty's compiled `pty.node` and the AppImage also run where glibc is older), and the Setup exe and the portable exe built on Windows, with `latest.yml`. `scripts/check-packages.mjs` then checks that every package carries `resources/app-update.yml` (where the in-app updater looks for releases) and that only the rpm says it is one. Read the draft on GitHub, edit its notes, and *Publish release*: until then neither people nor installed copies see it. The exes are unsigned.

The local `npm run dist*` scripts build the same packages into `dist/` and never publish.

## Updates

The side panel's foot shows the Corkboard version running; click it for its release notes. An installed Corkboard looks for a newer published release when it starts and every four hours, and what it does with one depends on how it was installed:

- **Windows installer** (the Setup exe): downloads it in the background and installs it silently at the next quit, or at once with *Restart to update*.
- **AppImage**: downloads the new one and replaces the file where it lies (`~/.local/lib/corkboard/Corkboard.AppImage` after `npm run install-launcher:appimage`), at the next quit or on *Restart to update*.
- **rpm**: downloads the new rpm and installs it with dnf behind a password prompt, at the next quit or on *Restart to update*, so dnf still tracks the package.
- **Portable exe**: can't update itself. The side panel says *Corkboard <version> is out*, and *Download* opens the release page.

*Restart to update* asks first when terminals are running (restarting stops them, and the Claude sessions in them, which resume from their cards), then commits and pushes the board repos as a quit does, and only then installs. A development build, a copy run from `dist/linux-unpacked` or `dist/win-unpacked`, and the end-to-end test never look. The first copy with the updater (0.1.3; the 0.1.2 rpm clashes with other Electron apps) is installed by hand: `sudo dnf install ./corkboard-<version>.x86_64.rpm`, the Setup exe, or the AppImage. The exes are unsigned, so SmartScreen warns about the first download, not about the updates the app installs.

## Tests

```bash
npm test           # unit tests: card files, the store and its watch, git, sync between two clones, prompts, terminal titles, themes
npm run e2e        # builds, then drives the real app on a made-up board repo
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the unit tests and the end-to-end test on Ubuntu (in a virtual display, `xvfb-run`) and Windows for every push and pull request. The end-to-end test does not pass on Windows yet, so its run there does not fail CI.

The end-to-end test (`tests/e2e/smoke.mjs`) writes a made-up board repo in a temporary folder (`tests/e2e/fixture.mjs`: a game's boards, with child boards, a map, long lists, archived cards and a second board, nothing from anyone's real boards), points the app at it with a hidden window, and replaces `claude` with a stand-in that records its arguments (`CORKBOARD_CLAUDE_BIN`), so nothing real is started or billed. Screenshots go to `test-results/` (`SHOT_DIR` to change). `node tests/e2e/smoke.mjs <board repo>` starts from another board repo's first commit instead, which must have the fixture's shape: the checks name its boards, lists and ids.

The test clones the board repo into a scratch bare remote and works on a clone of that, so the app's sync pushes there, never to a real remote; a second clone plays the other machine. `CORKBOARD_ROOT` is its only project, and the app commits under git's `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables, so it runs on a machine with no git identity. The app's own output is saved as `main-process.log` beside the screenshots.

Environment seams: `CORKBOARD_ROOT` (a test's only project), `CORKBOARD_USER_DATA` (profile folder), `CORKBOARD_PICK_FOLDER` (what the folder picker answers), `CORKBOARD_HIDDEN=1` (an offscreen window: a hidden one stops animating after its first screenshot), `CORKBOARD_COMMIT_DELAY_MS`, `CORKBOARD_SYNC_INTERVAL_MS` (0 = no periodic sync), `CORKBOARD_CLAUDE_BIN`, `CORKBOARD_UPDATES=0` (never look for Corkboard updates).

## Importing from Trello

`scripts/import-trello.mts` turns the raw JSON the Trello connector returns (one folder per board) into board folders; its `PLAN` maps Trello boards to folders and keys.

```bash
node scripts/import-trello.mts <export dir> <board repo>
```

## License

Corkboard is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License in [LICENSE](LICENSE) for more details.

Copyright (C) 2026 agaudreau1997 and contributors.

Every package carries the same `LICENSE` beside the executable (`extraFiles` in `electron-builder.yml`), and the rpm names `GPL-3.0-or-later` in its metadata. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
