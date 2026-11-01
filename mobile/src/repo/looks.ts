// How a board repo looks: its colours (`theme.json`) and its settings (`project.json`: its icon and
// its main board), both at the repo's root. The open repo's are read with its tree; the repo list
// needs every repo's, so it asks GitHub for all their two files' shas in one GraphQL query and
// reads only the files whose sha changed. Each repo's look is kept parsed, with the shas it was
// read from, apart from the blob cache: the list draws at once, offline too, and a repo's look
// outlives the snapshots the blob cache is trimmed to.

import { parseProjectSettings, PROJECT_FILE } from '@shared/project'
import { parseTheme, THEME_FILE } from '@shared/theme'
import type { ProjectSettings, ProjectTheme } from '@shared/types'
import { answerJson } from '../github/answer'
import { readBlobs } from './blobs'
import type { RepoCache } from './cache'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export type Look = {
  /** The blob shas of `theme.json` and `project.json` as read; absent, the repo has no such file. */
  shas: { theme?: string; project?: string }
  theme?: ProjectTheme
  settings: ProjectSettings
}

/** The two files' shas, as a tree or a query names them. */
export type LookShas = Look['shas']

/** The shas of `theme.json` and `project.json` among a tree's entries. */
export function rootShas(entries: { path: string; type: string; sha: string }[]): LookShas {
  const sha = (path: string) => entries.find(e => e.path === path && e.type === 'blob')?.sha
  return { theme: sha(THEME_FILE), project: sha(PROJECT_FILE) }
}

/**
 * The repo's look at those shas: the kept one's parts that didn't change, else the files as `text`
 * gives them by sha. A file GitHub couldn't give reads as absent.
 */
export function lookAt(shas: LookShas, kept: Look | undefined, text: (sha: string) => string | undefined): Look {
  const same = (k: keyof LookShas) => kept && kept.shas[k] === shas[k]
  const theme = same('theme') ? kept!.theme : shas.theme ? parseTheme(text(shas.theme) ?? '') : undefined
  const settings = same('project')
    ? kept!.settings
    : ((shas.project && parseProjectSettings(text(shas.project) ?? '')) || {})
  return { shas, ...(theme ? { theme } : {}), settings }
}

/** The shas of the files the kept look didn't read. */
export function unread(shas: LookShas, kept: Look | undefined): string[] {
  return (['theme', 'project'] as const).flatMap(k => (shas[k] && kept?.shas[k] !== shas[k] ? [shas[k]!] : []))
}

/** Reads a repo's look at the shas its tree names, reading only the files that changed, and keeps it. */
export async function readLook(api: Api, cache: RepoCache, repo: string, shas: LookShas): Promise<Look> {
  const kept = cache.look(repo)
  const wanted = unread(shas, kept)
  const texts = wanted.length ? await readBlobs(api, repo, wanted) : new Map<string, string>()
  const look = lookAt(shas, kept, sha => texts.get(sha))
  cache.putLook(repo, look)
  return look
}

/** Repos a shas query asks about at once. */
const PER_QUERY = 50

/** The query for the two root files' shas of each repo, on its default branch (`HEAD`). */
export function shasQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$o${i}: String!, $n${i}: String!`)
  const file = (alias: string, name: string) => `${alias}: object(expression: "HEAD:${name}") { oid }`
  const repos = Array.from(
    { length: count },
    (_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ${file('theme', THEME_FILE)} ${file('project', PROJECT_FILE)} }`,
  )
  return `query(${vars.join(', ')}) { ${repos.join(' ')} }`
}

/**
 * Every repo's look, refreshed: one query for the shas (per 50 repos), then a read of the files
 * that changed. A repo GitHub doesn't answer for keeps its kept look, or none.
 */
export async function readLooks(api: Api, cache: RepoCache, repos: string[]): Promise<Map<string, Look>> {
  const out = new Map<string, Look>()
  for (let start = 0; start < repos.length; start += PER_QUERY) {
    const batch = repos.slice(start, start + PER_QUERY)
    const variables = Object.fromEntries(
      batch.flatMap((repo, i) => {
        const [owner, name] = repo.split('/')
        return [
          [`o${i}`, owner],
          [`n${i}`, name],
        ]
      }),
    )
    const response = await api('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: shasQuery(batch.length), variables }),
    })
    type Found = { theme?: { oid: string } | null; project?: { oid: string } | null } | null
    const answer = await answerJson<{ data?: Record<string, Found> | null }>(response, 'your repos’ settings')
    for (const [i, repo] of batch.entries()) {
      const found = answer.data?.[`r${i}`]
      if (found) out.set(repo, await readLook(api, cache, repo, { theme: found.theme?.oid, project: found.project?.oid }))
      else {
        const kept = cache.look(repo)
        if (kept) out.set(repo, kept)
      }
    }
  }
  return out
}
