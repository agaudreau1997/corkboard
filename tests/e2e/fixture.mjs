// The board repo the end-to-end test drives, written fresh by every run: a made-up game's boards
// with the shape the checks need (a board with child boards, a map, lists past the 60-card cap,
// dividers, archived cards, ideas off any list, a second board to move between projects), and
// nothing taken from anyone's real boards. The ids and titles the checks name are exported.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MAIN = { path: 'moon-base', title: 'Moon base', key: 'MB' }
export const IDEAS = { path: 'moon-base/ideas', title: 'Ideas', key: 'IDEA' }
/** Moon base's child boards, as the side panel lists them. */
export const CHILDREN = ['Ideas', 'Story & lore', 'Performance']
/** A board of its own, moved to another project and deleted there. */
export const SPARE = { path: 'old-prototype', title: 'Old prototype', key: 'OP', files: 29 }
/** The one open card in To fix: tackled, sent to the cloud, renamed by the other machine. */
export const TO_FIX = 'MB-201'
/** A card in Done that a commit in the scratch code repo names. */
export const COMMITTED = 'MB-202'

const VERBS = ['Fix', 'Polish', 'Add', 'Tune', 'Test', 'Rework']
const THINGS = ['the airlock', 'the rover', 'the oxygen meter', 'the drill', 'the hangar lights', 'the radio', 'the map screen', 'the save menu', 'the dust storm', 'the solar panels', 'the cargo lift', 'the greenhouse']
const IDEA_THINGS = ['a jetpack', 'a moon cat', 'a crater lake', 'a repair drone', 'a night cycle', 'a trading post', 'a meteor shower', 'a mining laser', 'a cave level', 'a spare suit']

/** Writes the board folders into `root` (a fresh git repo); the caller commits them. */
export function writeFixture(root) {
  let clock = Date.parse('2026-01-05T09:00:00.000Z')
  const stamp = () => new Date((clock += 60_000)).toISOString()

  function board(spec, lists, cards, extra = {}) {
    const dir = path.join(root, spec.path)
    mkdirSync(path.join(dir, 'cards'), { recursive: true })
    const meta = { key: spec.key, title: spec.title, lists: lists.map(([id, title]) => ({ id, title })), ...extra, created: stamp() }
    writeFileSync(path.join(dir, 'board.json'), `${JSON.stringify(meta, null, 2)}\n`)
    writeFileSync(path.join(dir, 'map.json'), `${JSON.stringify({ nodes: {} }, null, 2)}\n`)
    let n = 0
    for (const [i, card] of cards.entries()) {
      const id = card.id ?? `${spec.key}-${++n}`
      const at = stamp()
      const front = [
        `id: ${id}`,
        `title: ${JSON.stringify(card.title)}`,
        `list: ${card.list ?? 'null'}`,
        `pos: ${(i + 1) * 1024}`,
        `created: ${at}`,
        `updated: ${at}`,
        ...(card.archived ? ['archived: true'] : []),
      ]
      writeFileSync(path.join(dir, 'cards', `${id}.md`), `---\n${front.join('\n')}\n---\n${card.body ? `\n${card.body}\n` : ''}`)
    }
  }

  /** `count` cards in a list, titled from `things`, starting at `from`. */
  const many = (list, count, { archived = false, from = 0, things = THINGS } = {}) =>
    Array.from({ length: count }, (_, i) => {
      const k = from + i
      return { list, archived, title: `${VERBS[k % VERBS.length]} ${things[Math.floor(k / VERBS.length) % things.length]}` }
    })

  writeFileSync(path.join(root, 'README.md'), '# Moon base boards\n\nA made-up board repo for the end-to-end test.\n')

  board(
    MAIN,
    [
      ['todo', 'To do'],
      ['doing', 'Doing'],
      ['next', 'Next up'],
      ['tofix', 'To fix'],
      ['done', 'Done'],
      ['tutorial', 'Tutorial'],
      ['alpha', 'Alpha'],
      ['thoughts', 'Thoughts'],
    ],
    [
      ...many('todo', 3),
      ...many('todo', 4, { archived: true, from: 3 }),
      ...many('doing', 3, { archived: true, from: 7 }),
      { id: TO_FIX, list: 'tofix', title: 'The rover gets stuck under the hangar ramp', body: 'Seen twice after a dust storm.' },
      ...many('tofix', 3, { archived: true, from: 10 }),
      // Past the 60 cards a list shows before *Show all*.
      ...many('done', 74, { from: 13 }),
      { id: COMMITTED, list: 'done', title: 'Give the drill a sound of its own' },
      ...many('tutorial', 8, { from: 2 }),
      ...many('alpha', 9, { from: 20 }),
      { list: 'alpha', title: '-----' },
      ...many('alpha', 9, { from: 40 }),
      { list: 'alpha', title: '---' },
      ...many('thoughts', 3, { archived: true, from: 5 }),
    ],
    { flow: { done: 'done' } },
  )

  board(
    IDEAS,
    [
      ['items', 'Items'],
      ['enemies', 'Enemies'],
      ['rooms', 'Rooms'],
      ['upgrades', 'Upgrades'],
      ['considering', 'Considering'],
    ],
    [
      ...many('items', 10, { things: IDEA_THINGS }),
      ...many('items', 2, { archived: true, from: 10, things: IDEA_THINGS }),
      ...many('enemies', 9, { from: 12, things: IDEA_THINGS }),
      ...many('rooms', 8, { from: 21, things: IDEA_THINGS }),
      ...many('upgrades', 6, { from: 29, things: IDEA_THINGS }),
      ...many('considering', 6, { from: 35, things: IDEA_THINGS }),
      ...many('considering', 4, { archived: true, from: 41, things: IDEA_THINGS }),
      { list: null, title: 'Low gravity football' },
    ],
  )

  board(
    { path: 'moon-base/story', title: 'Story & lore', key: 'LORE' },
    [
      ['threads', 'Threads'],
      ['crew', 'Crew'],
      ['places', 'Places'],
    ],
    [...many('threads', 4, { things: IDEA_THINGS }), ...many('crew', 4, { from: 4, things: IDEA_THINGS }), ...many('places', 2, { from: 8, things: IDEA_THINGS })],
  )

  board({ path: 'moon-base/performance', title: 'Performance', key: 'PERF' }, [['measure', 'To measure']], many('measure', 3))

  board(
    SPARE,
    [
      ['maybe', 'Maybe one day'],
      ['wants', 'Wants'],
      ['physics', 'Physics'],
      ['outline', 'Outline'],
      ['basics', 'Basics'],
    ],
    [
      ...many('maybe', 4),
      ...many('wants', 7, { from: 4 }),
      ...many('physics', 6, { from: 11 }),
      ...many('physics', 1, { archived: true, from: 17 }),
      ...many('outline', 6, { from: 18 }),
      ...many('basics', 5, { from: 24 }),
    ],
  )
}
