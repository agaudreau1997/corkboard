import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCard } from '@shared/cardfile'
import { McpHost, mcpConfig, mcpPort, mcpToken, MCP_DEV_PORT, MCP_PORT } from '../src/main/mcp'
import { BoardTools, type ToolProject } from '../src/main/mcptools'
import { BoardStore } from '../src/main/store'

let root: string
let other: string
let userData: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'corkboard-mcp-'))
  other = mkdtempSync(path.join(os.tmpdir(), 'corkboard-mcp-other-'))
  userData = mkdtempSync(path.join(os.tmpdir(), 'corkboard-mcp-profile-'))
})
afterEach(() => {
  for (const dir of [root, other, userData]) rmSync(dir, { recursive: true, force: true })
})

/** Two projects: a game (a board G and its child board), and a client project in work mode. */
async function setup() {
  const store = new BoardStore(root)
  await store.init()
  const game = await store.createBoard('', 'Game', 'G')
  const ideas = await store.createBoard(game, 'Ideas', 'ID')
  await store.updateMeta(game, { lists: [...store.board(game).meta.lists, { id: 'old', title: 'Old', archived: true }] })
  await store.createCard(game, { title: 'Turrets', list: 'todo' })
  await store.createCard(game, { title: 'Traps', list: 'todo' })
  await store.createCard(ideas, { title: 'Weather', list: 'todo' })
  const client = new BoardStore(other)
  await client.init()
  await client.saveSettings({ work: true })
  const portal = await client.createBoard('', 'Portal', 'G')
  await client.createCard(portal, { title: 'Login form', list: 'todo' })
  const projects: ToolProject[] = [
    { id: 'game', name: 'Game', store },
    { id: 'client', name: 'Client', store: client },
  ]
  return { store, client, game, ideas, portal, projects, tools: new BoardTools(() => projects) }
}

const fileOf = (store: BoardStore, board: string, id: string) => parseCard(readFileSync(store.cardFile(board, id), 'utf8'))

