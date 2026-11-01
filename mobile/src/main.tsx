import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FONT_TOKENS } from '@shared/fonts'
import { App } from './App'
import { paint } from './theme'
import './styles.css'

paint()
// The desktop's type and corners, which no theme changes.
for (const [name, value] of Object.entries(FONT_TOKENS)) document.documentElement.style.setProperty(name, value)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
