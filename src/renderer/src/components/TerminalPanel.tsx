import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { PtyInfo, TerminalStatus } from '@shared/types'
import { actions, api, attachTerminalSink, useStore } from '../state'

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
      title={`${info.title}\n${state.label}\n${info.cwd}`}
    >
      <i className={`term-status ${state.kind}`} role="img" aria-label={state.label} />
      <span>{info.title}</span>
      <button
        className="tab-close"
        aria-label="Close terminal"
        onClick={e => {
          e.stopPropagation()
          actions.closeTerminal(info.id)
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
