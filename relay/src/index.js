// Relay de picagens (Cloudflare Worker + D1).
//
//   Tablet  ── POST /punch ──►  [outbox]  ◄── GET /pull, POST /ack ──  Supabase
//   Tablet  ◄── GET /roster ──  [roster]  ◄── POST /roster ──  Supabase
//   Tablet  ── POST /punch/delete ──►  [deletions]  ◄── GET /pull-deletions, POST /ack-deletions ──  Supabase
//   Tablet  ── qualquer pedido autenticado ──►  [devices.last_seen]  ◄── GET /devices-status ──  Supabase (função relay-status da intranet)
//
// O tablet escreve picagens (e pedidos para as apagar) e lê a lista de trabalhadores (pedidos assinados com a chave do tablet). O Supabase lê as picagens,
// confirma-as e publica a lista (pedidos assinados com HMAC). Nenhum dos dois lados tem credenciais do outro.

const MAX_BATCH = 200
const DIRECTIONS = ['in', 'out', 'meal_out', 'meal_in'] // entrada e saída da obra, e saída/entrada de almoço ou jantar
const MAX_BODY_BYTES = 256 * 1024
const MAX_FUTURE_MS = 5 * 60 * 1000 // rejeita horas > 5 min no futuro
const MAX_PAST_MS = 14 * 24 * 3600 * 1000 // ou com mais de 14 dias
const MAX_BACKLOG_PER_DEVICE = 50000 // evita encher a base de dados
const MAX_PULL = 500
const MAX_ACK = 500
const SIGNATURE_SKEW_S = 300
const MAX_ROSTER_CHUNK = 500
const MAX_ROSTER_LIST = 3000 // trabalhadores devolvidos a um tablet

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (s) => new Uint8Array(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

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
    'Access-Control-Allow-Headers': 'content-type, x-device-id, x-timestamp, x-nonce, x-signature, x-enroll-code',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  }
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } })

// Regista que o tablet acabou de falar com o relay (batimento do relógio). Só depois de autenticado.
const touchDevice = (env, deviceId) =>
  env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), deviceId).run()

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
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return null // antes de ler o corpo todo
  const text = await request.text()
  return text.length > MAX_BODY_BYTES ? null : text
}

// número entre 0 e 1, ou null
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)
// Semelhança do reconhecimento: de -1 a 1 (o cosseno do SFace pode ser negativo; o FaceRes vai de 0 a 1). Fora disto vira null e a picagem
// segue: a coluna do Supabase é numeric(5,3) e um valor como 1000 fazia falhar o lote inteiro, parando a sincronização de todos os tablets.
const similarity = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1 ? Math.round(v * 1000) / 1000 : null)

// A obra compara-se sem maiúsculas nem espaços nas pontas (como a intranet).
const obraKey = (s) => String(s ?? '').trim().toLowerCase()

// Cada dispositivo tem uma obra FIXA no relay (devices.obra): é ela, e não o que o tablet diz, que manda. Sem obra, o dispositivo
// não pode picar nem ler a lista de trabalhadores (o `add-device.mjs` pede a obra). Devolve a Response de erro, ou null se tem obra.
const noObra = (device, cors) => (obraKey(device.obra) ? null : json({ error: 'device_without_obra' }, 403, cors))

