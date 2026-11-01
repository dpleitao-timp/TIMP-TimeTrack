// Transferência de picagens entre aparelhos, para obras sem internet: o tablet exporta um ficheiro, um telemóvel com a mesma app
// importa-o e passa a tratar as picagens como suas (IDs novos, enviadas ao relay pelo caminho normal quando houver rede).
// O ficheiro não leva nomes de trabalhadores (só SAGE ID), como o que vai para o relay.
import { exportablePunches, markHanded, enqueueImported } from './db.js'

const FORMAT = 'timetrack-punches'
const VERSION = 1
const DIRECTIONS = ['in', 'out', 'meal_out', 'meal_in']
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_PUNCHES = 20000

const obraKey = (s) => String(s ?? '').trim().toLowerCase() // como no relay e na intranet

// Erro com `code` e dados para a interface o traduzir (ver `transfer.err*` em i18n.jsx).
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra })

// Cria o ficheiro com as picagens por enviar (e as já entregues, se includeHanded). Devolve null se não há nada.
export async function buildExport(settings, { includeHanded = false } = {}) {
  const rows = await exportablePunches(includeHanded)
  if (!rows.length) return null
  const body = {
    format: FORMAT,
    version: VERSION,
    deviceId: settings.deviceId,
    exportedAt: new Date().toISOString(),
    punches: rows.map((p) => ({
      id: p.eventId,
      sageId: p.sageId ?? p.workerId,
      obra: p.obra ?? '',
      direction: p.direction,
      punchedAt: p.punchedAt,
      confidence: p.confidence ?? null,
      second: p.second ?? null,
      real: p.real ?? null,
      live: p.live ?? null,
    })),
  }
  const day = new Date().toISOString().slice(0, 10)
  const file = new File([JSON.stringify(body)], `picagens-${settings.deviceId}-${day}.json`, { type: 'application/json' })
  return { file, count: rows.length, eventIds: rows.map((p) => p.eventId) }
}

// Entrega o ficheiro ao utilizador: menu de partilha do sistema se existir (AirDrop, WhatsApp, email...), senão descarrega-o.
// Devolve false se o utilizador cancelou a partilha.
export async function deliverFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return true
    } catch (e) {
      if (e?.name === 'AbortError') return false
      // o sistema recusou partilhar: cai para o descarregamento
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return true
}

// Depois de o utilizador confirmar que o outro aparelho já tem o ficheiro.
export const confirmHanded = (eventIds) => markHanded(eventIds)

const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)

// Lê e valida o ficheiro inteiro: se alguma picagem for inválida, recusa-se tudo (um ficheiro da app nunca as tem).
export function parsePunchFile(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) throw fail('file')
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw fail('file')
  }
  if (j?.format !== FORMAT || j.version !== VERSION || typeof j.deviceId !== 'string' || !Array.isArray(j.punches) || j.punches.length > MAX_PUNCHES) throw fail('file')
  const punches = j.punches.map((p) => {
    const ok =
      typeof p?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.id) &&
      typeof p.sageId === 'string' && p.sageId.trim() !== '' && p.sageId.length <= 32 &&
      typeof p.obra === 'string' && p.obra.trim() !== '' && p.obra.length <= 64 &&
      DIRECTIONS.includes(p.direction) &&
      typeof p.punchedAt === 'string' && Number.isFinite(Date.parse(p.punchedAt)) &&
      (p.confidence === null || (typeof p.confidence === 'number' && p.confidence >= -1 && p.confidence <= 1))
    if (!ok) throw fail('file')
    return {
      origin: p.id,
      sageId: p.sageId.trim(),
      obra: p.obra.trim(),
      direction: p.direction,
      punchedAt: new Date(p.punchedAt).toISOString(),
      confidence: p.confidence === null ? null : Math.round(p.confidence * 1000) / 1000,
      second: unit(p.second),
      real: unit(p.real),
      live: unit(p.live),
    }
  })
  return { deviceId: j.deviceId, punches }
}

// Importa o ficheiro neste aparelho. Só se a obra de todas as picagens for a deste aparelho (a obra de cada aparelho é fixa no relay: com outra
// obra as picagens ficavam gravadas na obra errada) e se o ficheiro não for deste mesmo aparelho. Devolve { added, duplicates }.
export async function importPunchFile(settings, text) {
  const { deviceId, punches } = parsePunchFile(text)
  if (!punches.length) throw fail('file')
  if (!String(settings.obra ?? '').trim()) throw fail('noObra')
  if (deviceId === settings.deviceId) throw fail('same')
  const other = punches.find((p) => obraKey(p.obra) !== obraKey(settings.obra))
  if (other) throw fail('obra', { file: other.obra, own: settings.obra.trim() })
  return enqueueImported(settings.deviceId, punches)
}
