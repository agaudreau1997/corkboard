import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { paint } from './theme'
import './styles.css'

paint()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