// ------------------------------------------------------------------ autenticação do tablet: chave por dispositivo
// Cada tablet gera uma chave ECDSA P-256 que o navegador não deixa exportar; o relay só tem a parte pública (devices.pub_key). Cada
// pedido leva x-device-id, x-timestamp, x-nonce e x-signature = assinatura de
//   método \n caminho+query \n timestamp \n nonce \n id do dispositivo \n sha256(corpo)
// A hora tem de estar a menos de 5 minutos do relay (senão responde bad_timestamp com a hora do relay, para o tablet se acertar) e o
// nonce não pode repetir-se (device_nonces). Já não há token: copiar o que está no tablet não dá nada que se use noutro sítio.
// Devolve { device } ou { error: Response }. Mesma resposta para dispositivo desconhecido, sem chave, revogado ou assinatura errada.
async function authDevice(request, url, env, bodyText) {
  const cors = corsHeaders(env)
  const deviceId = request.headers.get('x-device-id') || ''
  const ts = request.headers.get('x-timestamp') || ''
  const nonce = request.headers.get('x-nonce') || ''
  const sig = request.headers.get('x-signature') || ''
  if (!deviceId || !/^\d{1,12}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{80,100}$/.test(sig)) {
    return { error: json({ error: 'missing_signature' }, 401, cors) }
  }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > SIGNATURE_SKEW_S) {
    return { error: json({ error: 'bad_timestamp', serverTime: new Date().toISOString() }, 401, cors) }
  }
  const device = await env.DB.prepare('SELECT id, pub_key, active, obra FROM devices WHERE id = ?').bind(deviceId).first()
  let ok = false
  if (device?.active && device.pub_key) {
    try {
      const key = await crypto.subtle.importKey('spki', unb64u(device.pub_key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      const msg = enc.encode(`${request.method}\n${url.pathname}${url.search}\n${ts}\n${nonce}\n${deviceId}\n${await sha256Hex(bodyText)}`)
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(sig), msg)
    } catch {
      ok = false
    }
  }
  if (!ok) return { error: json({ error: 'invalid_device' }, 401, cors) }
  // pedido já visto? Guarda-se o nonce e limpam-se os antigos (os de mais de 10 minutos já não passam a verificação da hora)
  const [seen] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO device_nonces (device_id, nonce, ts) VALUES (?, ?, ?)').bind(deviceId, nonce, Number(ts)),
    env.DB.prepare('DELETE FROM device_nonces WHERE ts < ?').bind(Math.floor(Date.now() / 1000) - SIGNATURE_SKEW_S * 2),
  ])
  if (!seen.meta.changes) return { error: json({ error: 'replay' }, 401, cors) }
  await touchDevice(env, deviceId)
  return { device }
}

// Ligar um tablet: POST /enroll com o código de instalação (uso único, cabeçalho x-enroll-code) e a chave pública do tablet. O tablet
// prova que tem a chave privada assinando { id, hora, chave pública }. O código gasta-se (token_hash fica '') e deixa de servir.
// Os tokens antigos (anteriores a esta versão) valem como código, uma só vez: é assim que os tablets existentes migram sozinhos.
async function handleEnroll(request, url, env) {
  const cors = corsHeaders(env)
  const code = (request.headers.get('x-enroll-code') || '').trim()
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413, cors)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }
  const deviceId = String(body?.deviceId ?? '')
  const publicKey = String(body?.publicKey ?? '')
  const proof = String(body?.proof ?? '')
  const ts = String(body?.ts ?? '')
  if (!code || code.length > 128 || !deviceId || !/^[A-Za-z0-9_-]{80,200}$/.test(publicKey) || !/^[A-Za-z0-9_-]{80,100}$/.test(proof) || !/^\d{1,12}$/.test(ts)) {
    return json({ error: 'invalid_payload' }, 400, cors)
  }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > SIGNATURE_SKEW_S) return json({ error: 'bad_timestamp', serverTime: new Date().toISOString() }, 401, cors)
  let proven = false
  try {
    const key = await crypto.subtle.importKey('spki', unb64u(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    proven = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(proof), enc.encode(`enroll\n${deviceId}\n${ts}\n${publicKey}`))
  } catch {
    proven = false
  }
  if (!proven) return json({ error: 'invalid_enrollment' }, 401, cors)
  const device = await env.DB.prepare('SELECT token_hash, active, code_expires FROM devices WHERE id = ?').bind(deviceId).first()
  const nowS = Math.floor(Date.now() / 1000)
  // o código aceita-se como foi escrito ou sem espaços e hífenes e em maiúsculas (os códigos novos são assim: XXXX-XXXX-XXXX-XXXX)
  const hashes = [await sha256Hex(code), await sha256Hex(code.replace(/[\s-]/g, '').toUpperCase())]
  const match = device && device.active && device.token_hash && (!device.code_expires || device.code_expires > nowS) && hashes.find((h) => timingSafeEqualHex(device.token_hash, h))
  if (!match) return json({ error: 'invalid_enrollment' }, 401, cors) // mesma resposta para tudo: não revela que dispositivos existem
  // gasta o código só se continua o mesmo (dois pedidos com o mesmo código: só um ganha)
  const done = await env.DB.prepare("UPDATE devices SET pub_key = ?, token_hash = '', enrolled_at = ?, code_expires = NULL WHERE id = ? AND token_hash = ?").bind(publicKey, nowS, deviceId, device.token_hash).run()
  if (!done.meta.changes) return json({ error: 'invalid_enrollment' }, 401, cors)
  return json({ ok: true, serverTime: new Date().toISOString() }, 200, cors)
}

