// The app's MCP server: the board tools (mcptools.ts) over Streamable HTTP, for the Claude
// sessions the app starts in a terminal or a worktree, which get its URL and token through
// `--mcp-config`.
//
// It listens on 127.0.0.1 only, and every request needs the bearer token the app made once and
// keeps in its user data, compared in constant time. A web page in a browser on this machine can
// reach a loopback port too (DNS rebinding: a name of the page's that resolves to 127.0.0.1), so a
// request whose Host is not this server's loopback address, or that comes with any Origin but
// this server's own, is turned away before the token is even looked at. The token never goes into
// a log, nor into argv: the sessions get the path of a config file only the user can read.
//
// The port is fixed, so a URL written into Claude Code's user config (CORK-79) keeps working
// across restarts: one for the installed app and another for an unpackaged build, so the two run
// side by side. When it is taken the server takes any free port: the sessions the app starts are
// told the port of the moment, a user config isn't.
//
// The server is stateless (one MCP server and transport per request): the tools keep no state of
// their own, and nothing has to be cleaned up when a session goes away.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { z } from 'zod'
import { BoardTools, type ToolProjects } from './mcptools'

/** The port of the installed app's server, and of an unpackaged (dev) build's. */
export const MCP_PORT = 47823
export const MCP_DEV_PORT = 47824
/** The name the server goes by in a session's config (and in a user config, CORK-79). */
export const MCP_NAME = 'corkboard'
const TOKEN_FILE = 'mcp-token'

/** The port to ask for: CORKBOARD_MCP_PORT (the tests' seam) or the build's own default. */
export function mcpPort(packaged: boolean, env = process.env): number {
  const wanted = Number(env.CORKBOARD_MCP_PORT)
  if (Number.isInteger(wanted) && wanted > 0 && wanted < 65536) return wanted
  return packaged ? MCP_PORT : MCP_DEV_PORT
}

/** The token in the user data folder, made the first time: 32 random bytes, readable by the user only. */
export async function mcpToken(userData: string): Promise<string> {
  const file = path.join(userData, TOKEN_FILE)
  try {
    const saved = (await fs.readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(saved)) return saved
  } catch {
    /* first run */
  }
  const token = randomBytes(32).toString('hex')
  await fs.mkdir(userData, { recursive: true })
  await fs.writeFile(file, `${token}\n`, { mode: 0o600 })
  return token
}

/** Claude Code's config for the server, as `claude mcp add --transport http` would write it. */
export function mcpConfig(url: string, token: string): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { [MCP_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }
}

export class McpHost {
  private server?: http.Server
  private tools: BoardTools
  private digest: Buffer
  port = 0