describe('the board tools', () => {
  it('lists the projects and boards with their keys, lists and flow', async () => {
    const { tools } = await setup()
    const out = await tools.listBoards()
    expect(out.map(p => [p.project, p.work])).toEqual([['game', false], ['client', true]])
    const game = out[0].boards.find(b => b.board === 'game:game')!
    expect(game).toMatchObject({ title: 'Game', cardPrefix: 'G', flow: { doing: 'doing', done: 'done' }, cards: 2 })
    expect(game.lists.map(l => l.id)).toEqual(['todo', 'doing', 'done', 'old'])
    expect(game.lists.at(-1)).toEqual({ id: 'old', title: 'Old', archived: true })
    expect(out[0].boards.map(b => b.board)).toEqual(['game:game', 'game:game/ideas'])
    // Nothing of a code repo: the tools never reach one.
    expect(JSON.stringify(out)).not.toContain('codeRepo')
  })

  it('finds a card by id on any board, and asks for the board when two projects share the key', async () => {
    const { tools, store, game, ideas } = await setup()
    expect(await tools.getCard('ID-1')).toMatchObject({ id: 'ID-1', board: 'game:game/ideas', title: 'Weather', listTitle: 'To do' })
    await expect(tools.getCard('G-1')).rejects.toThrow(/more than one board.*name the board/)
    expect(await tools.getCard('G-1', 'game:game')).toMatchObject({ title: 'Turrets' })
    expect(await tools.getCard('G-1', 'client:portal')).toMatchObject({ title: 'Login form' })
    await expect(tools.getCard('G-9', 'game:game')).rejects.toThrow('No card G-9 on game:game')
    await expect(tools.getCard('ZZ-1')).rejects.toThrow('No card ZZ-1')
    await expect(tools.getCard('G-1', 'nokey')).rejects.toThrow('Not a board key')
    // A card keeps its id when it moves to another board: still found.
    await store.moveCard(game, 'G-2', ideas, 'todo')
    expect(await tools.getCard('G-2')).toMatchObject({ board: 'game:game/ideas', title: 'Traps' })
  })

  it('searches by id and title, by board and list, archived cards apart', async () => {
    const { tools, store, game } = await setup()
    expect((await tools.searchCards({ query: 'tur' })).cards.map(c => c.id)).toEqual(['G-1'])
    expect((await tools.searchCards({ query: 'g-1' })).cards.map(c => c.board)).toEqual(['game:game', 'client:portal'])
    expect((await tools.searchCards({ board: 'game:game', list: 'todo' })).total).toBe(2)
    await store.updateCard(game, 'G-2', { archived: true })
    expect((await tools.searchCards({ board: 'game:game' })).cards.map(c => c.id)).toEqual(['G-1'])
    expect((await tools.searchCards({ board: 'game:game', archived: true })).cards.map(c => c.id)).toEqual(['G-2'])
  })

  it('moves a card by list id or by flow, stamped by the store, and refuses a list that is not there', async () => {
    const { tools, store, game } = await setup()
    const before = Date.now()
    const moved = await tools.moveCard({ id: 'G-1', board: 'game:game', flow: 'doing' })
    expect(moved).toMatchObject({ list: 'doing', listTitle: 'Doing' })
    expect(Date.parse(moved.updated!)).toBeGreaterThanOrEqual(before)
    // The file has it, as the app writes it.
    expect(fileOf(store, game, 'G-1')).toMatchObject({ list: 'doing', updated: moved.updated })
    expect((await tools.moveCard({ id: 'G-1', board: 'game:game', list: 'done' })).list).toBe('done')
    await expect(tools.moveCard({ id: 'G-1', board: 'game:game', list: 'nope' })).rejects.toThrow('has no list nope (its lists: todo, doing, done, old)')
    await expect(tools.moveCard({ id: 'G-1', board: 'game:game' })).rejects.toThrow('Give either list or flow')
    await store.updateMeta(game, { flow: undefined })
    await expect(tools.moveCard({ id: 'G-1', board: 'game:game', flow: 'done' })).rejects.toThrow('no done list')
    expect(fileOf(store, game, 'G-1').list).toBe('done')
  })

  it('updates only the fields given, checks them, and keeps what it does not know', async () => {
    const { tools, store, game } = await setup()
    // A key the app does not know, as a hand edit leaves it: it survives the tool's write.
    store.board(game).cards.find(c => c.id === 'G-1')!.extra = { estimate: 3 }
    const out = await tools.updateCard({
      id: 'G-1',
      board: 'game:game',
      title: '  Turrets   on walls ',
      description: 'Shoot things.\n\n',
      labels: ['combat', 'combat', ' '],
      links: ['ID-1'],
      due: '2026-11-02',
      complete: true,
      jira: 'spdi-4',
    })
    expect(out).toMatchObject({ title: 'Turrets on walls', description: 'Shoot things.', labels: ['combat'], links: ['ID-1'], due: '2026-11-02', complete: true, jira: 'SPDI-4' })
    const saved = fileOf(store, game, 'G-1')
    expect(saved).toMatchObject({ title: 'Turrets on walls', jira: 'SPDI-4', extra: { estimate: 3 } })
    // Cleared again.
    const cleared = await tools.updateCard({ id: 'G-1', board: 'game:game', due: null, jira: '', complete: false })
    expect(cleared.due).toBeUndefined()
    expect(cleared.jira).toBeUndefined()
    expect(cleared.complete).toBeUndefined()
    await expect(tools.updateCard({ id: 'G-1', board: 'game:game', title: ' ' })).rejects.toThrow('needs a title')
    await expect(tools.updateCard({ id: 'G-1', board: 'game:game', due: 'next week' })).rejects.toThrow('Not a date')
    await expect(tools.updateCard({ id: 'G-1', board: 'game:game', jira: 'not a key' })).rejects.toThrow('Not a Jira key')
    await expect(tools.updateCard({ id: 'G-1', board: 'game:game', links: ['XX-9'] })).rejects.toThrow('No card XX-9')
    await expect(tools.updateCard({ id: 'G-1', board: 'game:game', links: ['G-1'] })).rejects.toThrow('cannot link to itself')
    await expect(tools.updateCard({ id: 'G-1', board: 'game:game' })).rejects.toThrow('Nothing to change')
  })

  it('creates a card in a list, its flow or the first list, and refuses a bad one before writing', async () => {
    const { tools, store, game } = await setup()
    const made = await tools.createCard({ board: 'game:game', title: 'Mines', description: 'Boom', labels: ['combat'], links: ['G-1'], jira: 'spdi-8' })
    expect(made).toMatchObject({ id: 'G-3', list: 'todo', description: 'Boom', labels: ['combat'], links: ['G-1'], jira: 'SPDI-8' })
    expect(fileOf(store, game, 'G-3')).toMatchObject({ title: 'Mines', jira: 'SPDI-8' })
    expect((await tools.createCard({ board: 'game:game', title: 'Now', flow: 'doing' })).list).toBe('doing')
    await expect(tools.createCard({ board: 'game:game', title: 'Bad', list: 'nope' })).rejects.toThrow('has no list nope')
    await expect(tools.createCard({ board: 'game:game', title: 'Bad', due: 'soon' })).rejects.toThrow('Not a date')
    await expect(tools.createCard({ board: 'game:game', title: '' })).rejects.toThrow('needs a title')
    expect(store.board(game).cards.map(c => c.id).sort()).toEqual(['G-1', 'G-2', 'G-3', 'G-4'])
  })

  it('archives (never deletes) and brings a card back, and links and unlinks cards', async () => {
    const { tools, store, game } = await setup()
    expect((await tools.archiveCard({ id: 'G-2', board: 'game:game' })).archived).toBe(true)
    expect(fileOf(store, game, 'G-2').archived).toBe(true)
    expect((await tools.archiveCard({ id: 'G-2', board: 'game:game', archived: false })).archived).toBeUndefined()
    expect((await tools.linkCards({ id: 'G-1', to: 'G-2', board: 'game:game' })).links).toEqual(['G-2'])
    expect((await tools.linkCards({ id: 'G-1', to: 'G-2', board: 'game:game' })).links).toEqual(['G-2'])
    expect(fileOf(store, game, 'G-1').links).toEqual(['G-2'])
    expect((await tools.linkCards({ id: 'G-1', to: 'G-2', board: 'game:game', unlink: true })).links).toEqual([])
    await expect(tools.linkCards({ id: 'G-1', to: 'NO-1', board: 'game:game' })).rejects.toThrow('No card NO-1')
  })
})

