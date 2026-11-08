// The project settings' *Suggest from the code repo*: a headless Claude session reads the code
// repo and proposes the project's colours and its icon (src/main/suggest.ts). The panel covers the
// settings while it thinks, so what is being waited for is where the button was, and the settings
// keep their fields underneath; the window wears the suggested theme as soon as it comes, the way
// it wears the colours as they are picked by hand.
//
// Nothing is written until *Accept*, which writes `theme.json` and the icon in `project.json` and
// hands both back to the settings, so the form shows what is now on disk.

import { useEffect, useState } from 'react'
import { shownColor, THEME_COLORS } from '@shared/theme'
import type { ProjectTheme, ThemeSuggestion } from '@shared/types'
import { actions, api, errorText, useStore } from '../state'
import { iconFromData, ProjectMark } from './ProjectMark'

export function SuggestTheme({
  id,
  name,
  onAccept,
  onClose,
}: {
  id: string
  name: string
  /** The suggestion, once it is written: the settings take it as their own. */
  onAccept: (theme: ProjectTheme, icon: string | undefined) => void
  onClose: () => void
}) {
  const [suggestion, setSuggestion] = useState<ThemeSuggestion>()
  /** The icon as it would be kept: scaled down here, the way the picker scales a chosen image. */
  const [icon, setIcon] = useState<string>()
  const [iconError, setIconError] = useState<string>()
  const [error, setError] = useState<string>()
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const answer = await api.projects.suggestTheme(id)
        if (!live) return
        setSuggestion(answer)
        setIconError(answer.iconError)
        if (!answer.icon) return
        try {
          const scaled = await iconFromData(answer.icon, answer.iconPath ?? 'that image')
          if (live) setIcon(scaled)
        } catch (failure) {
          if (live) setIconError(errorText(failure))
        }
      } catch (failure) {
        if (live) setError(errorText(failure))
      }
    })()
    return () => {
      live = false
    }
  }, [id])

  // The whole window shows the suggested colours while they are on screen, as the settings show
  // the ones being picked; the settings put their own back when this closes.
  useEffect(() => {
    if (suggestion) useStore.setState({ themePreview: { projectId: id, theme: suggestion.theme } })
  }, [id, suggestion])
  useEffect(() => () => useStore.setState({ themePreview: null }), [])

  const accept = async () => {
    if (!suggestion) return
    setWriting(true)
    try {
      await api.projects.setTheme(id, suggestion.theme)
      if (icon) await api.projects.setSettings(id, { icon })
      await actions.refreshTree()
      onAccept(suggestion.theme, icon)
    } catch (failure) {
      setWriting(false)
      actions.toast(errorText(failure), 'error')
    }
  }

  return (
    <div className="suggest">
      <h2>
        Colours from the code repo <span className="modal-scope">· {name}</span>
      </h2>
      {!suggestion && !error && (
        <p className="suggest-waiting">
          <span className="suggest-spinner" aria-hidden="true" />
          Claude is reading the code repo for {name}'s colours and its icon. It can take a minute.
        </p>
      )}
      {error && <p className="suggest-error">{error}</p>}
      {suggestion && (
        <>
          <div className="suggest-head">
            <span className="icon-preview">
              <ProjectMark project={{ icon, theme: suggestion.theme }} always />
            </span>
            <div>
              <strong>{suggestion.theme.name ?? 'The repo’s colours'}</strong>
              <div className="suggest-lead">
                {icon ? 'The icon it found, and the colours' : 'The colours'} the project would wear
              </div>
            </div>
          </div>
          {suggestion.notes && <p className="suggest-notes">{suggestion.notes}</p>}
          <div className="suggest-colors">
            {THEME_COLORS.map(({ key, label }) => {
              const own = suggestion.theme.colors[key]
              return (
                <div key={key} className={`suggest-color${own ? '' : ' auto'}`}>
                  <i style={{ background: shownColor(suggestion.theme, key) }} />
                  <span>{label}</span>
                  <code>{own ?? 'auto'}</code>
                </div>
              )
            })}
          </div>
          {suggestion.iconPath && (
            <small className="muted">
              Icon: <code>{suggestion.iconPath}</code>
              {iconError ? ` — ${iconError} The colours can still be accepted.` : ', in the code repo.'}
            </small>
          )}
          <small className="muted">
            The window is wearing them now; nothing is written until you accept.{' '}
            {icon ? 'Accepting writes theme.json and the icon in project.json' : 'Accepting writes theme.json'} in the
            board repo, so every machine gets them.
          </small>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="ghost" disabled={writing} onClick={onClose}>
          {suggestion ? 'Cancel' : 'Close'}
        </button>
        {suggestion && (
          <button type="button" className="accent" disabled={writing} onClick={() => void accept()}>
            {writing ? 'Writing…' : 'Accept'}
          </button>
        )}
      </div>
    </div>
  )
}
