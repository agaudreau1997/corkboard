import { describe, expect, it } from 'vitest'
import { scanTitles, statusFromTitle } from '../src/main/termstatus'

const title = (text: string, end = '\x07') => `\x1b]0;${text}${end}`

describe('scanTitles', () => {
  it('reads OSC 0 and 2 titles, ended by BEL or ST, in order', () => {
    const chunk = `out${title('◐ Fix it')}more\x1b]2;✳ Fix it\x1b\\tail`
    expect(scanTitles('', chunk)).toEqual({ titles: ['◐ Fix it', '✳ Fix it'], carry: '' })
  })

  it('reads the empty title Claude Code leaves on exit', () => {
    expect(scanTitles('', `bye\r\n${title('')}$ `).titles).toEqual([''])
  })

  it('ignores other escape sequences', () => {
    const chunk = '\x1b[31mred\x1b[0m\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\\x1b]133;A\x07'
    expect(scanTitles('', chunk)).toEqual({ titles: [], carry: '' })
  })

  it('finishes a title a chunk cut in two, wherever the cut', () => {
    const whole = `before${title('◑ Long topic', '\x1b\\')}after`
    for (let cut = 1; cut < whole.length; cut++) {
      const first = scanTitles('', whole.slice(0, cut))
      const second = scanTitles(first.carry, whole.slice(cut))
      expect([...first.titles, ...second.titles], `cut at ${cut}`).toEqual(['◑ Long topic'])
      expect(second.carry).toBe('')
    }
  })

  it('drops an unended sequence that runs too long to be a title', () => {
    const { carry } = scanTitles('', `\x1b]0;${'x'.repeat(5000)}`)
    expect(carry).toBe('')
  })
})

describe('statusFromTitle', () => {
  it("follows Claude Code's title prefix", () => {
    expect(statusFromTitle('◐ Fix the tabs')).toBe('working')
    expect(statusFromTitle('◑ Fix the tabs')).toBe('working')
    expect(statusFromTitle('✳ Fix the tabs')).toBe('waiting')
    expect(statusFromTitle('✳ Claude Code')).toBe('waiting')
  })

  it('takes anything else for a shell', () => {
    expect(statusFromTitle('')).toBe('shell')
    expect(statusFromTitle('alex@host:~/corkboard')).toBe('shell')
    expect(statusFromTitle('vim notes.md')).toBe('shell')
  })
})