// ------------------------------------------------------------------ tablet → relay
async function handlePunch(request, url, env) {
  const cors = corsHeaders(env)
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413, cors)
  const auth = await authDevice(request, url, env, text)
  if (auth.error) return auth.error
  const device = auth.device
  const deviceId = device.id
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }
  if (body?.deviceId !== undefined && String(body.deviceId) !== deviceId) return json({ error: 'device_mismatch' }, 400, cors)
  const punches = Array.isArray(body?.punches) ? body.punches : []
  if (!punches.length || punches.length > MAX_BATCH) return json({ error: 'invalid_payload' }, 400, cors)

  const missing = noObra(device, cors)
  if (missing) return missing
  const deviceObra = device.obra.trim() // a obra de todas as picagens deste dispositivo

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
      obraKey(p.obra) === obraKey(deviceObra) && // um tablet só pica na obra que o relay lhe atribuiu
      DIRECTIONS.includes(p.direction) &&
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
      obra: deviceObra,
      direction: p.direction,
      punchedAt: new Date(t).toISOString(),
      confidence: similarity(p.confidence),
      // dados para afinar o reconhecimento; se vierem inválidos ficam a null (não rejeitam a picagem)
      second: unit(p.second),
      real: unit(p.real),
      live: unit(p.live),
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

// ------------------------------------------------------------------ tablet → relay: apagar picagens
// Corpo: { deviceId, eventIds: [...] }. O tablet só pode apagar picagens do próprio dispositivo (o eventId começa pelo
// ID do dispositivo). Se a picagem ainda está no relay à espera do Supabase, sai de lá; o pedido fica sempre registado
// para o Supabase apagar a que já tenha gravado (ele processa as picagens antes dos pedidos de apagar).
async function handleDelete(request, url, env) {
  const cors = corsHeaders(env)
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413, cors)
  const auth = await authDevice(request, url, env, text)
  if (auth.error) return auth.error
  const deviceId = auth.device.id
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }
  if (body?.deviceId !== undefined && String(body.deviceId) !== deviceId) return json({ error: 'device_mismatch' }, 400, cors)
  const ids = body?.eventIds
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH) return json({ error: 'invalid_payload' }, 400, cors)

  const valid = ids.filter((i) => typeof i === 'string' && i.length <= 64 && i.startsWith(`${deviceId}-`))
  const now = Math.floor(Date.now() / 1000)
  const stmts = []
  for (const id of valid) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO deletions (event_id, device_id, received_at) VALUES (?, ?, ?)').bind(id, deviceId, now))
    stmts.push(env.DB.prepare('DELETE FROM outbox WHERE event_id = ?').bind(id))
  }
  if (stmts.length) await env.DB.batch(stmts)
  return json({ accepted: valid }, 200, cors)
}

