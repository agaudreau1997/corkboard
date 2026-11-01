// The GitHub App the companion signs in through. Its client id isn't a secret (the device flow
// needs none), so it sits here; a fork registers its own app (docs/development.md) and builds with
// VITE_GITHUB_CLIENT_ID and VITE_GITHUB_APP_SLUG set.

export const GITHUB_APP = {
  clientId: import.meta.env.VITE_GITHUB_CLIENT_ID || 'Iv23liGdRp70HwAdl1r8',
  slug: import.meta.env.VITE_GITHUB_APP_SLUG || 'corkboard-companion',
}

/** Where you pick the repos the app may touch: your board repos, never your code repos. */
export function installUrl(slug = GITHUB_APP.slug): string {
  return `https://github.com/apps/${slug}/installations/new`
}
