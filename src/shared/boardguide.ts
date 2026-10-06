// The CLAUDE.md a board repo gets: the card format, for the Claude sessions the tackle and discuss
// prompts send there and for anyone editing the cards by hand. A new board repo gets it beside
// its README; an existing one only when its owner says yes, since the app adds no files unasked.
// Written for any board repo, so it names no board, key or folder of anyone's. A work project's
// guide (project.json's `work`) ends with the Jira rule in place of the `Card:` trailer: its code
// repos are shared with people who never see the board. A guide already there is never rewritten,
// which is why the work-mode prompts say outright that they override it.

export const BOARD_GUIDE_FILE = 'CLAUDE.md'

/** The board repo's CLAUDE.md, titled with the repo's name. */
export function boardGuide(name: string, opts: { work?: boolean } = {}): string {
  return `# ${name}

Task boards, read and edited by the Corkboard app. Plain files, versioned in git: the app commits every change itself a few seconds after it, and syncs the repo with its remote (pull and push), so **never commit, pull or push in this repo**; edit the files and leave them. When you change a card, also set its \`updated:\` to the current time (ISO, UTC): when two machines changed the same card, the sync keeps the side edited last.

## Layout

- Every folder holding a \`board.json\` is a board. A board folder may hold other board folders: those are its child boards.
- \`board.json\`: \`key\` (the card id prefix, unique in the repo), \`title\`, \`lists\` (ordered \`{ id, title, sort }\`: \`sort\` is how the list orders its cards: \`manual\`, by \`pos\`; \`updated\`, last changed first; \`newest\`, \`oldest\`, \`number\` or \`title\`. Unset, the list \`flow.done\` names sorts by \`updated\` and the others are \`manual\`), \`codeRepo\` (the code repo its cards' commits live in; child boards inherit it), \`flow.doing\` / \`flow.done\` (the list ids the app's tackle buttons move cards to), \`promptNotes\` (added to every prompt the app sends for its cards).
- \`cards/<ID>.md\`: one card per file, named by its id (\`TASK-12.md\`). YAML front matter, then the description in Markdown.
- \`map.json\`: the map view's node positions and filters. Leave it to the app.

## A card

\`\`\`markdown
---
id: TASK-12
title: Add an export button
list: todo            # a list id from board.json; null = an idea that only lives on the map
pos: 11264            # order inside a list sorted \`manual\`, smaller first
created: 2026-09-20T12:28:50.000Z
updated: 2026-09-28T02:21:47.658Z
labels: [ui]
links: [TASK-3, IDEA-40]   # related cards on any board (the map's edges)
sessions: [...]       # Claude Code sessions the app started for it; leave as is
---
Description.
\`\`\`

Other keys the app knows: \`due\` (a date), \`complete: true\`, \`archived: true\`, \`jira\` (the Jira issue key the card is tracked as, \`jira: ABC-123\`). Keys it does not know are kept as they are.

- **Move a card**: change \`list:\` to another list id of its board. Keep \`pos:\`: most lists are \`manual\`, where the old number sorts the card among the others, and a sorted one places the card itself.
- **New card**: \`cards/<KEY>-<n>.md\` with the next free number on that board, and \`id\`, \`title\`, \`list\`, \`pos\`, \`created\` and \`updated\` set.
- **Archive** a card with \`archived: true\`; never delete card files.
- **Move a card to another board** by moving its file into that board's \`cards/\` folder and setting \`list:\` to one of that board's lists. It keeps its id, so its commits and links still find it.
- A card titled \`---\` (any run of dashes) is a divider inside its list, not work.

${opts.work ? workSection() : trailerSection()}`
}

function trailerSection(): string {
  return `## Cards and code

Every commit in a code repo that works on a card carries a trailer naming it, one per card:

\`\`\`
Card: TASK-12
\`\`\`

The app reads the code repo's history for those trailers and shows the commits on the card.
`
}

function workSection(): string {
  return `## Cards and code

This is a work project (\`project.json\` at the root says \`"work": true\`): its code repos are shared with teammates and clients who never see this board, and Jira tracks the work. So **never write a card id of this board** (\`TASK-12\`) in anything that goes into a code repo or its remote: not in a commit message, a branch name, a PR title or description, code, a comment or a file. No \`Card:\` trailers.

The identifier there is the card's Jira key, kept in its front matter as \`jira: ABC-123\`: name it in every commit message, in the branch name and in the PR title. A card with no \`jira:\` yet has no key: ask for it before the first commit, then write it into the card (with \`updated:\`). The app shows the code repo's commits whose message names the key on the card.
`
}
