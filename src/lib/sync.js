import { pendingPunches, markSynced, bumpAttempts, setClockOffset, pruneSynced, markSending, clearSending, markRejected, pendingVoids, clearVoids, replaceRoster, touchRoster, rosterMeta, releaseExpiredHeld } from './db.js'
import { isCloudConfigured, loadSettings, saveSettings } from './settings.js'
import { relayRequest } from './relay.js'

const BATCH = 50
let running = false

// Envia a fila para o relay (Cloudflare). O tablet não tem credenciais do Supabase: é o
// Supabase que vem buscar as picagens ao relay. Seguro chamar repetidamente (idempotente por eventId).
export async function flushQueue(settings) {
  await releaseExpiredHeld().catch(() => {}) // picagens retidas à espera da saída de um dia que já acabou: seguem com a obra que tinham
  if (running || !isCloudConfigured(settings) || !navigator.onLine) return { sent: 0, pending: (await pendingPunches()).length }
  running = true
  let sent = 0
  let left = null // quantas ficam por enviar, quando o ciclo o sabe sem reler a fila (0 se acabou com a fila vazia)
  try {
    for (;;) {
      const batch = (await pendingPunches()).slice(0, BATCH)
      if (!batch.length) {
        left = 0
        break
      }
      const ids = batch.map((p) => p.eventId)
      markSending(ids) // enquanto estão a ser enviadas, não se podem apagar
      try {
        const t0 = Date.now()
        const res = await relayRequest(settings, 'POST', '/punch', {
          deviceId: settings.deviceId,
          punches: batch.map((p) => ({
            eventId: p.eventId,
            sageId: p.sageId ?? p.workerId, // registos antigos da fila usavam workerId
            obra: p.obra ?? '', // picagens antigas sem obra são recusadas pelo relay
            direction: p.direction,
            punchedAt: p.punchedAt,
            confidence: p.confidence,
            second: p.second ?? null,
            real: p.real ?? null,
            live: p.live ?? null,
          })),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (body.serverTime) {
          // corrige a hora do dispositivo com a do servidor (compensa meia latência)
          await setClockOffset(new Date(body.serverTime).getTime() - (t0 + Date.now()) / 2)
        }
        // `accepted` pode incluir as recusadas (relay antigo): só conta como enviado o que não foi recusado
        const rejected = new Set(body.rejected ?? [])
        const accepted = (body.accepted ?? ids).filter((id) => !rejected.has(id))
        await markSynced(accepted)
        await markRejected(ids.filter((id) => rejected.has(id)))
        sent += accepted.length
      } catch {
        await bumpAttempts(ids)
        break // tenta novamente no próximo ciclo
      } finally {
        clearSending(ids)
      }
    }
    await flushVoids(settings)
    await pruneSynced()
  } finally {
    running = false
  }
  return { sent, pending: left ?? (await pendingPunches()).length }
}

// Pedidos para apagar picagens que já tinham sido enviadas. Vão ao relay; o Supabase lê-os de lá e apaga a picagem.
// Se falhar, a picagem continua marcada como apagada e tenta-se no ciclo seguinte.
async function flushVoids(settings) {
  const voids = await pendingVoids()
  for (let i = 0; i < voids.length; i += BATCH) {
    const ids = voids.slice(i, i + BATCH).map((p) => p.eventId)
    try {
      const res = await relayRequest(settings, 'POST', '/punch/delete', { deviceId: settings.deviceId, eventIds: ids })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      await clearVoids(body.accepted ?? ids)
    } catch {
      return
    }
  }
}

// Configuração que a intranet (Time Clocks) definiu para este relógio e o relay entrega com a lista: a obra (a do relay é a que vale, o relay recusa
// as picagens de outra), a função do tablet e o almoço/jantar. Só se aplica o que o relay trouxe: função e almoço/jantar a null (a intranet nunca os
// definiu) deixam o que o tablet tem. Quando a intranet define a função, o tablet passa a "managed" e essas opções ficam só de leitura nas Definições.
const MODES = ['both', 'in', 'out']
function applyRemoteConfig(body) {
  const cur = loadSettings()
  const next = { ...cur }
  const cfg = body?.config
  if (typeof body?.obra === 'string' && body.obra.trim()) next.obra = body.obra.trim()
  if (MODES.includes(cfg?.mode)) {
    next.mode = cfg.mode
    next.managed = true
  }
  if (typeof cfg?.mealPunches === 'boolean') next.mealPunches = cfg.mealPunches
  if (['obra', 'mode', 'mealPunches', 'managed'].every((k) => next[k] === cur[k])) return
  saveSettings(next)
  window.dispatchEvent(new Event('settings-changed')) // a interface relê as definições
}

// Lista de trabalhadores da obra, lida do relay (o Supabase publica-a lá). O tablet nunca fala com o Supabase.
// Devolve { ok, count?, unchanged?, error? }.
export async function syncRoster(settings, { force = false } = {}) {
  if (!isCloudConfigured(settings)) return { ok: false, error: 'not-configured' }
  if (!navigator.onLine) return { ok: false, error: 'offline' }
  try {
    const { gen, obra: storedObra, sig } = await rosterMeta()
    const obra = (settings.obra || '').trim()
    // Mudou a obra do tablet: a lista guardada é de outra obra, por isso lê-se sempre de novo (o "gen" é global e diria "sem alterações").
    const sameObra = storedObra.toLowerCase() === obra.toLowerCase()
    // `set`: o conjunto de obras que o relay deu a este relógio na última leitura; se mudou, o relay manda a lista de novo mesmo sem lista nova do Supabase.
    const qs = new URLSearchParams({ device: settings.deviceId, obra, since: force || !sameObra ? '0' : String(gen), set: sig })
    const res = await relayRequest(settings, 'GET', `/roster?${qs}`)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    applyRemoteConfig(body)
    if (body.unchanged) {
      await touchRoster()
      return { ok: true, unchanged: true }
    }
    // relógio de uma só obra (ou relay antigo): `obras` com 0 ou 1 obra, sem escolha de obra; com várias, cada trabalhador traz as suas
    await replaceRoster(body.workers ?? [], body.generatedAt, typeof body.obra === 'string' && body.obra.trim() ? body.obra.trim() : obra, body.obras, body.sig)
    return { ok: true, count: (body.workers ?? []).length }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// Arranca reenvio automático: ao voltar online e a cada 20 s.
export function startAutoSync(getSettings, onResult) {
  const run = async () => {
    onResult?.(await flushQueue(getSettings()))
  }
  const timer = setInterval(run, 20000)
  window.addEventListener('online', run)
  run()
  return () => {
    clearInterval(timer)
    window.removeEventListener('online', run)
  }
}
