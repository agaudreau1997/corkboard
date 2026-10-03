import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'
import { actions } from './state'

createRoot(document.getElementById('root')!).render(<App />)
void actions.boot()
