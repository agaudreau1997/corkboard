// Reading many files at once through GitHub's GraphQL API, by blob sha: one aliased
// `object(oid:)` per file, up to BATCH a query. A board's list and archived state are only known
// by reading every card file, and one REST call per card would make a 120-card board slow to open.
// A sha names its content, so what's read never goes stale and the cache keys on it.

import { answerJson } from '../github/answer'

export const BATCH = 100

/** The query for a batch of blobs; the shas are checked hex, so they can sit in the query text. */
export function blobsQuery(shas: string[]): string {
  const fields = shas.map((sha, i) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a blob sha: ${sha}`)
    return `b${i}: object(oid: "${sha}") { ... on Blob { text isBinary } }`
  })
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`
}

type Api = (path: string, init?: RequestInit) => Promise<Response>

/** The texts of the blobs, by sha. A blob GitHub can't give as text (binary, too large) is left out. */
export async function readBlobs(api: Api, repo: string, shas: string[]): Promise<Map<string, string>> {
  const [owner, name] = repo.split('/')
  const out = new Map<string, string>()
  for (let start = 0; start < shas.length; start += BATCH) {
    const batch = shas.slice(start, start + BATCH)
    const response = await api('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: blobsQuery(batch), variables: { owner, name } }),
    })
    const answer = await answerJson<{
      data?: { repository?: Record<string, { text?: string | null; isBinary?: boolean } | null> }
      errors?: { message: string }[]
    }>(response, `${repo}'s files`)
    const found = answer.data?.repository
    if (!found) throw new Error(answer.errors?.[0]?.message ?? `GitHub gave none of ${repo}'s files.`)
    batch.forEach((sha, i) => {
      const blob = found[`b${i}`]
      if (blob && !blob.isBinary && typeof blob.text === 'string') out.set(sha, blob.text)
    })
  }
  return out
}
