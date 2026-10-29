// Definições por dispositivo (localStorage). A direção (Entrada/Saída) escolhe-se no ecrã Picar.
const KEY = 'timp-ponto-settings'

const DEFAULTS = {
  detectorConfidence: 0.4, // confiança mínima da deteção do rosto (mais baixa = deteta melhor com capacete/óculos)
  engine: 'faceres', // motor de reconhecimento: 'faceres' (por omissão) | 'mobilefacenet' (experimental, mais leve)
  backend: 'webgl', // aceleração gráfica: 'webgl' | 'webgpu' (experimental; cai para webgl se o aparelho não suportar)
  obra: '', // obra onde está o tablet; vai em todas as picagens
  mode: 'both', // 'both' | 'in' | 'out': tablet de entradas e saídas, só de entradas ou só de saídas
  deviceName: 'Tablet 1',
  deviceId: '',
  deviceToken: '',
  relayUrl: '', // relay Cloudflare onde o tablet escreve (o Supabase vai lá buscar)
  threshold: 0.55, // similaridade mínima (0..1)
  liveness: true, // exige piscar / virar a cabeça
  cooldownSec: 60, // ignora nova picagem do mesmo trabalhador
  stableFrames: 2, // avaliações seguidas com a mesma identidade
  avgFrames: 5, // fotogramas cuja média decide o reconhecimento
  antispoofMin: 0.35, // média mínima do anti-foto/vida do modelo (0 desliga)
  fastLiveness: false, // modo rápido: dispensa o piscar quando o modelo anti-foto tem confiança alta
  debug: false, // mostra os valores do reconhecimento no ecrã de picar
  cameraId: '', // câmara normal ('' = frontal)
}

export function loadSettings() {
  let s = {}
  try {
    s = JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    /* ignora */
  }
  const merged = { ...DEFAULTS, ...s }
  // o tablet já não tem ligação direta ao Supabase: apaga o que ficou guardado de versões anteriores
  if ('supabaseUrl' in s || 'supabaseAnonKey' in s) {
    delete merged.supabaseUrl
    delete merged.supabaseAnonKey
    saveSettings(merged)
  }
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

export const isCloudConfigured = (s) => !!(s.relayUrl && s.deviceToken)
