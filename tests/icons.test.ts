import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { iconDef, iconPaint, ICONS, type IconName } from '@shared/icons'

const inGrid = (...n: number[]) => n.every(v => v >= 0 && v <= 16)

describe('the icon set', () => {
  it('draws every icon inside the 16-unit grid', () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const { shapes } = iconDef(name)
      expect(shapes.length, name).toBeGreaterThan(0)
      for (const shape of shapes) {
        if ('circle' in shape) {
          const [cx, cy, r] = shape.circle
          expect(inGrid(cx - r, cx + r, cy - r, cy + r), name).toBe(true)
        } else if ('rect' in shape) {
          const [x, y, w, h] = shape.rect
          expect(inGrid(x, y, x + w, y + h), name).toBe(true)
        } else {
          // A coarse check: every number of the path (points, lengths, radii) is on the grid.
          expect(shape.d, name).toMatch(/^M/)
          expect(inGrid(...(shape.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter(n => n >= 0)), name).toBe(true)
        }
      }
    }
  })

  it('outlines in the text colour, or fills', () => {
    expect(iconPaint(iconDef('gear'))).toMatchObject({ fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' })
    expect(iconPaint(iconDef('sidebar')).strokeLinecap).toBe('butt')
    expect(iconPaint(iconDef('more'))).toEqual({ fill: 'currentColor', stroke: 'none' })
  })

  it('is the only place either app draws an inline SVG icon', () => {
    const roots = ['../src/renderer/src', '../mobile/src'].map(r => path.join(__dirname, r))
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.tsx$/.test(entry.name) && entry.name !== 'Icon.tsx' && readFileSync(file, 'utf8').includes('<svg')) {
          offenders.push(path.relative(path.join(__dirname, '..'), file))
        }
      }
    }
    roots.forEach(walk)
    expect(offenders).toEqual([])
  })
})
