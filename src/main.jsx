import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import { I18nProvider } from './lib/i18n.jsx'
import './lib/theme.js'
import './styles.css'

registerSW({ immediate: true })
createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
)