// ------------------------------------------------------------------ Supabase → relay: pedidos de apagar
async function handlePullDeletions(request, url, env) {
  if (!(await verifySignature(request, url, '', env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  const { results } = await env.DB.prepare('SELECT event_id, device_id FROM deletions ORDER BY seq LIMIT ?').bind(MAX_PULL).all()
  return json({ deletions: results.map((r) => ({ eventId: r.event_id, deviceId: r.device_id })) })
}

async function handleAckDeletions(request, url, env) {
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
    stmts.push(env.DB.prepare(`DELETE FROM deletions WHERE event_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk))
  }
  if (stmts.length) await env.DB.batch(stmts)
  return json({ deleted: ids.length })
}

// ------------------------------------------------------------------ Supabase → relay: lista de trabalhadores
// Corpo: { gen, final, workers: [{ sageId, name, obra, active }] }. O Supabase envia a lista em blocos com o mesmo `gen`;
// no último bloco (`final`) apagam-se os registos de envios anteriores (quem saiu da lista desaparece).
async function handleRosterPost(request, url, env) {
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413)
  if (!(await verifySignature(request, url, text, env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const gen = body?.gen
  const workers = body?.workers
  if (!Number.isSafeInteger(gen) || gen <= 0 || !Array.isArray(workers) || workers.length > MAX_ROSTER_CHUNK) return json({ error: 'invalid_payload' }, 400)
  const valid = (w) =>
    typeof w?.sageId === 'string' && w.sageId.trim() !== '' && w.sageId.length <= 32 &&
    typeof w?.name === 'string' && w.name.trim() !== '' && w.name.length <= 120 &&
    typeof w?.obra === 'string' && w.obra.trim() !== '' && w.obra.length <= 64
  const stmts = []
  let rejected = 0
  for (const w of workers) {
    if (!valid(w)) {
      rejected++
      continue
    }
    stmts.push(
      env.DB.prepare(
        'INSERT INTO roster (sage_id, obra, name, active, gen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sage_id, obra) DO UPDATE SET name = excluded.name, active = excluded.active, gen = excluded.gen',
      ).bind(w.sageId.trim(), w.obra.trim(), w.name.trim(), w.active === false ? 0 : 1, gen),
    )
  }
  if (body.final === true) stmts.push(env.DB.prepare('DELETE FROM roster WHERE gen <> ?').bind(gen))
  if (stmts.length) await env.DB.batch(stmts)
  return json({ stored: workers.length - rejected, rejected })
}

// ------------------------------------------------------------------ tablet ← relay: lista da obra do tablet
// GET /roster?device=<id>&obra=<obra>&since=<gen>  (pedido assinado pelo tablet)
// A obra é a do dispositivo no relay (o tablet não consegue pedir outras obras; `obra` na pergunta já não conta).
// A obra compara-se sem distinguir maiúsculas nem espaços nas pontas, como a intranet (db/305).
async function handleRosterGet(request, url, env) {
  const cors = corsHeaders(env)
  const auth = await authDevice(request, url, env, '')
  if (auth.error) return auth.error
  const device = auth.device
  if (url.searchParams.get('device') !== device.id) return json({ error: 'device_mismatch' }, 400, cors)
  const missing = noObra(device, cors)
  if (missing) return missing
  const obra = device.obra.trim()

  const head = await env.DB.prepare('SELECT MAX(gen) AS gen FROM roster').first()
  const generatedAt = head?.gen ?? 0
  if (generatedAt && Number(url.searchParams.get('since')) === generatedAt) return json({ unchanged: true, generatedAt }, 200, cors)

  const { results } = await env.DB.prepare('SELECT sage_id, name FROM roster WHERE lower(trim(obra)) = lower(?) AND active = 1 ORDER BY name LIMIT ?').bind(obra, MAX_ROSTER_LIST).all()
  return json({ generatedAt, obra, workers: results.map((r) => ({ sageId: r.sage_id, name: r.name })) }, 200, cors)
}

// ------------------------------------------------------------------ Supabase → relay: estado dos relógios
// Para cada dispositivo: se está ativo, a obra, o último contacto (segundos unix, ou null se nunca falou) e
// quantas picagens estão no relay à espera do Supabase. `now` é a hora do relay, para quem lê não depender do
// relógio do seu próprio computador.
async function handleDevicesStatus(request, url, env) {
  if (!(await verifySignature(request, url, '', env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  const { results } = await env.DB.prepare(
    'SELECT d.id, d.active, d.obra, d.last_seen, (d.pub_key IS NOT NULL) AS enrolled, (SELECT COUNT(*) FROM outbox o WHERE o.device_id = d.id) AS backlog FROM devices d ORDER BY d.id',
  ).all()
  return json({
    now: Math.floor(Date.now() / 1000),
    devices: results.map((r) => ({ id: r.id, active: r.active === 1, obra: r.obra, lastSeen: r.last_seen, enrolled: r.enrolled === 1, backlog: r.backlog })),
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' && ['/enroll', '/punch', '/punch/delete', '/roster'].includes(url.pathname)) return new Response(null, { status: 204, headers: corsHeaders(env) })
    if (request.method === 'POST' && url.pathname === '/enroll') return handleEnroll(request, url, env)
    if (request.method === 'POST' && url.pathname === '/punch/delete') return handleDelete(request, url, env)
    if (request.method === 'GET' && url.pathname === '/pull-deletions') return handlePullDeletions(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack-deletions') return handleAckDeletions(request, url, env)
    if (request.method === 'POST' && url.pathname === '/roster') return handleRosterPost(request, url, env)
    if (request.method === 'GET' && url.pathname === '/roster') return handleRosterGet(request, url, env)
    if (request.method === 'POST' && url.pathname === '/punch') return handlePunch(request, url, env)
    if (request.method === 'GET' && url.pathname === '/pull') return handlePull(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack') return handleAck(request, url, env)
    if (request.method === 'GET' && url.pathname === '/devices-status') return handleDevicesStatus(request, url, env)
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true })
    return json({ error: 'not_found' }, 404)
  },
}
