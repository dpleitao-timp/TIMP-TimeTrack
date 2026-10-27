// Definições por dispositivo (localStorage). A direção é fixa por tablet.
const KEY = 'timp-ponto-settings'

const DEFAULTS = {
  direction: 'in', // 'in' | 'out'
  deviceName: 'Tablet 1',
  deviceId: '',
  deviceToken: '',
  supabaseUrl: '',
  supabaseAnonKey: '',
  threshold: 0.55, // similaridade mínima (0..1)
  liveness: true, // exige piscar / virar a cabeça
  cooldownSec: 60, // ignora nova picagem do mesmo trabalhador
  stableFrames: 3, // frames consecutivos com a mesma identidade
}

export function loadSettings() {
  let s = {}
  try {
    s = JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    /* ignora */
  }
  const merged = { ...DEFAULTS, ...s }
  if (!merged.deviceId) {
    merged.deviceId = 'dev-' + crypto.randomUUID().slice(0, 8)
    saveSettings(merged)
  }
  return merged
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignora */
  }
}

// Contadores locais para medir falsos positivos/negativos durante o piloto.
const STATS_KEY = 'timp-ponto-stats'
export const loadStats = () => {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || '{}')
  } catch {
    return {}
  }
}
export function bumpStat(name, ms) {
  const s = loadStats()
  s[name] = (s[name] || 0) + 1
  if (ms) {
    s.msTotal = (s.msTotal || 0) + ms
    s.msCount = (s.msCount || 0) + 1
  }
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s))
  } catch {
    /* ignora */
  }
}
export const resetStats = () => localStorage.removeItem(STATS_KEY)

export const isCloudConfigured = (s) => !!(s.supabaseUrl && s.deviceToken)
