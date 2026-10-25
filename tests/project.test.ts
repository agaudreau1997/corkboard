import { describe, expect, it } from 'vitest'
import {
  mergeProjectSettings,
  isIcon,
  namesKey,
  normalizeKey,
  parseProjectSettings,
  patchSettings,
  projectSettingsText,
} from '@shared/project'

describe('project.json', () => {
  it('reads the work flag and nothing else; broken JSON is undefined', () => {
    expect(parseProjectSettings('{ "work": true }')).toEqual({ work: true })
    expect(parseProjectSettings('{ "work": false }')).toEqual({})
    expect(parseProjectSettings('{ "work": "yes", "jira": "https://x" }')).toEqual({})
    expect(parseProjectSettings('{}')).toEqual({})
    expect(parseProjectSettings('[]')).toBeUndefined()
    expect(parseProjectSettings('{ "work": tr')).toBeUndefined()
  })

  it('writes the flag, keeps keys it does not know, and writes no file for nothing', () => {
    expect(projectSettingsText({ work: true })).toBe('{\n  "work": true\n}\n')
    expect(projectSettingsText({})).toBeNull()
    expect(projectSettingsText({ work: false })).toBeNull()
    // A newer build's setting survives a toggle on this one.
    const previous = '{ "work": true, "jira": { "site": "https://example.atlassian.net" } }\n'
    expect(JSON.parse(projectSettingsText({}, previous)!)).toEqual({ jira: { site: 'https://example.atlassian.net' } })
    expect(JSON.parse(projectSettingsText({ work: true }, '{ "work": false, "x": 1 }')!)).toEqual({ work: true, x: 1 })
    expect(projectSettingsText({ work: true }, 'not json')).toBe('{\n  "work": true\n}\n')
  })

  it('reads, writes and keeps an icon that is an image data URI', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo='
    expect(isIcon(icon)).toBe(true)
    expect(isIcon('https://example.com/icon.png')).toBe(false)
    expect(isIcon('data:text/html;base64,PGI+')).toBe(false)
    expect(parseProjectSettings(JSON.stringify({ icon }))).toEqual({ icon })
    expect(parseProjectSettings('{ "icon": "javascript:alert(1)" }')).toEqual({})
    const text = projectSettingsText({ work: true, icon }, '{ "x": 1 }')!
    expect(text.indexOf('"work"')).toBeLessThan(text.indexOf('"icon"'))
    expect(parseProjectSettings(text)).toEqual({ work: true, icon })
    expect(JSON.parse(text)).toEqual({ work: true, icon, x: 1 })
    // Cleared, the icon goes and what else the file holds stays.
    expect(JSON.parse(projectSettingsText({ work: true }, text)!)).toEqual({ work: true, x: 1 })
  })

  it('patches the settings: a key given replaces, null clears, one left out stays', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo='
    expect(patchSettings({ work: true }, { icon })).toEqual({ work: true, icon })
    expect(patchSettings({ work: true, icon }, { icon: null })).toEqual({ work: true })
    expect(patchSettings({ work: true, icon }, { work: false })).toEqual({ icon })
    expect(patchSettings({ icon }, {})).toEqual({ icon })
  })

  it('merges both sides of a conflict, this machine first', () => {
    const merged = mergeProjectSettings('{ "work": true, "a": 1 }', '{ "work": false, "b": 2 }')
    expect(JSON.parse(merged!)).toEqual({ work: false, a: 1, b: 2 })
    expect(mergeProjectSettings('{', '{}')).toBeUndefined()
  })
})

describe('Jira keys', () => {
  it('are found whole in a message, not inside a longer key', () => {
    expect(namesKey('ABC-12 Fix the login', 'ABC-12')).toBe(true)
    expect(namesKey('Fix the login (ABC-12)', 'ABC-12')).toBe(true)
    expect(namesKey('Fix the login\n\nRefs: abc-12', 'ABC-12')).toBe(true)
    expect(namesKey('ABC-123 Fix the login', 'ABC-12')).toBe(false)
    expect(namesKey('XABC-12 Fix the login', 'ABC-12')).toBe(false)
    expect(namesKey('ABC-1234', 'ABC-123')).toBe(false)
  })

  it('are kept trimmed and upper case', () => {
    expect(normalizeKey(' spdi-42 ')).toBe('SPDI-42')
    expect(normalizeKey('')).toBeUndefined()
    expect(normalizeKey('   ')).toBeUndefined()
    expect(normalizeKey(undefined)).toBeUndefined()
  })
})
