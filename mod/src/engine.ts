// The slice of Claude Code's plugin API the mod is written against, declared by hand.
//
// The authoritative declarations come from `/plugin-types` in a session, which writes
// `claude-code.d.ts` from the running build; that command is not in every build (2.1.263 answers
// "Unknown command"), and the file it writes is per-build, so the mod carries its own narrow
// version instead and the typecheck needs no Claude Code. Every method named here is one a probe
// has watched answer: see `docs/development.md`, *The companion mod*, for how to probe a build.
//
// The engine is only ever reached as `$.noun.method(...)` at the call site. Binding `$` to a
// name, passing it to a function or reading a method off it without calling it makes the module
// fail to load, so a helper of the mod's never takes `$`: it builds what a call needs, or reads
// what a call answered.

/** What `$.process.run` answers. */
export type RunResult = { exitCode: number; stdout: string; stderr: string }

/** A file, as `$.fs.stat` describes it. */
export type FileStat = { kind: 'file' | 'directory'; size: number; mtimeMs: number }

/** The engine, as the hook's first argument. */
export type Engine = {
  process: { run(argv: string[]): Promise<RunResult> }
  fs: {
    readFile(path: string): Promise<string>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<FileStat>
  }
  mcp: { call(server: string, tool: string, args: unknown): Promise<unknown> }
  ui: {
    log(text: string): Promise<void>
    status(text: string): Promise<void>
    notice(text: string): Promise<void>
    toast(text: string): Promise<void>
    /** Asks for the event's sites to be drawn again; it answers nothing, and throws on a bad name. */
    invalidate(event: 'ui.render' | 'prompt.section' | 'prompt.context' | 'tool.describe'): void
    /** The elements of the surface the render event is on, as JSX tags. */
    resolve(e: unknown): Promise<Elements>
  }
  session: {
    id(): Promise<string>
    cwd(): Promise<string>
    model(): Promise<string>
    messages(): Promise<{ role: string; text: string }[]>
  }
  clock: {
    now(): Promise<number>
    every(ms: number, run: () => void): Promise<unknown>
    after(ms: number, run: () => void): Promise<unknown>
  }
  store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
}

/**
 * The elements a surface draws, which `$.ui.resolve` answers. The terminal's table holds Box,
 * Button, Input, Link, Select, Svg, Text, b, div and span; the mod draws with three of them. A
 * Button is `{ key, label, onPress }` and keeps its handler here, which the engine says in so
 * many words when one is drawn without it.
 */
export type Elements = {
  Box: unknown
  Text: unknown
  Button: unknown
}

declare global {
  /** The JSX factory a hooks module is given as a global; the mod calls it rather than writing JSX. */
  const h: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
}

/** The session the hooks run in, as `session.start` describes it. */
export type SessionStart = { cwd: string; surface: string | null; interactive: boolean }

/** What a `ui.render` hook is handed: which component is being drawn, and where. */
export type UiRender = {
  component: string
  surface: 'terminal' | 'desktop'
  requestId?: string
  props?: Record<string, unknown>
  viewport?: { columns: number; rows: number }
}

/** A hook: answer for itself by returning, or call `next` to let the rest of the chain run. */
export type Hook<Event, Result = Event> = (
  $: Engine,
  e: Event,
  next: (e: Event) => Promise<Result>,
) => Promise<Result>

/** What `register` is handed: `on(event, hook)` adds a hook. */
export type On = {
  (event: 'session.start', hook: Hook<SessionStart>): void
  (event: 'ui.render', hook: Hook<UiRender, unknown>): void
  (event: string, hook: Hook<Record<string, unknown>, unknown>): void
}
