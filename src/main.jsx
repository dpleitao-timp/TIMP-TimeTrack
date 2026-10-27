import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import './lib/theme.js'
import './styles.css'

registerSW({ immediate: true })
createRoot(document.getElementById('root')).render(<App />)
