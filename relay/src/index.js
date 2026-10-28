// Relay de picagens (Cloudflare Worker + D1).
//
//   Tablet  ── POST /punch ──►  [outbox]  ◄── GET /pull, POST /ack ──  Supabase
//
// O tablet só escreve (token do dispositivo). O Supabase só lê e confirma (pedidos
// assinados com HMAC). Nenhum dos dois lados tem credenciais do outro.

const MAX_BATCH = 200
const MAX_BODY_BYTES = 256 * 1024
const MAX_FUTURE_MS = 5 * 60 * 1000 // rejeita horas > 5 min no futuro
const MAX_PAST_MS = 14 * 24 * 3600 * 1000 // ou com mais de 14 dias
const MAX_BACKLOG_PER_DEVICE = 50000 // evita encher a base de dados
const MAX_PULL = 500
const MAX_ACK = 500
const SIGNATURE_SKEW_S = 300

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (s) => new Uint8Array(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])

async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

function timingSafeEqualHex(a, b) {
  const x = enc.encode(a)
  const y = enc.encode(b)
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'content-type, x-device-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  }
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } })

// Assinatura do Supabase: HMAC-SHA256(PULL_SECRET, método \n caminho+query \n timestamp \n corpo)
async function verifySignature(request, url, bodyText, secret) {
  if (!secret) return false
  const ts = request.headers.get('x-timestamp') || ''
  const sig = request.headers.get('x-signature') || ''
  const age = Math.abs(Date.now() / 1000 - Number(ts))
  if (!/^\d+$/.test(ts) || !Number.isFinite(age) || age > SIGNATURE_SKEW_S || !/^[0-9a-f]{64}$/.test(sig)) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const message = enc.encode(`${request.method}\n${url.pathname}${url.search}\n${ts}\n${bodyText}`)
  return crypto.subtle.verify('HMAC', key, unhex(sig), message)
}

async function readBody(request) {
  const text = await request.text()
  return text.length > MAX_BODY_BYTES ? null : text
}

// ------------------------------------------------------------------ tablet → relay
async function handlePunch(request, env) {
  const cors = corsHeaders(env)
  const token = request.headers.get('x-device-token')
  if (!token) return json({ error: 'missing_token' }, 401, cors)

  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413, cors)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }
  const deviceId = String(body?.deviceId ?? '')
  const punches = Array.isArray(body?.punches) ? body.punches : []
  if (!deviceId || !punches.length || punches.length > MAX_BATCH) return json({ error: 'invalid_payload' }, 400, cors)

  const device = await env.DB.prepare('SELECT token_hash, active FROM devices WHERE id = ?').bind(deviceId).first()
  // mesma resposta para "não existe" e "token errado": não revela que dispositivos existem
  if (!device || !device.active || !timingSafeEqualHex(device.token_hash, await sha256Hex(token))) {
    return json({ error: 'invalid_device' }, 401, cors)
  }

  const backlog = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox WHERE device_id = ?').bind(deviceId).first()
  if (backlog.n >= MAX_BACKLOG_PER_DEVICE) return json({ error: 'backlog_full' }, 429, cors)

  const now = Date.now()
  const stmts = []
  const accepted = []
  const rejected = []
  for (const p of punches) {
    const t = Date.parse(p?.punchedAt)
    const valid =
      typeof p?.eventId === 'string' &&
      p.eventId.length <= 64 &&
      p.eventId.startsWith(`${deviceId}-`) && // o ID tem de pertencer a este dispositivo
      typeof p?.sageId === 'string' &&
      p.sageId.trim() !== '' &&
      p.sageId.length <= 32 &&
      typeof p?.obra === 'string' &&
      p.obra.trim() !== '' &&
      p.obra.length <= 64 &&
      (p.direction === 'in' || p.direction === 'out') &&
      Number.isFinite(t) &&
      t - now < MAX_FUTURE_MS &&
      now - t < MAX_PAST_MS
    if (!valid) {
      if (typeof p?.eventId === 'string') rejected.push(p.eventId)
      continue
    }
    const payload = JSON.stringify({
      eventId: p.eventId,
      sageId: p.sageId.trim(),
      obra: p.obra.trim(),
      direction: p.direction,
      punchedAt: new Date(t).toISOString(),
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
    })
    stmts.push(
      env.DB.prepare('INSERT OR IGNORE INTO outbox (event_id, device_id, payload, received_at) VALUES (?, ?, ?, ?)').bind(
        p.eventId,
        deviceId,
        payload,
        Math.floor(now / 1000),
      ),
    )
    accepted.push(p.eventId)
  }
  if (stmts.length) await env.DB.batch(stmts)

  // "accepted" inclui duplicados; "rejected" são inválidos (o tablet pode descartá-los).
  return json({ accepted: [...accepted, ...rejected], rejected, serverTime: new Date().toISOString() }, 200, cors)
}

// ------------------------------------------------------------------ Supabase → relay
async function handlePull(request, url, env) {
  if (!(await verifySignature(request, url, '', env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), MAX_PULL)
  const { results } = await env.DB.prepare('SELECT device_id, payload, received_at FROM outbox ORDER BY seq LIMIT ?').bind(limit).all()
  const punches = results.map((r) => ({ ...JSON.parse(r.payload), deviceId: r.device_id, receivedAt: r.received_at }))
  return json({ punches })
}

async function handleAck(request, url, env) {
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413)
  if (!(await verifySignature(request, url, text, env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  let ids
  try {
    ids = JSON.parse(text)?.eventIds
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!Array.isArray(ids) || ids.length > MAX_ACK || ids.some((i) => typeof i !== 'string')) return json({ error: 'invalid_payload' }, 400)
  const stmts = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    stmts.push(env.DB.prepare(`DELETE FROM outbox WHERE event_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk))
  }
  if (stmts.length) await env.DB.batch(stmts)
  return json({ deleted: ids.length })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' && url.pathname === '/punch') return new Response(null, { status: 204, headers: corsHeaders(env) })
    if (request.method === 'POST' && url.pathname === '/punch') return handlePunch(request, env)
    if (request.method === 'GET' && url.pathname === '/pull') return handlePull(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack') return handleAck(request, url, env)
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true })
    return json({ error: 'not_found' }, 404)
  },
}
