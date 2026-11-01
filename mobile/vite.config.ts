// The companion's web build, which Capacitor wraps in the Android app. It imports the desktop's
// `src/shared/` as `@shared`, so the phone reads and writes card files exactly as the desktop does.
// `yaml` (which `src/shared/cardfile.ts` imports) is pinned to this folder's own copy: looked up
// from `src/shared/` it would be the desktop's, which a build of the companion alone hasn't
// installed.

import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths: the WebView loads the page from Capacitor's own local origin.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      yaml: resolve(__dirname, 'node_modules/yaml'),
    },
  },
  server: { fs: { allow: ['..'] } },
  test: { include: ['tests/**/*.test.ts'] },
})
