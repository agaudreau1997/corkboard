# Corkboard

An Electron app (React renderer, TypeScript throughout): a kanban and mind-map board whose data is a git repo of plain files, built to hand cards to Claude Code. The README describes what it does and how to run, test and package it; this file is what to know before changing it.

## Commands

```bash
npm install
npm run dev          # the app with hot reload
npm run typecheck    # tsc on both projects: tsconfig.node.json (main, preload, shared, scripts, tests) and tsconfig.web.json (renderer)
npm test             # vitest: tests/*.test.ts
npx vitest run tests/store.test.ts   # one file
npm run e2e          # builds, then drives the built app with Playwright (tests/e2e/smoke.mjs)
```

Before calling a change done: `npm run typecheck` and `npm test`, and `npm run e2e` for anything a person sees or clicks. The e2e test writes a made-up board repo (`tests/e2e/fixture.mjs`, whose exports name the boards and ids the checks use; a board repo given as its first argument replaces it) into a scratch folder with a scratch bare remote, and replaces `claude` with a stand-in that records its arguments, so it never touches the real board repo, its remote, or a real Claude session. Screenshots and `main-process.log` go to `test-results/`.

## Layout

- `src/main/`: the Electron main process. `index.ts` is the window, the app config and every `ipcMain.handle` channel; `projects.ts` (one board repo: its store, auto-committer and sync; board keys are `<project id>:<path>`), `store.ts` (the boards on disk, read at start and kept current by a recursive watch; every write goes through it), `git.ts` (the auto-commit of the board repo, and `Card:` trailers read from the code repo), `sync.ts` (fetch, rebase, push, and the conflict rules), `tackle.ts` (starting `claude` for a card), `desktop.ts` (the Claude desktop app's `claude://` links and session index), `pty.ts` / `shell.ts` (the terminals, per platform), `termstatus.ts` (a tab's status, read from the terminal title Claude Code sets).
- `src/preload/index.ts`: the bridge, exposed as `window.corkboard`; its type is `CorkboardApi` in `src/shared/api.ts`.
- `src/shared/`: imported by both sides as `@shared/...`. `types.ts` is the data model, `cardfile.ts` parses and writes card files, `prompts.ts` builds the tackle and discuss prompts, `maplayout.ts` is the map view's geometry, `theme.ts` reads and writes a project's `theme.json` and turns it into the stylesheet's colour tokens. Keep these pure (no Electron, no Node I/O), so the tests and the renderer can use them.
- `src/renderer/src/`: React. `state.ts` is the zustand store and its `actions`; `components/` holds the views (`KanbanView`, `MapView`, `TableView`), the card drawer (`CardDetail`), `Sidebar`, `TerminalPanel` and the modals; `menus.ts` builds the right-click menus all three views share.
- `scripts/`: the Trello importer, the desktop launcher, the icon. `build/`: the icons. `electron-builder.yml`: packaging.

A new IPC call touches four places: the handler in `src/main/index.ts`, the method on `CorkboardApi` in `src/shared/api.ts`, its `invoke` in `src/preload/index.ts`, and its caller in the renderer (usually an action in `state.ts`). Events from main to the window go through `send(channel, ...)` in `index.ts` and a `subscribe` in the preload.

## The board repo's format

The repo's root may hold a `theme.json`: the project's colours (`ProjectTheme`), read, watched and written by the store like a board file; and a `project.json`: the project's settings (`ProjectSettings`, today the `work` flag, read and written by `src/shared/project.ts`), handled the same way. In work mode the prompts, the worktree names, the copy menu and the board guide name a card's `jira:` key and keep every card id out of the code repo; a change to any of those keeps that rule, and `tests/cardfile.test.ts` and `tests/discuss.test.ts` check the work-mode prompts. A board is a folder with a `board.json` (`BoardMeta`: its lists, `codeRepo`, `flow.doing` / `flow.done`, prompt notes), a `cards/` folder of `<ID>.md` files, and an optional `map.json`; a sub-folder with a `board.json` is a child board. A card file is YAML front matter, then the Markdown description. The format is a contract with people and Claude sessions who edit these files by hand, and with other machines running an older build:

- `serializeCard` writes the known keys in a fixed order and drops empty ones, so a move is a one-line diff and a hand-edited file round-trips unchanged. A new field goes into `KNOWN` in `cardfile.ts`, and `Card` in `types.ts`, and needs a round-trip test in `tests/cardfile.test.ts`.
- Unknown keys must survive a read and a write.
- `updated` decides which side of a sync conflict a card keeps (`sync.ts`), so every change to a card stamps it.

## Conventions

- **Style**: no semicolons, single quotes, two-space indent, trailing commas, comments wrapped at about 100 columns. There is no formatter or linter configured; match the file you're in.
- **Comments**: each module opens with a comment saying what it is for and why it works the way it does; exported functions get a one-line `/** */` where the name doesn't say it all. Write them as plain sentences, and say why, not what.
- **Card ids and the code repo**: a personal project's sessions put `Card:` trailers on commits; a work project's never write a card id into the code repo and name the Jira key instead (`work` on `PromptContext`, `isWork` in the renderer). Anything new that writes text for the code repo or a clipboard (a prompt, a branch name, a copy item) follows that split, with a test for both.
- **Test seams** are environment variables read in the main process (`CORKBOARD_ROOT`, `CORKBOARD_USER_DATA`, `CORKBOARD_HIDDEN`, `CORKBOARD_CLAUDE_BIN`, the delays, ...; the list is in the README's *Tests*). A new dependency on the outside world (a program, a folder in the home directory, a URL opened) gets one, so the e2e test can stand it in.
- **Platforms**: Linux is where it runs and is tested; Windows is written for but not yet run. A command for a terminal goes through `shellLaunch` in `shell.ts` as argv, never pasted into a shell line (prompts hold quotes, backticks and newlines).
- **Colours** of the window are custom properties in `:root` of `styles.css`, not literals in a rule or a component (list colours are board data, and the terminals keep xterm's palette): a project's theme replaces them (`themeTokens` in `src/shared/theme.ts`), and a literal would stay the app's colour under every theme. A new token goes in both places; `tests/theme.test.ts` checks that every token a theme sets is in `:root`, near the value the theme would mix.
- **No personal paths** in the code (a folder in the author's home, a repo of theirs): the app is GPL-licensed and published.
- **README**: a change someone using the app would notice gets a line there, in the README's own voice.

## Commits

Say what changed and why in plain prose, as `git log` shows. A change for a card on the project's board ends with a `Card: <ID>` trailer (Corkboard shows the commit on the card), and an AI-assisted one with a `Co-Authored-By:` trailer naming the model. See CONTRIBUTING.md for the sign-off and the license.

Never commit in a board repo: the app commits it itself a few seconds after the last change. A Claude session working a card edits the card file there (`list:`, `updated:`) and leaves the commit to the app.
