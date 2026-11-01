// Where the tokens live on the phone: the secure storage plugin, which encrypts them with a key
// held in Android's keystore. Never the WebView's localStorage, which any script in the page reads.

import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { Tokens } from './auth'
import type { TokenStore } from './session'

const KEY = 'github-tokens'

export function secureTokenStore(): TokenStore {
  // Set before any read or write: the prefix keeps the app's keys apart from other plugins' data.
  const ready = SecureStorage.setKeyPrefix('corkboard_')
  return {
    async load() {
      await ready
      const text = await SecureStorage.getItem(KEY)
      if (!text) return undefined
      try {
        const tokens = JSON.parse(text) as Tokens
        return typeof tokens.access === 'string' ? tokens : undefined
      } catch {
        return undefined
      }
    },
    async save(tokens) {
      await ready
      await SecureStorage.setItem(KEY, JSON.stringify(tokens))
    },
    async clear() {
      await ready
      await SecureStorage.removeItem(KEY)
    },
  }
}
