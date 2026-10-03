// One-off import of a Trello export (the raw JSON the Trello connector returned, one folder per
// board: board.json, lists.json, cards.json, optional thoughts_list.json-style extras) into a
// Corkboard board repo.
//
//   node scripts/import-trello.mts <export dir> <board root> [--force]
//
// Card ids keep Trello's card numbers (the number in the card URL) behind each board's key, so
// `#886` on the Robot shooter board becomes RS-886.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { serializeCard, slugify } from '../src/shared/cardfile.ts'
import type { BoardMap, BoardMeta, Card, ListDef } from '../src/shared/types.ts'

const GAME_REPO = '/home/alex/Documents/Godot/Projects/godot-shooter'

type Plan = {
  short: string
  dir: string
  key: string
  title?: string
  codeRepo?: string
  flow?: BoardMeta['flow']
  hiddenLists?: string[]
}

const PLAN: Plan[] = [
  {
    short: 'rmSBkbrS',
    dir: 'robot-shooter',
    key: 'RS',
    codeRepo: GAME_REPO,
    flow: { done: 'done' },
    hiddenLists: ['done'],
  },
  { short: 'ZLUeyu1c', dir: 'robot-shooter/ideas', key: 'IDEA', title: 'Ideas' },
  { short: 'zJ78ZVA5', dir: 'robot-shooter/narrative-lore', key: 'LORE', title: 'Narrative & lore' },
  { short: 'nIGgy4tL', dir: 'robot-shooter/performance', key: 'PERF', title: 'Performance' },
  { short: 'AY8GAtj4', dir: 'untitled-shooter', key: 'US' },
]

type TrelloCard = {
  id: string
  name: string
  description?: string
  url?: string
  shortUrl?: string
  closed?: boolean
  complete?: boolean
  position?: number
  lastActivityAt?: string
  due?: { date: string | null; complete?: boolean } | null
  labels?: { name?: string; color?: string }[]
  checklists?: { name: string; items?: { name: string; state?: string; complete?: boolean }[] }[]
  comments?: { text: string; createdAt?: string; creator?: { fullName?: string } }[]
  _exportList?: { id: string; name: string }
}

type TrelloList = { id: string; name: string; position: number }

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

/** The hex object id's first 8 digits are its creation time in seconds. */
function createdFromId(ari: string): string | undefined {
  const hex = ari.split('/').at(-1) ?? ''
  if (!/^[0-9a-f]{24}$/.test(hex)) return undefined
  return new Date(parseInt(hex.slice(0, 8), 16) * 1000).toISOString()
}

function cardNumberFromUrl(url?: string): number | undefined {
  const m = url ? /\/c\/[^/]+\/(\d+)-/.exec(url) : null
  return m ? Number(m[1]) : undefined
}

