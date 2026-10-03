import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { PtyInfo } from '@shared/types'
import { actions, api, attachTerminalSink, useStore } from '../state'

export function TerminalPanel() {
  const terminals = useStore(s => s.terminals)
  const active = useStore(s => s.activeTerminal)
  const open = useStore(s => s.terminalOpen)
  const height = useStore(s => s.terminalHeight)
  const exited = useStore(s => s.exited)
  const activeTab = useStore(s => s.activeTab)

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
        <div className="terminal-tab-scroll">
        {terminals.map(t => (
          <div
            key={t.id}
            className={`terminal-tab${t.id === active ? ' active' : ''}${t.id in exited ? ' exited' : ''}`}
            onClick={() => useStore.setState({ activeTerminal: t.id, terminalOpen: true })}
            title={`${t.title}\n${t.cwd}`}
          >
            <span>{t.title}</span>
            <button
              className="tab-close"
              aria-label="Close terminal"
              onClick={e => {
                e.stopPropagation()
                actions.closeTerminal(t.id)
              }}
            >
              ×
            </button>
          </div>
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
      theme: { background: '#101216', foreground: '#d7dae0', cursor: '#f0c674', selectionBackground: '#3a4252' },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host.current!)
    term.current = terminal
    fit.current = fitAddon
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
    return () => {
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

  return <div className="xterm-host" ref={host} style={{ display: visible ? 'block' : 'none' }} data-pty={info.id} />
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
