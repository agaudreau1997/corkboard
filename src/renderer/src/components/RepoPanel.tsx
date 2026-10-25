// The code repo panel: a small strip floating at the bottom right of the board, for the code repo
// of the board in this tab (boards can name different ones, so it follows the tab, not the
// project). It says the branch, how far it is ahead of and behind its upstream, and how many files
// are changed and not committed, and pushes and pulls; the main process watches the repo, so a
// commit made in a terminal shows here at once. It stays out of the way: one line, and nothing at
// all for a board with no code repo on this machine.

import { useEffect } from 'react'
import { actions, useStore } from '../state'

export function RepoPanel({ path, codeRepo }: { path: string; codeRepo: string | undefined }) {
  const repo = useStore(s => (s.repo?.path === path ? s.repo : null))

  useEffect(() => {
    void actions.watchRepo(path)
    return () => void actions.watchRepo(null)
  }, [path, codeRepo])

  const status = repo?.status
  if (!status) return null
  const { branch, upstream, ahead, behind, changed } = status
  const diverged = !!upstream && ahead > 0 && behind > 0
  const busy = repo.busy

  let pushTitle = upstream ? `Push ${branch} to ${upstream}` : `Push ${branch} to ${status.remote} and set its upstream`
  if (!branch) pushTitle = 'HEAD is detached: there is no branch to push'
  else if (!status.remote) pushTitle = 'The repo has no remote'
  else if (upstream && !ahead) pushTitle = 'Nothing to push'
  let pullTitle = `Pull ${upstream}, fast-forward only`
  if (!upstream) pullTitle = branch ? `${branch} has no upstream to pull from` : 'HEAD is detached'
  else if (diverged) pullTitle = `${branch} and ${upstream} have diverged: merge or rebase it yourself`

  return (
    <div className="repo-panel" role="group" aria-label="Code repo" title={status.repo}>
      <span className="repo-branch">{branch ?? `detached at ${status.head ?? '?'}`}</span>
      {upstream ? (
        <span className={`repo-counts${diverged ? ' diverged' : ''}`} title={`Against ${upstream}, as of the last fetch`}>
          <span className="repo-ahead" title={`${ahead} commit${ahead === 1 ? '' : 's'} to push`}>
            ↑{ahead}
          </span>
          <span className="repo-behind" title={`${behind} commit${behind === 1 ? '' : 's'} to pull`}>
            ↓{behind}
          </span>
          {diverged && <span>diverged</span>}
        </span>
      ) : (
        branch && <span className="repo-note">{status.remote ? 'no upstream' : 'no remote'}</span>
      )}
      {changed > 0 && (
        <span className="repo-changed" title={`${changed} file${changed === 1 ? '' : 's'} changed and not committed`}>
          {changed} changed
        </span>
      )}
      <button
        className="ghost"
        title={pullTitle}
        disabled={!!busy || !upstream || diverged}
        onClick={() => void actions.pullRepo(path)}
      >
        {busy === 'pull' ? 'Pulling…' : 'Pull'}
      </button>
      <button
        className="ghost"
        title={pushTitle}
        disabled={!!busy || !branch || !status.remote || (!!upstream && !ahead)}
        onClick={() => void actions.pushRepo(path)}
      >
        {busy === 'push' ? 'Pushing…' : 'Push'}
      </button>
    </div>
  )
}
