// Definições por dispositivo (localStorage). A direção (Entrada/Saída) escolhe-se no ecrã Picar.
const KEY = 'timp-ponto-settings'

// Motor de reconhecimento: 'faceres' (o do Human) ou 'sface' (rede da família ArcFace, ver sface.js). Cada registo guarda
// o motor com que foi feito; os de outro motor ficam obsoletos até se atualizar a biometria (os vetores de um motor não
// servem noutro). Mudar de motor recarrega a app.
export const ENGINES = ['faceres', 'sface']

const DEFAULTS = {
  detectorConfidence: 0.4, // confiança mínima da deteção do rosto (mais baixa = deteta melhor com capacete/óculos)
  backend: 'webgl', // aceleração gráfica: 'webgl' | 'webgpu' (experimental; cai para webgl se o aparelho não suportar)
  obra: '', // obra onde está o tablet; vai em todas as picagens
  mode: 'both', // 'both' | 'in' | 'out': tablet de entradas e saídas, só de entradas ou só de saídas
  deviceName: 'Tablet 1',
  deviceId: '',
  deviceToken: '',
  relayUrl: '', // relay Cloudflare onde o tablet escreve (o Supabase vai lá buscar)
  engine: 'faceres', // motor de reconhecimento
  threshold: 0.55, // similaridade mínima do FaceRes (0..1)
  thresholdSface: 0.45, // semelhança mínima do SFace (cosseno, -1..1): escala diferente da do FaceRes, não se aproveitam os valores
  liveness: true, // exige piscar / virar a cabeça
  cooldownSec: 60, // ignora nova picagem do mesmo trabalhador
  stableFrames: 2, // avaliações seguidas com a mesma identidade
  avgFrames: 5, // fotogramas cuja média decide o reconhecimento
  antispoofMin: 0.35, // média mínima do anti-foto/vida do modelo (0 desliga)
  fastLiveness: false, // modo rápido: dispensa o piscar quando o modelo anti-foto tem confiança alta
  debug: false, // mostra os valores do reconhecimento no ecrã de picar
  cameraId: '', // câmara normal ('' = frontal)
  orientation: 'auto', // orientação do ecrã: 'auto' (segue o aparelho) | 'landscape' | 'portrait'
  lightFrameAuto: true, // moldura branca do ecrã de leitura ajusta-se à luz da cara
}

export function loadSettings() {
  let s = {}
  try {
    s = JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    /* ignora */
  }
  const merged = { ...DEFAULTS, ...s }
  // motor desconhecido (por exemplo o MobileFaceNet, já retirado): volta ao FaceRes
  if (!ENGINES.includes(merged.engine)) {
    merged.engine = 'faceres'
    saveSettings(merged)
  }
  // o tablet já não tem ligação direta ao Supabase: apaga o que ficou guardado de versões anteriores
  if ('supabaseUrl' in s || 'supabaseAnonKey' in s) {
    delete merged.supabaseUrl
    delete merged.supabaseAnonKey
    saveSettings(merged)
  }
  // o repouso passou a ser a norma (sem horário nem fim de semana): apaga as definições antigas
  const oldSchedule = ['scheduleOn', 'scheduleFrom', 'scheduleTo', 'scheduleOffSat', 'scheduleOffSun'].filter((k) => k in s)
  if (oldSchedule.length) {
    oldSchedule.forEach((k) => delete merged[k])
    saveSettings(merged)
  }
  if (!merged.deviceId) {
    merged.deviceId = 'dev-' + crypto.randomUUID().slice(0, 8)
    saveSettings(merged)
  }
  return merged
}

// Motor em uso e limiar de semelhança desse motor.
export const currentEngine = () => (loadSettings().engine === 'sface' ? 'sface' : 'faceres')
// Etiqueta guardada em cada registo. O modelo do SFace faz parte dela: os vetores do int8 e do fp32 são parecidos mas não
// iguais (semelhança ~0,85 entre eles), por isso um registo feito com o int8 fica obsoleto quando passa a valer o fp32.
export const engineTag = () => (currentEngine() === 'sface' ? 'sface-fp32' : 'faceres')
export const thresholdFor =(s) => Number(s.engine === 'sface' ? s.thresholdSface : s.threshold)

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
