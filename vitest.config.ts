import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // The store and sync tests run git dozens of times, and the Windows shell test starts a
  // PowerShell per case, which takes seconds on a machine and far longer on a loaded CI runner:
  // they went past the 5 s default, then past 30 s (a test) and 10 s (a hook) in CI.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 30_000 },
})
