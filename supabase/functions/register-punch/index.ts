// Edge Function: register-punch
// Recebe lotes de picagens de um tablet. Autenticação por token de dispositivo.
// Idempotente por event_id: reenvios não criam duplicados.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-device-token, apikey, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const MAX_BATCH = 200
const MAX_FUTURE_MS = 5 * 60 * 1000 // rejeita horas > 5 min no futuro
const MAX_PAST_MS = 14 * 24 * 3600 * 1000 // e mais de 14 dias no passado

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const token = req.headers.get('x-device-token')
  if (!token) return json({ error: 'missing_token' }, 401)

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const deviceId = String(body?.deviceId ?? '')
  const punches = Array.isArray(body?.punches) ? body.punches : []
  if (!deviceId || !punches.length || punches.length > MAX_BATCH) return json({ error: 'invalid_payload' }, 400)

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: device } = await supabase
    .from('punch_devices')
    .select('id, token_hash, active')
    .eq('id', deviceId)
    .maybeSingle()
  if (!device || !device.active || device.token_hash !== (await sha256Hex(token))) {
    return json({ error: 'invalid_device' }, 401)
  }

  const now = Date.now()
  const rows: Record<string, unknown>[] = []
  const rejected: string[] = []
  const accepted: string[] = []

  for (const p of punches) {
    const t = Date.parse(p?.punchedAt)
    const valid =
      typeof p?.eventId === 'string' &&
      p.eventId.startsWith(`${deviceId}-`) && // o ID tem de pertencer a este dispositivo
      typeof p?.workerId === 'string' &&
      (p.direction === 'in' || p.direction === 'out') &&
      Number.isFinite(t) &&
      t - now < MAX_FUTURE_MS &&
      now - t < MAX_PAST_MS
    if (!valid) {
      if (typeof p?.eventId === 'string') rejected.push(p.eventId)
      continue
    }
    accepted.push(p.eventId)
    rows.push({
      event_id: p.eventId,
      device_id: deviceId,
      worker_id: p.workerId,
      worker_name: typeof p.workerName === 'string' ? p.workerName.slice(0, 120) : null,
      direction: p.direction,
      punched_at: new Date(t).toISOString(),
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
    })
  }

  if (rows.length) {
    // ignoreDuplicates => reenvio do mesmo event_id é aceite sem criar nova linha
    const { error } = await supabase.from('punches').upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true })
    if (error) return json({ error: 'db_error', detail: error.message }, 500)
  }

  // "accepted" inclui duplicados; "rejected" são inválidos (o tablet pode descartá-los).
  return json({ accepted: [...accepted, ...rejected], rejected, serverTime: new Date().toISOString() })
})
