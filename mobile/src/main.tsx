import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FONT_TOKENS } from '@shared/fonts'
import { App } from './App'
import { applyTokens } from './theme'
import './styles.css'

applyTokens(document.documentElement)
// The desktop's type and corners, which no theme changes.
for (const [name, value] of Object.entries(FONT_TOKENS)) document.documentElement.style.setProperty(name, value)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
