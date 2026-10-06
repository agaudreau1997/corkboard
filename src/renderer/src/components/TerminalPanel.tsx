import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { PtyInfo, TerminalStatus } from '@shared/types'
import { actions, api, attachTerminalSink, useStore } from '../state'
import { cssToken, onThemeApplied } from '../theme'
import { openContextMenu, type MenuItem } from './ContextMenu'

export function TerminalPanel() {
  const terminals = useStore(s => s.terminals)
  const active = useStore(s => s.activeTerminal)
  const open = useStore(s => s.terminalOpen)
  const height = useStore(s => s.terminalHeight)
  const activeTab = useStore(s => s.activeTab)
  const attention = useStore(s => s.attention)

  return (
    <div className={`terminal-panel${open ? ' open' : ''}`} style={{ height: open ? height : 34 }}>
      {open && <ResizeHandle />}
      <div className="terminal-tabs">
        <button
          className="terminal-toggle"
          onClick={() => useStore.setState(s => ({ terminalOpen: !s.terminalOpen }))}
          title="Toggle terminals (Ctrl+`)"
        >
          {open ? '▾' : '▴'} Terminals
        </button>
        {attention.length > 0 && (
          <button
            className="terminal-finished"
            onClick={() => useStore.setState({ activeTerminal: attention[0], terminalOpen: true })}
            title={
              attention.length === 1
                ? 'Claude finished in a tab you have not looked at: show it'
                : `Claude finished in ${attention.length} tabs you have not looked at: show the first`
            }
          >
            <i className="term-status finished" aria-hidden />
            {attention.length}
          </button>
        )}
        <div className="terminal-tab-scroll">
          {terminals.map(t => (
            <TerminalTab key={t.id} info={t} active={t.id === active} />
          ))}
        </div>
        <button className="ghost small" onClick={() => void actions.newTerminal(activeTab ?? undefined)} title="New shell">
          +
        </button>
      </div>
      <div className="terminal-body" style={{ display: open ? 'block' : 'none' }}>
        {terminals.map(t => (
          <XTerm key={t.id} info={t} visible={open && t.id === active} />
        ))}
        {!terminals.length && (
          <p className="muted pad">
            No terminals. Tackling a card opens one here; + opens a shell in the board's code repo.
          </p>
        )}
      </div>
    </div>
  )
}

