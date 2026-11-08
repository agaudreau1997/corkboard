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
    invalidate(): Promise<void>
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

/** The session the hooks run in, as `session.start` describes it. */
export type SessionStart = { cwd: string; surface: string | null; interactive: boolean }

/** A hook: answer for itself by returning, or call `next` to let the rest of the chain run. */
export type Hook<Event, Result = Event> = (
  $: Engine,
  e: Event,
  next: (e: Event) => Promise<Result>,
) => Promise<Result>

/** What `register` is handed: `on(event, hook)` adds a hook. */
export type On = {
  (event: 'session.start', hook: Hook<SessionStart>): void
  (event: string, hook: Hook<Record<string, unknown>, unknown>): void
}
