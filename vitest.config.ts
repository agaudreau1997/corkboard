import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // The store and sync tests run git dozens of times, which takes seconds on Windows: a test there
  // went past the 5 s default.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
})
