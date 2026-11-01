// What the sign-in reaches: the GitHub App's installations, and the repos you gave each one. A
// GitHub App's token sees those repos only, so none installed means the app can do nothing yet.

import { answerJson as json } from './answer'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export type Reach = {
  login: string
  /** `owner/name` of every repo the app is installed on. */
  repos: string[]
}

export async function reach(api: Api): Promise<Reach> {
  const user = await json<{ login: string }>(await api('/user'), 'your account')
  const { installations } = await json<{ installations: { id: number }[] }>(
    await api('/user/installations?per_page=100'),
    'the app’s installations',
  )
  const repos: string[] = []
  for (const { id } of installations) {
    const page = await json<{ repositories: { full_name: string }[] }>(
      await api(`/user/installations/${id}/repositories?per_page=100`),
      'the installed repos',
    )
    repos.push(...page.repositories.map(r => r.full_name))
  }
  return { login: user.login, repos: repos.sort((a, b) => a.localeCompare(b)) }
}
