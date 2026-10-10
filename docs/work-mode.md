# Work mode

For a project whose code repos are shared with teammates or clients and whose work Jira tracks: a card id of your board means nothing to them, so no card id goes into the code repo.

*Work mode* in the project's *Settings…* writes `project.json` (`{ "work": true }`) at the board repo's root, so every machine follows it, and every board of the project counts, new ones included. A card gets a *Jira* field in its drawer (`jira: SPDI-42` in the file).

- **The prompts** then open with the Jira key (or the title), ask the session to name it in every commit message, in the branch name and in the PR title, and forbid writing any card id of the board anywhere in the code repo or its remote (commits, branches, PRs, code, comments), saying outright that this overrides the board repo's `CLAUDE.md`; a card without a key has the session ask for it before its first commit and write it into the card. A cloud prompt carries no card id at all; a local one carries them only in the card file paths and in related cards' ids, which the session needs for the board.
- **A worktree** is named after the key as written (`-w SPDI-42`, branch `worktree-SPDI-42`), or after the title.
- **Copy** offers the *Jira key* in place of the *Commit trailer*, and its *Markdown* names the key or the title alone.
- **Commits**: the card shows the code repo's commits whose message names its key, whole (`SPDI-12` is not found in `SPDI-123`), teammates' included.
- **The board guide**: a board repo's `CLAUDE.md` added while work mode is on carries the same rule in place of the trailer one; an existing one is never rewritten.

Every machine that tackles the project needs a build that knows the flag: an older one ignores it and asks sessions for `Card:` trailers.
