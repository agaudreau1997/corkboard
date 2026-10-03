#!/usr/bin/env python3
"""Draws Corkboard's icon: three pinned notes on cork, joined by a red string (the kanban and
the mind map), as build/icon.svg, then renders the PNG sizes with Inkscape.

    python3 scripts/make-icon.py
"""
import random
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'build'
rng = random.Random(7)

speckles = []
for _ in range(260):
    x, y = rng.uniform(52, 460), rng.uniform(52, 460)
    r = rng.choice([1.6, 2.2, 2.8, 3.4])
    tone = rng.choice(['#8a5529', '#94602f', '#d9a46c', '#7a4a23', '#e0b27e'])
    speckles.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{tone}" opacity="{rng.uniform(0.35, 0.7):.2f}"/>')

def note(cx, top, w, h, angle, fill, ink, lines):
    x = cx - w / 2
    rows = ''.join(
        f'<rect x="{x + 16}" y="{top + 44 + i * 26}" width="{(w - 32) * f}" height="9" rx="4.5" fill="{ink}" opacity="0.45"/>'
        for i, f in enumerate(lines)
    )
    return (
        f'<g transform="rotate({angle} {cx} {top})" filter="url(#lift)">'
        f'<rect x="{x}" y="{top}" width="{w}" height="{h}" rx="10" fill="{fill}"/>'
        f'<rect x="{x}" y="{top}" width="{w}" height="{h}" rx="10" fill="url(#sheen)"/>'
        f'{rows}</g>'
    )

def pin(cx, cy):
    return (
        f'<ellipse cx="{cx + 4}" cy="{cy + 9}" rx="13" ry="6" fill="#000" opacity="0.28"/>'
        f'<circle cx="{cx}" cy="{cy}" r="15" fill="url(#pin)"/>'
        f'<circle cx="{cx - 5}" cy="{cy - 5}" r="4.5" fill="#fff" opacity="0.7"/>'
    )

pins = [(146, 122), (258, 150), (370, 112)]
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="cork" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#c99159"/>
      <stop offset="1" stop-color="#a86f3d"/>
    </linearGradient>
    <linearGradient id="frame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a2a1e"/>
      <stop offset="1" stop-color="#22170f"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="pin" cx="0.38" cy="0.35" r="0.7">
      <stop offset="0" stop-color="#ff8a80"/>
      <stop offset="0.45" stop-color="#e53935"/>
      <stop offset="1" stop-color="#8e1414"/>
    </radialGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="6"/>
      <feOffset dx="0" dy="7" result="blur"/>
      <feFlood flood-color="#2b1606" flood-opacity="0.45"/>
      <feComposite in2="blur" operator="in" result="shadow"/>
      <feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="board"><rect x="40" y="40" width="432" height="432" rx="86"/></clipPath>
  </defs>
  <rect x="12" y="12" width="488" height="488" rx="112" fill="url(#frame)"/>
  <rect x="40" y="40" width="432" height="432" rx="86" fill="url(#cork)"/>
  <g clip-path="url(#board)">{''.join(speckles)}</g>
  {note(146, 118, 112, 214, -6, '#5b8def', '#173a7a', [0.9, 0.7, 0.85, 0.5])}
  {note(258, 146, 112, 252, 3, '#f0c674', '#7a5410', [0.85, 0.95, 0.6, 0.8, 0.45])}
  {note(370, 108, 112, 188, -3, '#4cb782', '#14532d', [0.8, 0.6, 0.9])}
  <path d="M {pins[0][0]} {pins[0][1]} Q 202 {pins[0][1] + 52} {pins[1][0]} {pins[1][1]} Q 314 {pins[1][1] + 46} {pins[2][0]} {pins[2][1]}"
        fill="none" stroke="#7a0f0f" stroke-width="7" stroke-linecap="round" opacity="0.35" transform="translate(3 5)"/>
  <path d="M {pins[0][0]} {pins[0][1]} Q 202 {pins[0][1] + 52} {pins[1][0]} {pins[1][1]} Q 314 {pins[1][1] + 46} {pins[2][0]} {pins[2][1]}"
        fill="none" stroke="#d32f2f" stroke-width="6" stroke-linecap="round"/>
  {''.join(pin(x, y) for x, y in pins)}
</svg>
'''

OUT.mkdir(exist_ok=True)
(OUT / 'icon.svg').write_text(svg)
for size in (512, 256, 128, 64, 48, 32, 16):
    name = 'icon.png' if size == 512 else f'icon-{size}.png'
    subprocess.run(
        ['inkscape', str(OUT / 'icon.svg'), '--export-type=png', f'--export-filename={OUT / name}',
         f'--export-width={size}', f'--export-height={size}'],
        check=True, capture_output=True,
    )
    print('wrote', OUT / name)
