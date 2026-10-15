import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/controls.css'
import './styles/develop.css'
import './styles/panels.css'
import './styles/library.css'
import './styles/filmstrip.css'
import './styles/palette.css'
import './styles/views.css'
import './styles/canvas.css'
import './styles/narrow.css'

createRoot(document.getElementById('root')).render(<App />)

// installed or not, the built app keeps working offline
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[sw]', err))
}
