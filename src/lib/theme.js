// Tema claro / escuro / automático, por dispositivo (localStorage 'timp-ponto-theme').
// Mesmo mecanismo da app timesheets-mobile: claro por omissão; 'system' não define
// atributo e deixa o prefers-color-scheme mandar (ver styles.css).
const STORAGE_KEY = 'timp-ponto-theme'

export const THEMES = ['light', 'dark', 'system']
export const DEFAULT_THEME = 'light'

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

export function getTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return THEMES.includes(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function setTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // não persistido; a escolha vale até fechar a app
  }
  applyTheme(theme)
}

applyTheme(getTheme())
