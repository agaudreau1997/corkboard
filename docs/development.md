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

## Packaging

`npm run dist` packages it for Windows into `dist/`: `Corkboard Setup <version>.exe` (an installer with a Start menu entry and an uninstaller), `Corkboard <version>.exe` (a single portable exe that unpacks itself on each start), and `win-unpacked/Corkboard.exe` (the app as a plain folder). The settings are in `electron-builder.yml`. The exes are unsigned, so SmartScreen warns on first run (*More info → Run anyway*).

`npm run dist:linux` packages it for Linux into `dist/`: `Corkboard-<version>.AppImage` (one file that runs on any distribution; it needs FUSE 2, `fuse-libs` on Fedora) and `linux-unpacked/corkboard` (the app as a plain folder). An AppImage doesn't add itself to the desktop menu: `npm run install-launcher:appimage` copies the newest one to `~/.local/lib/corkboard/Corkboard.AppImage` and points the menu entry (and the taskbar icon) at it; run it again after a rebuild. `npm run dist:linux:rpm` builds `corkboard-<version>.x86_64.rpm` instead (installs under `/opt/Corkboard` with its own menu entry: `sudo dnf install ./dist/corkboard-*.rpm`); electron-builder's bundled `fpm` needs `libcrypt.so.1` for it, which Fedora ships in `libxcrypt-compat`. On Linux node-pty runs the `pty.node` that `npm install` compiled (it is an N-API addon, so no rebuild against Electron), so build where `npm install` ran; the package leaves out node-pty's Windows and macOS prebuilds. `CORKBOARD_E2E_EXECUTABLE=dist/linux-unpacked/corkboard node tests/e2e/smoke.mjs` runs the end-to-end test against the packaged app.

Every package carries the same `LICENSE` beside the executable (`extraFiles` in `electron-builder.yml`), and the rpm names `GPL-3.0-or-later` in its metadata.

## Releases

Releases are built in CI and published on GitHub, never from someone's machine. To cut one:

```bash
npm version patch -m "Release %s"
git push --follow-tags
```

`npm version` (`patch` or `minor`) sets the version in `package.json`, commits it and tags that commit `v<version>`; `package.json` is the source of truth, and the release workflow refuses a tag that doesn't match it. The tag starts `.github/workflows/release.yml`, which makes a **draft** release and fills it: the unit tests, then the AppImage and the rpm built on Ubuntu 22.04 (in one run, so `latest-linux.yml` lists both; on an older Ubuntu, so node-pty's compiled `pty.node` and the AppImage also run where glibc is older), and the Setup exe and the portable exe built on Windows, with `latest.yml`. `scripts/check-packages.mjs` then checks that every package carries `resources/app-update.yml` (where the in-app updater looks for releases) and that only the rpm says it is one. Read the draft on GitHub, edit its notes, and *Publish release*: until then neither people nor installed copies see it. The exes are unsigned.

The local `npm run dist*` scripts build the same packages into `dist/` and never publish. How installed copies pick up a release is in [Updates](using.md#updates).

## Tests

```bash
npm test           # unit tests: card files, the store and its watch, git, sync between two clones, prompts, terminal titles, themes, work mode
npm run e2e        # builds, then drives the real app on a made-up board repo
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the unit tests and the end-to-end test on Ubuntu (in a virtual display, `xvfb-run`) and Windows for every push and pull request, and a pull request shows their result on GitHub before it is merged.

The end-to-end test (`tests/e2e/smoke.mjs`) writes a made-up board repo in a temporary folder (`tests/e2e/fixture.mjs`: a game's boards, with child boards, a map, long lists, archived cards and a second board, plus a second repo for a work project, nothing from anyone's real boards), points the app at it with a hidden window, and replaces `claude` with a stand-in that records its arguments (`CORKBOARD_CLAUDE_BIN`), so nothing real is started or billed. Screenshots go to `test-results/` (`SHOT_DIR` to change). `node tests/e2e/smoke.mjs <board repo>` starts from another board repo's first commit instead, which must have the fixture's shape: the checks name its boards, lists and ids.

The test clones the board repo into a scratch bare remote and works on a clone of that, so the app's sync pushes there, never to a real remote; a second clone plays the other machine. `CORKBOARD_ROOT` is its only project, and the app commits under git's `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables, so it runs on a machine with no git identity. The app's own output is saved as `main-process.log` beside the screenshots.

Environment seams: `CORKBOARD_ROOT` (a test's only project), `CORKBOARD_USER_DATA` (profile folder), `CORKBOARD_PICK_FOLDER` (what the folder picker answers), `CORKBOARD_PICK_FILE` (the file picker's), `CORKBOARD_HIDDEN=1` (an offscreen window: a hidden one stops animating after its first screenshot), `CORKBOARD_COMMIT_DELAY_MS`, `CORKBOARD_SYNC_INTERVAL_MS` (0 = no periodic sync), `CORKBOARD_CLAUDE_BIN`, `CORKBOARD_OPEN_URL_LOG` (writes the links the app would open, `claude://` and web pages, to this file instead), `CORKBOARD_UPDATES=0` (never look for Corkboard updates), `CORKBOARD_NOTIFY_LOG` (writes the desktop notifications to this file instead of showing them).

## Screenshots

The pictures in the README and these pages are taken by a script, so they can be taken again when the window changes:

```bash
npm run screenshots    # builds, then writes docs/images/*.png
```

`tests/e2e/screenshots.mjs` drives the built app on the end-to-end test's made-up board repo, with a few more cards, commits and sessions written into a scratch copy so the board looks worked on, and a stand-in `claude` that only sets the terminal titles Claude Code sets and prints a few lines. The terminals get a scratch home folder with a bare prompt, so nothing of the machine taking them shows. `SHOT_DIR` writes them elsewhere, to compare before replacing them.
