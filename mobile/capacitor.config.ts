// The Android app around the web build. CapacitorHttp makes `fetch` go through Android's own HTTP
// stack instead of the WebView's: github.com's login endpoints answer no CORS headers, so a web
// page can't call them, and this is what lets the app sign in with no server in between.

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.agaudreau1997.corkboard',
  appName: 'Corkboard',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: { enabled: true },
  },
}

export default config
