# Building, releases and tests

Running Corkboard from source, packaging it, cutting a release, and the tests that guard it. How to send a change is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Running from source

```bash
npm install
npm run dev        # development, with hot reload
npm run build && npm start
```

The first launch asks for a project: *Add project…* takes a board repo (a clone of one) or an empty or new folder, which becomes one. The `+` beside the side panel's title adds more.

To start it from the desktop menu (and get its icon on the taskbar, which a Wayland session takes from the menu entry): `npm run install-launcher` (`bash scripts/install-launcher.sh --remove` takes it out). The icon is `build/icon.svg`, drawn by `scripts/make-icon.py` (`npm run icon` re-renders the PNGs with Inkscape).

**Windows.** The terminals run PowerShell there (`pwsh` when installed, else Windows PowerShell 5.1), with the command handed over as JSON in an environment variable rather than pasted into a command line. PowerShell before 7.3 drops the double quotes inside an argument it passes to a program, and prompts have quotes, so it gets the arguments escaped for that. Tackling a card in a terminal works on Windows 11 under 5.1; the rest of the Windows path is less tried.

## The Android companion

The companion ([companion.md](companion.md)) lives in `mobile/`: a React page that Capacitor wraps in an Android app. It has its own `package.json` and lockfile, so Capacitor stays out of the desktop's install and building the APK installs nothing of Electron's; it is not an npm workspace (hoisting trips electron-builder and node-pty). It imports the desktop's `src/shared/` as `@shared`, so the phone reads and writes card files with the same `cardfile.ts`, and paints with the desktop's colour tokens (`themeTokens`) and its type (`FONT_TOKENS` in `src/shared/fonts.ts`, which `:root` in the desktop's stylesheet must match: a test checks). A card's face takes its badges from `cardBadges` in `src/shared/badges.ts`, as the desktop's kanban does, so a badge added or changed there shows on both. Icons are one set for both apps, too: shapes on a 16-unit grid in `src/shared/icons.ts`, drawn by a small `<Icon name>` in each (`src/renderer/src/components/Icon.tsx`, `mobile/src/Icon.tsx`), sized and weighted by the stylesheet where they sit; a new icon goes in the set, not inline in a component (a test checks). `cardfile.ts` imports `yaml`, which `mobile/vite.config.ts` and `mobile/tsconfig.json` point at `mobile/node_modules`: looked up from `src/shared/` it would be the desktop's copy.

```bash
cd mobile
npm install
npm run dev          # the page in a browser, with hot reload (no native HTTP there)
npm run typecheck
npm test             # vitest: mobile/tests/*.test.ts
npm run apk          # builds the page, copies it into android/, and builds android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The root's `npm run typecheck` and `npm test` don't cover `mobile/`: run its own. `npm run apk` needs a JDK 21 and the Android SDK (`JAVA_HOME`, `ANDROID_HOME`; Android Studio installs both, or Android's command-line tools with `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`). The APK's version is Corkboard's, read from the root `package.json` by `mobile/android/app/build.gradle` (version code `major * 10000 + minor * 100 + patch`). Its launcher icons come from `build/icon.svg` with the desktop's (`npm run icon`).

**Its GitHub App.** The companion signs in through a GitHub App, *Corkboard Companion*, whose client id and slug are in `mobile/src/github/config.ts`. A client id isn't a secret: GitHub's device flow needs no client secret, so the app holds none and needs no server. A fork registers its own at *GitHub → Settings → Developer settings → GitHub Apps → New GitHub App* and builds with `VITE_GITHUB_CLIENT_ID` and `VITE_GITHUB_APP_SLUG` set:

- *Homepage URL*: the repo; *Callback URL*: empty; *Request user authorization (OAuth) during installation*: off.
- *Expire user authorization tokens*: **on**. Access tokens last 8 hours and the app renews them with the refresh token (about 6 months, renewed at each use), which GitHub accepts without the client secret. A refresh token works once: the app saves the new pair before using it.
- *Enable Device Flow*: **on**.
- *Webhook*: *Active* off.
- *Repository permissions*: *Contents: Read and write*, nothing else (*Metadata: Read-only* comes with it). No account permissions, no events.
- No client secret and no private key: the app needs neither.

Install it on your board repos only (*Install App → Only select repositories*): a token from it reaches nothing else, so a phone that leaks one can't touch a code repo.

**Reading a board repo** (`mobile/src/repo/`) goes through GitHub's API, not git: the default branch's tree in one call, boards found in it as the desktop's store finds them in its folders, then the files through GraphQL, up to 100 blobs a query by sha (a board's lists are only known by reading every card file, and one REST call per card is too slow). Files are cached in the WebView's localStorage by sha, which names their content, so a refresh reads only what changed. Boards are laid out with the desktop's `boardColumns` and `orderList`, nested with `boardTree` as the desktop's store nests them, and a repo opens on the board `mainBoardOf` picks, its side panel listing the others with `sideBoards` (`mobile/src/repo/panel.ts`) (both in `src/shared/project.ts`, which the desktop's side panel uses too). Images (`mobile/src/repo/images.ts`) are binary, which GraphQL's `Blob.text` doesn't give: each is read on its own through REST (`git/blobs/<sha>`, base64) when a card or a list shows it, its sha found in the snapshot's tree by `imagePath` (`src/shared/images.ts`, the path the desktop resolves too), and its bytes sniffed for an image type before showing. They are kept in IndexedDB by sha, not localStorage (about 5 MB, which covers would fill), capped at 60 MB with the least recently shown dropped first; the storage is behind an interface, so the tests keep it in memory.

**A repo's look** (`mobile/src/repo/looks.ts`): its `theme.json` and `project.json`, read with the tree when the repo is browsed, and kept parsed per repo with the shas they were read at. The side panel needs every repo's, so it asks GraphQL for all their shas in one query (`object(expression: "HEAD:theme.json")`, the repos as variables) and reads only the files that changed. The colours go through the desktop's `parseTheme` and `themeTokens` (`mobile/src/theme.ts` sets every token each time, so a theme never outlives its repo) and Capacitor's `SystemBars` turns the bars' icons dark on a light theme; the swatch is drawn by `swatchColors` in `src/shared/theme.ts`, which the desktop's `ThemeSwatch` uses too.

**Making a card** (`mobile/src/repo/writer.ts`, `outbox.ts`) writes one card file through the Contents API, one commit with the auto-commit's `Add <ID>: <title>`. The card comes from `newCard` and `nextCardId` in `src/shared/cardfile.ts`, which the desktop's store uses too, so a card reads the same whichever made it. The file is written without a `sha`, which GitHub accepts only for a file that doesn't exist yet: a 422 means a desktop pushed that id meanwhile, and the next number is taken. Before writing, the board is checked for a card with the draft's `uid`, so a card whose answer was lost on the way back isn't made twice. Cards wait in an outbox in localStorage until sent.

**Changing a card** (`mobile/src/repo/editor.ts`) writes the card file against the blob sha it was read at; a 409 means it changed since, so it is read again and the change applied on top, unless it would overwrite a title, description or due date changed there too (a `Conflict`, which the screen asks about); labels and *Do after* are changed as what's added and taken off (`Edits`), so they merge, and a *Do after* that would loop (`findCycle`) is refused. A due date goes through `pickDue` (`src/shared/due.ts`), the desktop drawer's rule for a time written by hand. A linked card on another board is read from the cache only (`mobile/src/repo/linked.ts`), never fetched for its title. Its commit message comes from `describeCardChange` in `src/shared/cardfile.ts`, which the desktop's auto-commit (`git.ts`) uses too. A restore (`restore` on the change) picks the card's list or the ideas against the board read at the write, so a list archived meanwhile is seen on the retry.

**Changing a board** (`mobile/src/repo/boardchange.ts`) writes `board.json` against the blob sha it was read at. A change is kept as what was asked (a `BoardChange`: archive the list `doing`), not as the file it made, so on a 409 the board is read again and the change made again on the newer file, and two edits to different lists both survive. The file goes through `patchMeta` and `metaText` in `src/shared/boardmeta.ts`, which the desktop's store writes it with too, so its keys keep their order and keys a newer build added survive; a new list's id comes from `newListId` there, as the desktop's *Add a list* and board settings make it. The commit message comes from `describeBoardChange`, which the desktop's auto-commit uses for a changed `board.json` (it said `Edit board <dir>`).

**Finding cards** (`mobile/src/repo/find.ts`) uses `cardMatcher` from `src/shared/search.ts`, the desktop's board filter (`BoardPane.tsx`) too, so both find the same cards.

**Sharing a card** (`mobile/src/screens/CardShare.tsx`) builds its text with `src/shared/cardcopy.ts`, which the desktop's *Copy* menu (`menus.ts`) builds its items with too, so the two say the same and keep the same work-mode rule; `tests/cardcopy.test.ts` checks both modes. The phone knows a project is a work one from the root's `project.json`, read with the boards' `board.json` files and cached by sha like them (`projectSettings` in `reader.ts`). It goes through Capacitor's Share and Clipboard plugins.

There's no end-to-end test on a device: the logic is unit-tested, and the screen is checked by hand on a phone. CI's `mobile` job runs the typecheck and the tests and builds the debug APK on every push, kept as the run's `companion-debug-apk` artifact. A debug APK is signed with the key of the machine that built it, so Android refuses one from another machine (or another CI run) over it: uninstall first.

## The companion mod

The mod (`mod/`) is a Claude Code plugin made of function hooks, handed to every session the app starts in a terminal or a worktree. It is a plain folder of this repo, shipped as it is: `.claude-plugin/plugin.json` (the manifest, name `corkboard-mod`), `hooks/hooks.json` (which names the hooks module under `modules`), `hooks/hooks.ts` (the module, exporting `register(on)`), and `mod/src/` for the parts that are pure, which the module and `tests/mod.test.ts` both import. It is in `tsconfig.node.json`, so `npm run typecheck` and `npm test` cover it with the rest; there is no build step, as Claude Code compiles the module itself.

`src/main/mod.ts` says where the folder is: `mod/` beside the source, `resources/mod` in a packaged app (electron-builder's `extraResources`, repeated under `mac:`, whose own `extraResources` replace the top-level ones), and `CORKBOARD_MOD_DIR` in place of either — the end-to-end test points it at a stand-in mod of its own, and an empty value means none. A build with no mod hands out nothing and its sessions are as they were before the mod existed. `tackle.ts` adds `--plugin-dir <folder>` beside `--mcp-config` for a new session and a resumed one, and `ptys.create` gives the terminal the environment the mod reads (`sessionEnv`, listed in [Tackling](tackling.md#the-companion-mod)).

**The API is early access** and moves between Claude Code releases, so the mod is written to fail safe: every hook ends in `next(e)`, and a call that isn't there leaves the session exactly as it would be without the mod. Two things to know before changing it:

- It is off unless asked for. Claude Code puts function-hook modules behind a rollout flag, and `claude --debug` says so: `hooks modules not loaded: rollout flag (tengu_plugin_hooks_modules) is off`. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, which `sessionEnv` sets for a session that gets the mod, turns it on whatever the rollout says.
- The engine is only ever spelled `$.noun.method(...)` at the call site. Binding `$` to a name, passing it to a helper, spreading it or reading a method off it without calling it makes the module fail to load, with the reason in the debug log. So no helper of the mod's takes `$`: it builds what a call needs (`envCommands`) or reads what a call answered (`parseEnv`). `tests/mod.test.ts` reads the module for that shape, since CI has no Claude Code.

Two commands check a change:

```bash
claude plugin validate mod                       # the manifest, and what the module hooks and calls
claude --plugin-dir mod --debug-file /tmp/d.log -p "say ok"   # loads it for real; the log says what it did
```

`/plugin-types` in a session writes `claude-code.d.ts`, the authoritative declarations of the running build; it is not in every build (2.1.263 answers *Unknown command*), so `mod/src/engine.ts` declares by hand the slice the mod uses. Each method there is one a probe watched answer against 2.1.263: `$.process.run(argv)`, `$.fs.readFile` / `exists` / `stat`, `$.mcp.call(server, tool, args)`, `$.ui.log` / `status` / `toast` / `notice` / `invalidate`, `$.session.id` / `cwd` / `model` / `messages`, `$.clock.now` / `every` / `after`, `$.store.get` / `set` / `delete` / `keys`, and `$.tool.register`. The events are `session.start`, `turn.start` / `step` / `complete`, `prompt.submit`, `tool.call`, `tool.describe`, `ui.render` / `press` / `input` / `select`, and a few more. There is **no** way to read an environment variable — no `$.process.env`, and the module has no Node — which is why the mod reads its variables by running a shell once (`envCommands`: `sh` first, then `cmd.exe` for a Windows machine without one).

## Packaging

`npm run dist` packages it for Windows into `dist/`: `Corkboard Setup <version>.exe` (an installer with a Start menu entry and an uninstaller), `Corkboard <version>.exe` (a single portable exe that unpacks itself on each start), and `win-unpacked/Corkboard.exe` (the app as a plain folder). The settings are in `electron-builder.yml`. The exes are unsigned, so SmartScreen warns on first run (*More info → Run anyway*).

`npm run dist:linux` packages it for Linux into `dist/`: `Corkboard-<version>.AppImage` (one file that runs on any distribution; it needs FUSE 2, `fuse-libs` on Fedora) and `linux-unpacked/corkboard` (the app as a plain folder). An AppImage doesn't add itself to the desktop menu: `npm run install-launcher:appimage` copies the newest one to `~/.local/lib/corkboard/Corkboard.AppImage` and points the menu entry (and the taskbar icon) at it; run it again after a rebuild. `npm run dist:linux:rpm` builds `corkboard-<version>.x86_64.rpm` instead (installs under `/opt/Corkboard` with its own menu entry: `sudo dnf install ./dist/corkboard-*.rpm`); electron-builder's bundled `fpm` needs `libcrypt.so.1` for it, which Fedora ships in `libxcrypt-compat`. On Linux node-pty runs the `pty.node` that `npm install` compiled (it is an N-API addon, so no rebuild against Electron), so build where `npm install` ran; the package leaves out node-pty's Windows and macOS prebuilds. `CORKBOARD_E2E_EXECUTABLE=dist/linux-unpacked/corkboard node tests/e2e/smoke.mjs` runs the end-to-end test against the packaged app.

`npm run dist:mac` packages it for macOS into `dist/`, for Apple silicon and Intel: `Corkboard-<version>-arm64.dmg` and `Corkboard-<version>.dmg` (drag the app to Applications), the zips the updater installs from (`Corkboard-<version>-arm64-mac.zip`, `Corkboard-<version>-mac.zip`, both listed in `latest-mac.yml`), and `mac-arm64/Corkboard.app` and `mac/Corkboard.app` (the apps as plain bundles). macOS runs node-pty's darwin prebuilds, so the Mac apps leave out the Windows ones; node-pty 1.1.0 ships their `spawn-helper`, through which every terminal starts, without the execute bit, and `npm install` sets it (`scripts/fix-spawn-helper.mjs`, the `postinstall`). There is no Apple Developer ID, so the app is signed ad hoc (Apple silicon runs nothing unsigned), and `scripts/after-sign-mac.cjs` signs the bundle once more with a designated requirement naming its bundle id: Squirrel.Mac, which installs the updates, takes only an update that satisfies the running app's requirement, and an ad-hoc signature's own is its hash. It isn't notarized either, so macOS refuses a downloaded copy's first open until *Open Anyway* in *System Settings → Privacy & Security*.

Every package carries the same `LICENSE`: beside the executable on Windows and Linux, in `Contents/Resources` on macOS, where codesign refuses a loose file in `Contents` (`extraFiles` / `extraResources` per platform in `electron-builder.yml`). The rpm names `GPL-3.0-or-later` in its metadata.

## Releases

Releases are built in CI and published on GitHub, never from someone's machine. To cut one:

```bash
npm version patch -m "Release %s"
git push --follow-tags
```

`npm version` (`patch` or `minor`) sets the version in `package.json`, commits it and tags that commit `v<version>`; `package.json` is the source of truth, and the release workflow refuses a tag that doesn't match it. The tag starts `.github/workflows/release.yml`, which makes a **draft** release and fills it: the unit tests, then the AppImage and the rpm built on Ubuntu 22.04 (in one run, so `latest-linux.yml` lists both; on an older Ubuntu, so node-pty's compiled `pty.node` and the AppImage also run where glibc is older), the Setup exe and the portable exe built on Windows, with `latest.yml`, and the dmgs and zips for Apple silicon and Intel built on macOS (in one run, so `latest-mac.yml` lists both). `scripts/check-packages.mjs` then checks that every package carries `resources/app-update.yml` (where the in-app updater looks for releases), that only the rpm says it is one, and that both Mac apps pass `codesign --verify` with the designated requirement updates need. Read the draft on GitHub, edit its notes, and *Publish release*: until then neither people nor installed copies see it. The exes are unsigned.

The local `npm run dist*` scripts build the same packages into `dist/` and never publish. How installed copies pick up a release is in [Updates](using.md#updates).

## Tests

```bash
npm test           # unit tests: card files, the store and its watch, git, sync between two clones, prompts, terminal titles, themes, work mode, the MCP server and its tools
npm run e2e        # builds, then drives the real app on a made-up board repo
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the unit tests and the end-to-end test on Ubuntu (in a virtual display, `xvfb-run`), Windows and macOS for every push and pull request, and a pull request shows their result on GitHub before it is merged.

The end-to-end test (`tests/e2e/smoke.mjs`) writes a made-up board repo in a temporary folder (`tests/e2e/fixture.mjs`: a game's boards, with child boards, a map, long lists, archived cards and a second board, plus a second repo for a work project, nothing from anyone's real boards), points the app at it with a hidden window, and replaces `claude` with a stand-in that records its arguments (`CORKBOARD_CLAUDE_BIN`), so nothing real is started or billed. Screenshots go to `test-results/` (`SHOT_DIR` to change). `node tests/e2e/smoke.mjs <board repo>` starts from another board repo's first commit instead, which must have the fixture's shape: the checks name its boards, lists and ids.

The test clones the board repo into a scratch bare remote and works on a clone of that, so the app's sync pushes there, never to a real remote; a second clone plays the other machine. `CORKBOARD_ROOT` is its only project, and the app commits under git's `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables, so it runs on a machine with no git identity. The app's own output is saved as `main-process.log` beside the screenshots.

Environment seams: `CORKBOARD_ROOT` (a test's only project), `CORKBOARD_USER_DATA` (profile folder), `CORKBOARD_PICK_FOLDER` (what the folder picker answers), `CORKBOARD_PICK_FILE` (the file picker's), `CORKBOARD_HIDDEN=1` (an offscreen window: a hidden one stops animating after its first screenshot), `CORKBOARD_COMMIT_DELAY_MS`, `CORKBOARD_SYNC_INTERVAL_MS` (0 = no periodic sync), `CORKBOARD_CLAUDE_BIN`, `CORKBOARD_MOD_DIR` (the companion mod's folder, or empty for none: the end-to-end test stands its own in), `CORKBOARD_OPEN_URL_LOG` (writes the links the app would open, `claude://` and web pages, to this file instead), `CORKBOARD_UPDATES=0` (never look for Corkboard updates), `CORKBOARD_NOTIFY_LOG` (writes the desktop notifications to this file instead of showing them), `CORKBOARD_MCP_PORT` (the MCP server's port, in place of 47823 installed or 47824 from the source: the end-to-end test gives it a free one, reads the URL and token from the config file the stand-in `claude` was handed, and calls the tools over HTTP).

## Screenshots

The pictures in the README and these pages are taken by a script, so they can be taken again when the window changes:

```bash
npm run screenshots    # builds, then writes docs/images/*.png
```

`tests/e2e/screenshots.mjs` drives the built app on the end-to-end test's made-up board repo, with a few more cards, commits and sessions written into a scratch copy so the board looks worked on, and a stand-in `claude` that only sets the terminal titles Claude Code sets and prints a few lines. The terminals get a scratch home folder with a bare prompt, so nothing of the machine taking them shows. `SHOT_DIR` writes them elsewhere, to compare before replacing them.