function TerminalTab({ info, active }: { info: PtyInfo; active: boolean }) {
  const status = useStore(s => s.terminalStatus[info.id])
  const exitCode = useStore(s => s.exited[info.id])
  const attention = useStore(s => s.attention.includes(info.id))
  const state = tabState(status, exitCode, attention)
  const tab = useRef<HTMLDivElement>(null)
  // The strip scrolls sideways: bring a tab into view when it becomes the one shown.
  useEffect(() => {
    if (active) tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div
      ref={tab}
      className={`terminal-tab${active ? ' active' : ''}${exitCode !== undefined ? ' exited' : ''}${state.kind === 'finished' ? ' attention' : ''}`}
      onClick={() => useStore.setState({ activeTerminal: info.id, terminalOpen: true })}
      // A middle click closes the tab, as in a browser. Otherwise the press would start autoscroll,
      // and the release on Linux would paste the selection into the focused terminal.
      onMouseDown={e => e.button === 1 && e.preventDefault()}
      onMouseUp={e => e.button === 1 && e.preventDefault()}
      onAuxClick={e => {
        if (e.button !== 1) return
        e.preventDefault()
        void actions.requestCloseTerminal(info.id)
      }}
      title={`${info.title}\n${state.label}\n${info.cwd}`}
    >
      <i className={`term-status ${state.kind}`} role="img" aria-label={state.label} />
      <span>{info.title}</span>
      <button
        className="tab-close"
        aria-label="Close terminal"
        title="Close (middle-click the tab)"
        onClick={e => {
          e.stopPropagation()
          void actions.requestCloseTerminal(info.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

type TabState = { kind: TerminalStatus | 'finished' | 'exited' | 'failed'; label: string }

/** What a tab's icon shows: an ended shell first, then Claude's state, a fresh finish standing out. */
function tabState(status: TerminalStatus | undefined, exitCode: number | undefined, attention: boolean): TabState {
  if (exitCode !== undefined)
    return { kind: exitCode === 0 ? 'exited' : 'failed', label: `Ended (exit code ${exitCode})` }
  if (status === 'working') return { kind: 'working', label: 'Claude is working' }
  if (status === 'waiting')
    return attention
      ? { kind: 'finished', label: 'Claude finished: your turn' }
      : { kind: 'waiting', label: 'Claude is waiting for you' }
  return { kind: 'shell', label: 'Shell' }
}

/** The terminal's colours: its panel's background and the accent for the cursor, from the theme. */
function terminalTheme() {
  return {
    background: cssToken('--term-bg') || '#101216',
    foreground: '#d7dae0',
    cursor: cssToken('--accent') || '#f0c674',
    selectionBackground: '#3a4252',
  }
}

// Windows terminals paste on Ctrl+V. Elsewhere it goes to the program, and Claude Code pastes an image
// on it. On macOS, Cmd+C and Cmd+V already copy and paste: xterm answers the Edit menu's events.
const WINDOWS = navigator.userAgent.includes('Windows')
const MAC = navigator.userAgent.includes('Macintosh')
const PASTE_KEY = WINDOWS ? 'Ctrl+V' : 'Ctrl+Shift+V'

/**
 * The keys a terminal keeps from the program: Ctrl+Shift+C and Ctrl+Shift+V, Ctrl+V on Windows,
 * and Ctrl+C while there is a selection (without one it stays the program's interrupt).
 */
function clipboardKey(e: KeyboardEvent, terminal: Terminal): 'copy' | 'paste' | null {
  if (MAC || !e.ctrlKey || e.altKey || e.metaKey) return null
  // keyCode, as xterm reads it, so the key that would send ^C is the one that copies on any layout.
  if (e.keyCode === 67) return e.shiftKey || terminal.hasSelection() ? 'copy' : null
  if (e.keyCode === 86) return e.shiftKey || WINDOWS ? 'paste' : null
  return null
}

/** Copies the selection and clears it, so a second Ctrl+C interrupts, as in Windows Terminal. */
function copySelection(terminal: Terminal) {
  const text = terminal.getSelection()
  if (text) api.clipboard.write(text)
  terminal.clearSelection()
}

/** The menu's paste. Bracketed when the program asks, so a shell does not run a script line by line. */
async function pasteInto(terminal: Terminal) {
  const text = await api.clipboard.read()
  if (text) terminal.paste(text)
}

function terminalMenu(terminal: Terminal): MenuItem[] {
  // The menu's button took the focus: give it back, so typing goes on in the terminal.
  const then = (act: () => unknown) => () => {
    void act()
    terminal.focus()
  }
  return [
    { label: 'Copy', hint: 'Ctrl+C', disabled: !terminal.hasSelection(), onSelect: then(() => copySelection(terminal)) },
    { label: 'Paste', hint: PASTE_KEY, onSelect: then(() => pasteInto(terminal)) },
    'separator',
    { label: 'Select all', onSelect: then(() => terminal.selectAll()) },
  ]
}

function XTerm({ info, visible }: { info: PtyInfo; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const terminal = new Terminal({
      // A Nerd Font first, so prompt themes (starship, powerline) draw their glyphs.
      fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: terminalTheme(),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host.current!)
    term.current = terminal
    fit.current = fitAddon
    terminal.attachCustomKeyEventHandler(e => {
      const action = clipboardKey(e, terminal)
      if (!action) return true
      // A paste is left to the browser: xterm takes its paste event before the next key, where
      // reading the clipboard from here would let a quick Enter overtake it.
      if (action === 'copy' && e.type === 'keydown') {
        e.preventDefault()
        copySelection(terminal)
      }
      return false
    })
    const input = terminal.onData(data => api.pty.write(info.id, data))
    const detach = attachTerminalSink(info.id, data => terminal.write(data))
    const observer = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return
      try {
        fitAddon.fit()
        api.pty.resize(info.id, terminal.cols, terminal.rows)
      } catch {
        /* not laid out yet */
      }
    })
    observer.observe(host.current!)
    const retheme = onThemeApplied(() => (terminal.options.theme = terminalTheme()))
    return () => {
      retheme()
      observer.disconnect()
      input.dispose()
      detach()
      terminal.dispose()
    }
  }, [info.id])

  useEffect(() => {
    if (!visible || !term.current || !fit.current) return
    requestAnimationFrame(() => {
      try {
        fit.current!.fit()
        api.pty.resize(info.id, term.current!.cols, term.current!.rows)
        term.current!.focus()
      } catch {
        /* hidden */
      }
    })
  }, [visible, info.id])

  return (
    <div
      className="xterm-host"
      ref={host}
      style={{ display: visible ? 'block' : 'none' }}
      data-pty={info.id}
      onContextMenu={e => term.current && openContextMenu(e, terminalMenu(term.current))}
    />
  )
}

function ResizeHandle() {
  return (
    <div
      className="resize-y"
      onPointerDown={e => {
        const startY = e.clientY
        const start = useStore.getState().terminalHeight
        const move = (ev: PointerEvent) =>
          useStore.setState({
            terminalHeight: Math.min(window.innerHeight - 160, Math.max(140, start - (ev.clientY - startY))),
          })
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    />
  )
}
