// Edge Function: pull-punches
// É o Supabase que vai buscar as picagens ao relay (Cloudflare) e as grava em `punches`.
// Chamada pelo pg_cron (ver migração 002). Os tablets nunca contactam o Supabase.
//
// Segredos (supabase secrets set ...):
//   RELAY_URL     https://timp-punch-relay.<conta>.workers.dev
//   PULL_SECRET   segredo HMAC partilhado com o relay (o mesmo de `wrangler secret put PULL_SECRET`)
//   CRON_SECRET   segredo que o pg_cron envia no cabeçalho x-cron-secret
// Publicar sem verificação JWT (a autenticação é o x-cron-secret):
//   supabase functions deploy pull-punches --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BATCH = 200
const MAX_BATCHES = 10 // por execução; o resto fica para a próxima
const MAX_FUTURE_MS = 5 * 60 * 1000
const MAX_PAST_MS = 14 * 24 * 3600 * 1000

const enc = new TextEncoder()
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function signedFetch(path: string, method: 'GET' | 'POST', body = '') {
  const ts = Math.floor(Date.now() / 1000).toString()
  const key = await crypto.subtle.importKey('raw', enc.encode(Deno.env.get('PULL_SECRET')!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${method}\n${path}\n${ts}\n${body}`)))
  const res = await fetch(`${Deno.env.get('RELAY_URL')!.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'x-timestamp': ts, 'x-signature': sig, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? body : undefined,
  })
  if (!res.ok) throw new Error(`relay ${method} ${path} -> HTTP ${res.status}`)
  return res.json()
}

function timingSafeEqual(a: string, b: string) {
  const x = enc.encode(a)
  const y = enc.encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET') ?? ''
  if (!secret || !timingSafeEqual(req.headers.get('x-cron-secret') ?? '', secret)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let stored = 0
  let dropped = 0

  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const path = `/pull?limit=${BATCH}`
      const { punches } = await signedFetch(path, 'GET')
      if (!punches?.length) break

      // O relay já valida; voltamos a validar aqui (o Supabase não confia em ninguém).
      const now = Date.now()
      const rows: Record<string, unknown>[] = []
      const ackIds: string[] = []
      for (const p of punches) {
        ackIds.push(p.eventId) // inválidos também se confirmam, para saírem do relay
        const t = Date.parse(p?.punchedAt)
        const valid =
          typeof p?.eventId === 'string' &&
          typeof p?.deviceId === 'string' &&
          p.eventId.startsWith(`${p.deviceId}-`) &&
          typeof p?.sageId === 'string' &&
          p.sageId.trim() !== '' &&
          typeof p?.obra === 'string' &&
          p.obra.trim() !== '' &&
          (p.direction === 'in' || p.direction === 'out') &&
          Number.isFinite(t) &&
          t - now < MAX_FUTURE_MS &&
          now - t < MAX_PAST_MS
        if (!valid) {
          dropped++
          continue
        }
        rows.push({
          event_id: p.eventId,
          device_id: p.deviceId,
          sage_id: p.sageId.trim(),
          obra: p.obra.trim(),
          direction: p.direction,
          punched_at: new Date(t).toISOString(),
          confidence: typeof p.confidence === 'number' ? p.confidence : null,
        })
      }

      if (rows.length) {
        const deviceIds = [...new Set(rows.map((r) => r.device_id as string))]
        const { error: devErr } = await supabase
          .from('punch_devices')
          .upsert(deviceIds.map((id) => ({ id, name: id })), { onConflict: 'id', ignoreDuplicates: true })
        if (devErr) throw new Error(`devices: ${devErr.message}`)
        // reenvios/duplicados do mesmo event_id são ignorados
        const { error } = await supabase.from('punches').upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true })
        if (error) throw new Error(`punches: ${error.message}`)
        stored += rows.length
      }

      // só confirmamos ao relay depois de gravado: se algo falhar, a picagem fica no relay
      await signedFetch('/ack', 'POST', JSON.stringify({ eventIds: ackIds }))
      if (punches.length < BATCH) break
    }
  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: 'pull_failed', stored, dropped }), { status: 502 })
  }

  return new Response(JSON.stringify({ stored, dropped }), { headers: { 'Content-Type': 'application/json' } })
})