function importBoard(exportDir: string, root: string, plan: Plan): { cards: number; archived: number } {
  const src = path.join(exportDir, plan.short)
  const board = readJson<{ name: string; url: string; id: string }>(path.join(src, 'board.json'))
  const lists = readJson<TrelloList[]>(path.join(src, 'lists.json'))
  const cards = readJson<TrelloCard[]>(path.join(src, 'cards.json'))

  // Extra lists the export missed (written by hand as {list, cards}).
  for (const name of readdirSync(src).filter(n => n.endsWith('_list.json'))) {
    const extra = readJson<{ list: TrelloList; cards: TrelloCard[] }>(path.join(src, name))
    if (!lists.some(l => l.id === extra.list.id)) lists.push(extra.list)
    for (const c of extra.cards) {
      if (!cards.some(k => k.id === c.id)) cards.push({ ...c, _exportList: { id: extra.list.id, name: extra.list.name } })
    }
  }
  lists.sort((a, b) => a.position - b.position)

  const listIds = new Map<string, string>()
  const defs: ListDef[] = []
  for (const list of lists) {
    let id = slugify(list.name)
    for (let n = 2; defs.some(d => d.id === id); n++) id = `${slugify(list.name)}-${n}`
    listIds.set(list.id, id)
    defs.push({ id, title: list.name })
  }

  const meta: BoardMeta = {
    key: plan.key,
    title: plan.title ?? board.name,
    lists: defs,
    ...(plan.codeRepo ? { codeRepo: plan.codeRepo } : {}),
    ...(plan.flow ? { flow: plan.flow } : {}),
    created: createdFromId(board.id),
    trello: { url: board.url, id: board.id },
  }

  const dir = path.join(root, plan.dir)
  mkdirSync(path.join(dir, 'cards'), { recursive: true })
  writeFileSync(path.join(dir, 'board.json'), `${JSON.stringify(meta, null, 2)}\n`)

  // Order inside each list by Trello's position, then number the positions 1024 apart.
  const byList = new Map<string, TrelloCard[]>()
  for (const card of cards) {
    const listKey = card._exportList?.id ?? 'none'
    if (!byList.has(listKey)) byList.set(listKey, [])
    byList.get(listKey)!.push(card)
  }
  const used = new Set<number>()
  for (const card of cards) {
    const n = cardNumberFromUrl(card.url)
    if (n !== undefined) used.add(n)
  }
  let spare = Math.max(0, ...used) + 1

  let written = 0
  let archived = 0
  for (const [listKey, group] of byList) {
    group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    group.forEach((t, i) => {
      const n = cardNumberFromUrl(t.url) ?? spare++
      const body: string[] = []
      if (t.description?.trim()) body.push(t.description.trim())
      for (const cl of t.checklists ?? []) {
        body.push(
          `## ${cl.name}\n\n${(cl.items ?? [])
            .map(it => `- [${it.complete || it.state === 'complete' ? 'x' : ' '}] ${it.name}`)
            .join('\n')}`,
        )
      }
      if (t.comments?.length) {
        body.push(
          `## Trello comments\n\n${t.comments
            .map(c => `**${c.creator?.fullName ?? 'someone'}** (${c.createdAt?.slice(0, 10) ?? ''}): ${c.text}`)
            .join('\n\n')}`,
        )
      }
      const card: Card = {
        id: `${plan.key}-${n}`,
        title: t.name,
        list: listIds.get(listKey) ?? (t._exportList ? slugify(t._exportList.name) : null),
        pos: (i + 1) * 1024,
        created: createdFromId(t.id),
        updated: t.lastActivityAt ?? undefined,
        due: t.due?.date ?? undefined,
        complete: t.complete ? true : undefined,
        archived: t.closed ? true : undefined,
        labels: (t.labels ?? []).map(l => l.name || l.color || '').filter(Boolean),
        links: [],
        trello: t.shortUrl ?? t.url,
        sessions: [],
        body: body.join('\n\n'),
        extra: {},
      }
      writeFileSync(path.join(dir, 'cards', `${card.id}.md`), serializeCard(card))
      written++
      if (card.archived) archived++
    })
  }

  const map: BoardMap = { nodes: {}, ...(plan.hiddenLists ? { hiddenLists: plan.hiddenLists } : {}) }
  writeFileSync(path.join(dir, 'map.json'), `${JSON.stringify(map, null, 2)}\n`)
  return { cards: written, archived }
}

function main(): void {
  const [exportDir, root] = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const force = process.argv.includes('--force')
  if (!exportDir || !root) {
    console.error('usage: node scripts/import-trello.mts <export dir> <board root> [--force]')
    process.exit(2)
  }
  for (const plan of PLAN) {
    const target = path.join(root, plan.dir, 'board.json')
    if (existsSync(target) && !force) {
      console.error(`${target} exists; pass --force to overwrite`)
      process.exit(1)
    }
  }
  for (const plan of PLAN) {
    const { cards, archived } = importBoard(exportDir, root, plan)
    console.log(`${plan.dir} (${plan.key}): ${cards} cards, ${archived} archived`)
  }
}

main()