describe('the MCP server', () => {
  it('picks the build default port, or CORKBOARD_MCP_PORT', () => {
    expect(mcpPort(true, {})).toBe(MCP_PORT)
    expect(mcpPort(false, {})).toBe(MCP_DEV_PORT)
    expect(MCP_PORT).not.toBe(MCP_DEV_PORT)
    expect(mcpPort(true, { CORKBOARD_MCP_PORT: '5123' })).toBe(5123)
    expect(mcpPort(false, { CORKBOARD_MCP_PORT: 'x' })).toBe(MCP_DEV_PORT)
  })

  it('makes its token once and keeps it, readable by the user only', async () => {
    const token = await mcpToken(userData)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(await mcpToken(userData)).toBe(token)
    if (process.platform !== 'win32') expect(statSync(path.join(userData, 'mcp-token')).mode & 0o077).toBe(0)
  })

  it('serves the tools over HTTP to a client with the token', async () => {
    const { projects, store, game } = await setup()
    const host = new McpHost(() => projects, 'secret')
    await host.start(0)
    try {
      const file = await host.writeConfig(userData)
      const config = JSON.parse(readFileSync(file, 'utf8'))
      expect(config).toEqual(mcpConfig(host.url, 'secret'))
      expect(config.mcpServers.corkboard).toEqual({ type: 'http', url: host.url, headers: { Authorization: 'Bearer secret' } })
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)

      const client = new Client({ name: 'test', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { Authorization: 'Bearer secret' } } }))
      const names = (await client.listTools()).tools.map(t => t.name).sort()
      expect(names).toEqual(['archive_card', 'create_card', 'get_card', 'link_cards', 'list_boards', 'move_card', 'search_cards', 'update_card'])
      const moved = await client.callTool({ name: 'move_card', arguments: { id: 'G-1', board: 'game:game', flow: 'done' } })
      expect(JSON.parse((moved.content as { text: string }[])[0].text)).toMatchObject({ id: 'G-1', list: 'done' })
      expect(fileOf(store, game, 'G-1').list).toBe('done')
      const refused = await client.callTool({ name: 'move_card', arguments: { id: 'G-1', board: 'game:game', list: 'nope' } })
      expect(refused.isError).toBe(true)
      expect((refused.content as { text: string }[])[0].text).toContain('has no list nope')
      await client.close()
    } finally {
      await host.stop()
    }
  })

  it('turns away a wrong token, a foreign host or origin, and other paths', async () => {
    const { projects } = await setup()
    const host = new McpHost(() => projects, 'secret')
    const port = await host.start(0)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const post = (headers: Record<string, string>, urlPath = '/mcp') =>
      request(port, urlPath, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body)
    try {
      expect((await post({})).status).toBe(401)
      expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401)
      expect((await post({ Authorization: 'Bearer secret' }, '/other')).status).toBe(404)
      // DNS rebinding: a page's own name for 127.0.0.1, and a page's origin.
      expect((await post({ Authorization: 'Bearer secret', Host: `evil.example:${port}` })).status).toBe(403)
      expect((await post({ Authorization: 'Bearer secret', Origin: 'http://evil.example' })).status).toBe(403)
      const ok = await post({ Authorization: 'Bearer secret', Origin: `http://localhost:${port}` })
      expect(ok.status).toBe(200)
      expect(ok.text).toContain('list_boards')
    } finally {
      await host.stop()
    }
  })

  it('takes a free port when its own is taken', async () => {
    const { projects } = await setup()
    const squatter = http.createServer()
    await new Promise<void>(r => squatter.listen(0, '127.0.0.1', () => r()))
    const taken = (squatter.address() as { port: number }).port
    const host = new McpHost(() => projects, 'secret')
    try {
      const port = await host.start(taken)
      expect(port).not.toBe(taken)
      expect(host.url).toBe(`http://127.0.0.1:${port}/mcp`)
    } finally {
      await host.stop()
      squatter.close()
    }
  })
})

/** A raw request, so the Host header can be anything (fetch won't let a test set it). */
function request(port: number, urlPath: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, res => {
      let text = ''
      res.on('data', d => (text += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
