import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_ICON_BYTES, parseSuggestion, suggestedIcon, suggestPrompt } from '@shared/suggest'
import { readIcon } from '../src/main/suggest'

/** The smallest PNG there is: the icon picker and the suggestion both read it as an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

const answer = {
  name: 'Lantern',
  colors: { background: '#101418', surface: '#1B2027', text: '#E6EAF0', accent: '#F5A623' },
  icon: 'build/icon.png',
  notes: 'The custom properties in src/app.css, and the favicon.',
}

describe('the prompt', () => {
  it('names the project and asks for the colours as JSON', () => {
    const prompt = suggestPrompt('Moon base')
    expect(prompt).toContain('"Moon base"')
    expect(prompt).toContain('"colors"')
    expect(prompt).toContain('#rrggbb')
    // The shapes the app can read, and the one it cannot.
    expect(prompt).toContain('PNG, JPEG, GIF, WebP or ICO')
    expect(prompt).toContain('an SVG is no use here')
  })
})

describe('reading an answer', () => {
  it('takes the colours, the icon and the notes', () => {
    const suggestion = parseSuggestion(JSON.stringify(answer))!
    expect(suggestion.theme).toEqual({
      name: 'Lantern',
      colors: { background: '#101418', surface: '#1b2027', text: '#e6eaf0', accent: '#f5a623' },
    })
    expect(suggestion.iconPath).toBe('build/icon.png')
    expect(suggestion.notes).toBe('The custom properties in src/app.css, and the favicon.')
  })

  it('finds the object in a fenced block, with a sentence around it', () => {
    const text = `Here's what the repo uses:\n\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\`\n\nThe README's badges agree.`
    expect(parseSuggestion(text)?.theme.colors.accent).toBe('#f5a623')
  })

  it('finds the object in a sentence with no fence', () => {
    expect(parseSuggestion(`The colours are {"colors": {"accent": "#ABC"}} as far as I can tell.`)?.theme.colors)
      .toEqual({ accent: '#aabbcc' })
  })

  it('reads the colours nested under a theme, as a session may answer them', () => {
    const suggestion = parseSuggestion(JSON.stringify({ theme: { colors: { accent: '#f00' } }, icon: 'logo.png' }))
    expect(suggestion?.theme.colors.accent).toBe('#ff0000')
    expect(suggestion?.iconPath).toBe('logo.png')
  })

  it('drops a colour that is not a hex, and keeps the rest', () => {
    const suggestion = parseSuggestion(JSON.stringify({ colors: { background: 'rebeccapurple', accent: '#f5a623' } }))
    expect(suggestion?.theme.colors).toEqual({ accent: '#f5a623' })
  })

  it('is no answer at all when nothing it can use came back', () => {
    expect(parseSuggestion('')).toBeUndefined()
    expect(parseSuggestion('I could not find any colours in this repo.')).toBeUndefined()
    expect(parseSuggestion(JSON.stringify({ colors: {}, icon: 'build/icon.png' }))).toBeUndefined()
    expect(parseSuggestion(JSON.stringify({ colors: { accent: 'orange' } }))).toBeUndefined()
  })

  it('keeps a note to one line', () => {
    const notes = parseSuggestion(JSON.stringify({ colors: { accent: '#f00' }, notes: ' From\n  app.css ' }))?.notes
    expect(notes).toBe('From app.css')
  })
})

describe('the image a suggestion names', () => {
  it('takes a path in the repo, as the repo writes it', () => {
    expect(suggestedIcon('build/icon.png')).toBe('build/icon.png')
    expect(suggestedIcon(' ./assets/logo.png ')).toBe('assets/logo.png')
    expect(suggestedIcon('build\\icon.png')).toBe('build/icon.png')
  })

  it('refuses anything that could name a file outside the repo', () => {
    expect(suggestedIcon('/etc/passwd')).toBeUndefined()
    expect(suggestedIcon('C:\\Windows\\icon.png')).toBeUndefined()
    expect(suggestedIcon('../../secrets/icon.png')).toBeUndefined()
    expect(suggestedIcon('https://example.com/icon.png')).toBeUndefined()
    expect(suggestedIcon('data:image/png;base64,AAAA')).toBeUndefined()
    expect(suggestedIcon('')).toBeUndefined()
    expect(suggestedIcon(42)).toBeUndefined()
  })
})

describe('reading the image out of the code repo', () => {
  let dir: string
  let repo: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corkboard-suggest-'))
    repo = path.join(dir, 'code')
    mkdirSync(path.join(repo, 'build'), { recursive: true })
    writeFileSync(path.join(repo, 'build', 'icon.png'), PNG)
    writeFileSync(path.join(repo, 'build', 'icon.ico'), Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), PNG]))
    writeFileSync(path.join(repo, 'README.md'), '# Code\n')
    writeFileSync(path.join(repo, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]))
    writeFileSync(path.join(dir, 'outside.png'), PNG)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('answers an image as a data URI the window can show', async () => {
    expect(await readIcon(repo, 'build/icon.png')).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  })

  it('reads a favicon too, which a card image never is', async () => {
    expect(await readIcon(repo, 'build/icon.ico')).toMatch(/^data:image\/x-icon;base64,/)
  })

  it('refuses a file that is no image, by its bytes', async () => {
    await expect(readIcon(repo, 'README.md')).rejects.toThrow(/not a PNG/)
  })

  it('refuses a file too large to keep in the settings', async () => {
    await expect(readIcon(repo, 'big.png')).rejects.toThrow(/larger than/)
  })

  it('refuses a file that is not there', async () => {
    await expect(readIcon(repo, 'build/missing.png')).rejects.toThrow(/no build\/missing\.png/)
  })

  it('refuses a path that climbs out of the repo, and a symlink that points out of it', async () => {
    await expect(readIcon(repo, '../outside.png')).rejects.toThrow(/outside the code repo/)
    let linked = false
    try {
      symlinkSync(path.join(dir, 'outside.png'), path.join(repo, 'link.png'))
      linked = true
    } catch {
      // Windows without the privilege for symlinks: the path check above is the one that matters.
    }
    if (linked) await expect(readIcon(repo, 'link.png')).rejects.toThrow(/outside the code repo/)
  })
})
