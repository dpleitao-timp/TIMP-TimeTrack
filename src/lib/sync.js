import { pendingPunches, markSynced, bumpAttempts, setClockOffset, pruneSynced } from './db.js'
import { isCloudConfigured } from './settings.js'

const BATCH = 50
let running = false

// Envia a fila para o relay (Cloudflare). O tablet não tem credenciais do Supabase: é o
// Supabase que vem buscar as picagens ao relay. Seguro chamar repetidamente (idempotente por eventId).
export async function flushQueue(settings) {
  if (running || !isCloudConfigured(settings) || !navigator.onLine) return { sent: 0, pending: (await pendingPunches()).length }
  running = true
  let sent = 0
  try {
    const url = `${settings.relayUrl.replace(/\/$/, '')}/punch`
    for (;;) {
      const batch = (await pendingPunches()).slice(0, BATCH)
      if (!batch.length) break
      const ids = batch.map((p) => p.eventId)
      try {
        const t0 = Date.now()
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-device-token': settings.deviceToken,
          },
          body: JSON.stringify({
            deviceId: settings.deviceId,
            punches: batch.map((p) => ({
              eventId: p.eventId,
              sageId: p.sageId ?? p.workerId, // registos antigos da fila usavam workerId
              direction: p.direction,
              punchedAt: p.punchedAt,
              confidence: p.confidence,
            })),
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (body.serverTime) {
          // corrige a hora do dispositivo com a do servidor (compensa meia latência)
          await setClockOffset(new Date(body.serverTime).getTime() - (t0 + Date.now()) / 2)
        }
        await markSynced(body.accepted ?? ids)
        sent += (body.accepted ?? ids).length
      } catch {
        await bumpAttempts(ids)
        break // tenta novamente no próximo ciclo
      }
    }
    await pruneSynced()
  } finally {
    running = false
  }
  return { sent, pending: (await pendingPunches()).length }
}

// Arranca reenvio automático: ao voltar online e a cada 20 s.
export function startAutoSync(getSettings, onResult) {
  const run = async () => onResult?.(await flushQueue(getSettings()))
  const timer = setInterval(run, 20000)
  window.addEventListener('online', run)
  run()
  return () => {
    clearInterval(timer)
    window.removeEventListener('online', run)
  }
}
