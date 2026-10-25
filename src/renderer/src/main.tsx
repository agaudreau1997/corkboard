import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'
import { actions } from './state'

// A file dropped where nothing takes it would navigate the window to it, and the board with it.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, e => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
}

createRoot(document.getElementById('root')!).render(<App />)
void actions.boot()