  constructor(
    projects: ToolProjects,
    private token: string,
    private version = '0',
  ) {
    this.tools = new BoardTools(projects)
    this.digest = sha256(`Bearer ${token}`)
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  /** Listens on the port asked for, or on a free one when that is taken; answers the port it got. */
  async start(port: number): Promise<number> {
    const server = http.createServer((req, res) => void this.handle(req, res))
    try {
      await listen(server, port)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw error
      console.warn(`The MCP server's port ${port} is taken: it listens on a free one instead.`)
      await listen(server, 0)
    }
    this.server = server
    this.port = (server.address() as AddressInfo).port
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /**
   * Writes the config a session is given into `dir`, readable by the user only, and answers its
   * path. One file per port: an installed app and a dev build may share the user data folder.
   */
  async writeConfig(dir: string): Promise<string> {
    const file = path.join(dir, `mcp-config-${this.port}.json`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(mcpConfig(this.url, this.token), null, 2)}\n`, { mode: 0o600 })
    // A file made by an earlier run keeps its mode on a rewrite.
    await fs.chmod(file, 0o600).catch(() => {})
    return file
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const refusal = this.refuse(req)
      if (refusal) return reply(res, refusal.status, refusal.message, refusal.headers)
      if (req.method !== 'POST') return reply(res, 405, 'Method not allowed: this server is stateless.', { Allow: 'POST' })
      const mcp = this.mcpServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      console.error('MCP request:', (error as Error).message)
      if (!res.headersSent) reply(res, 500, 'Internal error')
    }
  }

  /** Why a request is turned away, before anything of it is read: wrong path, host, origin or token. */
  private refuse(req: http.IncomingMessage): { status: number; message: string; headers?: Record<string, string> } | undefined {
    const url = (req.url ?? '').split('?')[0]
    if (url !== '/mcp') return { status: 404, message: 'Not found' }
    const loopback = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    if (!loopback.includes(req.headers.host ?? '')) return { status: 403, message: 'Forbidden host' }
    const origin = req.headers.origin
    if (origin !== undefined && !loopback.some(h => origin === `http://${h}`)) return { status: 403, message: 'Forbidden origin' }
    if (!timingSafeEqual(sha256(req.headers.authorization ?? ''), this.digest)) {
      return { status: 401, message: 'Unauthorized', headers: { 'WWW-Authenticate': 'Bearer' } }
    }
    return undefined
  }

  /** The MCP server for one request, with every tool on it. */
  private mcpServer(): McpServer {
    const mcp = new McpServer({ name: MCP_NAME, version: this.version })
    registerTools(mcp, this.tools)
    return mcp
  }
}

const id = z.string().describe('The card id, e.g. CORK-12.')
const board = z.string().describe('The board key (<project>:<path>, from list_boards); only needed when an id is on more than one board.')
const flow = z.enum(['doing', 'done']).describe("The board's flow list instead of a list id: doing or done.")
const labels = z.array(z.string()).describe('The labels, replacing the ones the card has.')
const links = z.array(z.string()).describe('Ids of related cards, replacing the ones it has.')

/** The tools on a server: each answers JSON, the card as it now is for a change. */
export function registerTools(mcp: McpServer, tools: BoardTools): void {
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
    }
  }
  mcp.registerTool(
    'list_boards',
    {
      description: 'The projects open in Corkboard and their boards: each board key, card id prefix, lists (id and title) and flow (the doing and done lists).',
      annotations: { readOnlyHint: true },
    },
    () => run(() => tools.listBoards()),
  )
  mcp.registerTool(
    'get_card',
    {
      description: 'A card by id, on any board: title, list, description, labels, links, due, jira, updated.',
      inputSchema: { id, board: board.optional() },
      annotations: { readOnlyHint: true },
    },
    a => run(() => tools.getCard(a.id, a.board)),
  )
  mcp.registerTool(
    'search_cards',
    {
      description: 'Cards whose id or title contains the query (any case), on one board or all of them, optionally in one list. Archived cards only with archived: true.',
      inputSchema: {
        query: z.string().optional(),
        board: z.string().optional().describe('A board key, from list_boards.'),
        list: z.string().optional().describe('A list id of that board.'),
        archived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    a => run(() => tools.searchCards(a)),
  )
  mcp.registerTool(
    'move_card',
    {
      description: "Moves a card to another list of its board, given as a list id or as the board's flow (doing, done). It goes to the end of the list.",
      inputSchema: { id, board: board.optional(), list: z.string().optional().describe('A list id of the board.'), flow: flow.optional() },
    },
    a => run(() => tools.moveCard(a)),
  )
  mcp.registerTool(
    'update_card',
    {
      description: 'Changes a card: only the fields given. due and jira take null (or an empty string) to clear them.',
      inputSchema: {
        id,
        board: board.optional(),
        title: z.string().optional(),
        description: z.string().optional().describe('The Markdown description, replacing the one it has.'),
        labels: labels.optional(),
        links: links.optional(),
        due: z.string().nullable().optional().describe('A date (2026-11-02) or an ISO time.'),
        complete: z.boolean().optional(),
        jira: z.string().nullable().optional().describe('The Jira issue key, e.g. SPDI-42.'),
      },
    },
    a => run(() => tools.updateCard(a)),
  )
  mcp.registerTool(
    'create_card',
    {
      description: "A new card on a board, in the list given (or the flow's list, or the board's first list). Its id comes from the board.",
      inputSchema: {
        board: z.string().describe('The board key, from list_boards.'),
        title: z.string(),
        list: z.string().optional().describe('A list id of the board.'),
        flow: flow.optional(),
        description: z.string().optional(),
        labels: labels.optional(),
        links: links.optional(),
        due: z.string().optional(),
        jira: z.string().optional(),
      },
    },
    a => run(() => tools.createCard(a)),
  )
  mcp.registerTool(
    'archive_card',
    {
      description: 'Archives a card (archived: false brings it back). Cards are never deleted.',
      inputSchema: { id, board: board.optional(), archived: z.boolean().optional() },
    },
    a => run(() => tools.archiveCard(a)),
  )
  mcp.registerTool(
    'link_cards',
    {
      description: 'Links a card to another (the link is kept on the first card), or removes that link with unlink: true.',
      inputSchema: { id, to: z.string().describe('The id of the card to link to.'), board: board.optional(), unlink: z.boolean().optional() },
    },
    a => run(() => tools.linkCards(a)),
  )
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once('error', failed)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed)
      resolve()
    })
  })
}

function reply(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(message)
}
