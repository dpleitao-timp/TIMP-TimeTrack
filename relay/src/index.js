// Relay de picagens (Cloudflare Worker + D1).
//
//   Tablet  ── POST /punch ──►  [outbox]  ◄── GET /pull, POST /ack ──  Supabase
//   Tablet  ◄── GET /roster ──  [roster]  ◄── POST /roster ──  Supabase
//   Tablet  ── POST /punch/delete ──►  [deletions]  ◄── GET /pull-deletions, POST /ack-deletions ──  Supabase
//   Tablet  ── qualquer pedido autenticado ──►  [devices.last_seen]  ◄── GET /devices-status ──  Supabase (função relay-status da intranet)
//   Tablet  ── POST /biometrics ──►  [bio_outbox]  ◄── GET /pull-bio, POST /ack-bio ──  Supabase   (biometria cifrada pelos tablets)
//   Tablet  ◄── POST /bio-fetch ──  [bio_store]  ◄── POST /bio-store ──  Supabase
//   Tablet  ── POST /bio-delete ──►  [bio_del_outbox]  ◄── GET /pull-bio-deletions, POST /ack-bio-deletions ──  Supabase   (apagar biometria)
//   Tablet  ◄── POST /bio-deleted ──  [bio_tombstones]  ◄── POST /bio-tombstones ──  Supabase
//
// O tablet escreve picagens (e pedidos para as apagar) e lê a lista de trabalhadores (token do dispositivo). O Supabase lê as picagens,
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
  const text = await request.text()
  return text.length > MAX_BODY_BYTES ? null : text
}

// número entre 0 e 1, ou null
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)

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

  await touchDevice(env, deviceId)

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
      obra: p.obra.trim(),
      direction: p.direction,
      punchedAt: new Date(t).toISOString(),
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
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
async function handleDelete(request, env) {
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
  const ids = body?.eventIds
  if (!deviceId || !Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH) return json({ error: 'invalid_payload' }, 400, cors)

  const device = await env.DB.prepare('SELECT token_hash, active FROM devices WHERE id = ?').bind(deviceId).first()
  if (!device || !device.active || !timingSafeEqualHex(device.token_hash, await sha256Hex(token))) {
    return json({ error: 'invalid_device' }, 401, cors)
  }
  await touchDevice(env, deviceId)
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
// GET /roster?device=<id>&obra=<obra>&since=<gen>  (cabeçalho x-device-token)
// Se o dispositivo tem obra definida no relay, usa-se essa (o tablet não consegue pedir outras obras).
// A obra compara-se sem distinguir maiúsculas nem espaços nas pontas, como a intranet (db/305).
async function handleRosterGet(request, url, env) {
  const cors = corsHeaders(env)
  const token = request.headers.get('x-device-token')
  const deviceId = url.searchParams.get('device') || ''
  if (!token || !deviceId) return json({ error: 'missing_token' }, 401, cors)
  const device = await env.DB.prepare('SELECT token_hash, active, obra FROM devices WHERE id = ?').bind(deviceId).first()
  if (!device || !device.active || !timingSafeEqualHex(device.token_hash, await sha256Hex(token))) {
    return json({ error: 'invalid_device' }, 401, cors)
  }
  await touchDevice(env, deviceId)
  const obra = (device.obra || url.searchParams.get('obra') || '').trim()
  if (!obra) return json({ error: 'missing_obra' }, 400, cors)

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
    'SELECT d.id, d.active, d.obra, d.last_seen, (SELECT COUNT(*) FROM outbox o WHERE o.device_id = d.id) AS backlog FROM devices d ORDER BY d.id',
  ).all()
  return json({
    now: Math.floor(Date.now() / 1000),
    devices: results.map((r) => ({ id: r.id, active: r.active === 1, obra: r.obra, lastSeen: r.last_seen, backlog: r.backlog })),
  })
}

// ------------------------------------------------------------------ biometria
// O relay só transporta BLOBS CIFRADOS pelos tablets (AES-GCM com a chave da frota, que o relay e o Supabase não têm):
// nunca vê um vetor. Mesmo desenho das picagens:
//   tablet ── POST /biometrics ──► [bio_outbox] ◄── GET /pull-bio, POST /ack-bio ── Supabase
//   tablet ◄── POST /bio-fetch ── [bio_store]  ◄── POST /bio-store ── Supabase (de 6 em 6 horas, com a lista)
// Chave de cada registo: (sage_id, engine). O motor faz parte dela porque os vetores de um motor não servem noutro.
const MAX_BIO_BLOB = 150_000 // caracteres de um blob
const MAX_BIO_ITEMS = 50
const MAX_BIO_BACKLOG = 5000
const MAX_BIO_ACK = 100

const bioItemValid = (i) =>
  typeof i?.sageId === 'string' && i.sageId.trim() !== '' && i.sageId.trim().length <= 32 &&
  typeof i?.engine === 'string' && /^[a-z0-9-]{1,32}$/.test(i.engine) &&
  typeof i?.blob === 'string' && i.blob.length >= 16 && i.blob.length <= MAX_BIO_BLOB &&
  Number.isFinite(i?.updatedAt)

// Lê o corpo JSON de um pedido de tablet e autentica o dispositivo. Devolve { body, device } ou { error: Response }.
async function tabletRequest(request, env) {
  const cors = corsHeaders(env)
  const token = request.headers.get('x-device-token')
  if (!token) return { error: json({ error: 'missing_token' }, 401, cors) }
  const text = await readBody(request)
  if (text === null) return { error: json({ error: 'too_large' }, 413, cors) }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { error: json({ error: 'invalid_json' }, 400, cors) }
  }
  const deviceId = String(body?.deviceId ?? '')
  if (!deviceId) return { error: json({ error: 'invalid_payload' }, 400, cors) }
  const device = await env.DB.prepare('SELECT token_hash, active, obra FROM devices WHERE id = ?').bind(deviceId).first()
  if (!device || !device.active || !timingSafeEqualHex(device.token_hash, await sha256Hex(token))) {
    return { error: json({ error: 'invalid_device' }, 401, cors) }
  }
  await touchDevice(env, deviceId)
  return { body, device, deviceId }
}

// Tablet → relay. Corpo: { deviceId, items: [{ sageId, engine, blob, updatedAt }] }. Fica um só registo por (sage_id, engine):
// o mais recente substitui o anterior. Devolve accepted/rejected como "sageId|engine".
async function handleBioPost(request, env) {
  const cors = corsHeaders(env)
  const r = await tabletRequest(request, env)
  if (r.error) return r.error
  const items = Array.isArray(r.body?.items) ? r.body.items : []
  if (!items.length || items.length > MAX_BIO_ITEMS) return json({ error: 'invalid_payload' }, 400, cors)
  const backlog = await env.DB.prepare('SELECT COUNT(*) AS n FROM bio_outbox').first()
  if (backlog.n >= MAX_BIO_BACKLOG) return json({ error: 'backlog_full' }, 429, cors)

  const now = Math.floor(Date.now() / 1000)
  const stmts = []
  const accepted = []
  const rejected = []
  for (const i of items) {
    const key = `${String(i?.sageId ?? '').trim()}|${i?.engine}`
    if (!bioItemValid(i)) {
      rejected.push(key)
      continue
    }
    stmts.push(
      env.DB.prepare(
        'INSERT INTO bio_outbox (sage_id, engine, device_id, blob, blob_hash, updated_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(sage_id, engine) DO UPDATE SET device_id = excluded.device_id, blob = excluded.blob, blob_hash = excluded.blob_hash, updated_at = excluded.updated_at, received_at = excluded.received_at',
      ).bind(i.sageId.trim(), i.engine, r.deviceId, i.blob, await sha256Hex(i.blob), Math.floor(i.updatedAt), now),
    )
    accepted.push(key)
  }
  if (stmts.length) await env.DB.batch(stmts)
  return json({ accepted, rejected }, 200, cors)
}

// Supabase lê o que os tablets enviaram.
async function handlePullBio(request, url, env) {
  if (!(await verifySignature(request, url, '', env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), MAX_BIO_ITEMS)
  const { results } = await env.DB.prepare('SELECT sage_id, engine, device_id, blob, blob_hash, updated_at FROM bio_outbox ORDER BY received_at LIMIT ?').bind(limit).all()
  return json({ items: results.map((x) => ({ sageId: x.sage_id, engine: x.engine, deviceId: x.device_id, blob: x.blob, hash: x.blob_hash, updatedAt: x.updated_at })) })
}

// Supabase confirma o que gravou. O hash garante que só sai do relay o blob que foi lido (se o tablet enviou outro
// entretanto, esse fica para a próxima).
async function handleAckBio(request, url, env) {
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413)
  if (!(await verifySignature(request, url, text, env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  let items
  try {
    items = JSON.parse(text)?.items
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!Array.isArray(items) || items.length > MAX_BIO_ACK || items.some((i) => typeof i?.sageId !== 'string' || typeof i?.engine !== 'string' || typeof i?.hash !== 'string')) {
    return json({ error: 'invalid_payload' }, 400)
  }
  const stmts = items.map((i) => env.DB.prepare('DELETE FROM bio_outbox WHERE sage_id = ? AND engine = ? AND blob_hash = ?').bind(i.sageId, i.engine, i.hash))
  if (stmts.length) await env.DB.batch(stmts)
  return json({ deleted: items.length })
}

// Supabase publica a biometria para os tablets. Corpo: { gen, final, items: [{ sageId, engine, blob, updatedAt }] }, em blocos com o
// mesmo `gen`; no último (`final`) apagam-se os registos de envios anteriores.
async function handleBioStore(request, url, env) {
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
  const items = body?.items
  if (!Number.isSafeInteger(gen) || gen <= 0 || !Array.isArray(items) || items.length > MAX_BIO_ITEMS) return json({ error: 'invalid_payload' }, 400)
  const stmts = []
  let rejected = 0
  for (const i of items) {
    if (!bioItemValid(i)) {
      rejected++
      continue
    }
    stmts.push(
      env.DB.prepare(
        'INSERT INTO bio_store (sage_id, engine, blob, updated_at, gen) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(sage_id, engine) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at, gen = excluded.gen',
      ).bind(i.sageId.trim(), i.engine, i.blob, Math.floor(i.updatedAt), gen),
    )
  }
  if (body.final === true) stmts.push(env.DB.prepare('DELETE FROM bio_store WHERE gen <> ?').bind(gen))
  if (stmts.length) await env.DB.batch(stmts)
  return json({ stored: items.length - rejected, rejected })
}

// Tablet ← relay. Corpo: { deviceId, engine, obra?, ids: [sageId...] }. Só devolve a biometria dos trabalhadores ativos da OBRA
// DO TABLET (a do dispositivo no relay, ou a que o tablet diz se o dispositivo não tem) e do motor pedido.
async function handleBioFetch(request, env) {
  const cors = corsHeaders(env)
  const r = await tabletRequest(request, env)
  if (r.error) return r.error
  const engine = String(r.body?.engine ?? '')
  const ids = r.body?.ids
  if (!/^[a-z0-9-]{1,32}$/.test(engine) || !Array.isArray(ids) || !ids.length || ids.length > MAX_BIO_ITEMS || ids.some((i) => typeof i !== 'string' || !i.trim() || i.length > 32)) {
    return json({ error: 'invalid_payload' }, 400, cors)
  }
  const obra = (r.device.obra || String(r.body?.obra ?? '')).trim()
  if (!obra) return json({ error: 'missing_obra' }, 400, cors)
  const { results } = await env.DB.prepare(
    `SELECT s.sage_id, s.engine, s.blob, s.updated_at FROM bio_store s WHERE s.engine = ? AND s.sage_id IN (${ids.map(() => '?').join(',')}) ` +
      'AND s.sage_id IN (SELECT sage_id FROM roster WHERE lower(trim(obra)) = lower(?) AND active = 1)',
  ).bind(engine, ...ids.map((i) => i.trim()), obra).all()
  return json({ items: results.map((x) => ({ sageId: x.sage_id, engine: x.engine, blob: x.blob, updatedAt: x.updated_at })) }, 200, cors)
}

// ------------------------------------------------------------------ apagar biometria
// Um tablet apaga um trabalhador e isso tem de chegar a todos os tablets e ao Supabase. O pedido é uma "lápide" cifrada pelo
// tablet com a chave da frota (o relay e o Supabase não a leem; os tablets só obedecem às que abrem). Mesmo caminho das picagens:
//   tablet ── POST /bio-delete ──► [bio_del_outbox] ◄── GET /pull-bio-deletions, POST /ack-bio-deletions ── Supabase
//   tablet ◄── POST /bio-deleted ── [bio_tombstones] ◄── POST /bio-tombstones ── Supabase (de 6 em 6 horas)
// Ao receber o pedido o relay tira logo a biometria (já feita antes do apagar) do que ainda não saiu, e regista a lápide já.
const MAX_DEL_BLOB = 4000
const MAX_TOMBSTONES = 3000

const delItemValid = (i) =>
  typeof i?.sageId === 'string' && i.sageId.trim() !== '' && i.sageId.trim().length <= 32 &&
  typeof i?.blob === 'string' && i.blob.length >= 16 && i.blob.length <= MAX_DEL_BLOB &&
  Number.isFinite(i?.deletedAt)

// Tablet → relay. Corpo: { deviceId, items: [{ sageId, blob, deletedAt }] }. Devolve accepted/rejected (SAGE IDs).
async function handleBioDelete(request, env) {
  const cors = corsHeaders(env)
  const r = await tabletRequest(request, env)
  if (r.error) return r.error
  const items = Array.isArray(r.body?.items) ? r.body.items : []
  if (!items.length || items.length > MAX_BIO_ITEMS) return json({ error: 'invalid_payload' }, 400, cors)
  const now = Math.floor(Date.now() / 1000)
  const stmts = []
  const accepted = []
  const rejected = []
  for (const i of items) {
    if (!delItemValid(i)) {
      if (typeof i?.sageId === 'string' && i.sageId.trim()) rejected.push(i.sageId.trim())
      continue
    }
    const id = i.sageId.trim()
    const at = Math.floor(i.deletedAt)
    stmts.push(
      env.DB.prepare(
        'INSERT INTO bio_del_outbox (sage_id, device_id, blob, blob_hash, deleted_at, received_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(sage_id) DO UPDATE SET device_id = excluded.device_id, blob = excluded.blob, blob_hash = excluded.blob_hash, deleted_at = excluded.deleted_at, received_at = excluded.received_at WHERE excluded.deleted_at >= bio_del_outbox.deleted_at',
      ).bind(id, r.deviceId, i.blob, await sha256Hex(i.blob), at, now),
      env.DB.prepare('DELETE FROM bio_outbox WHERE sage_id = ? AND updated_at <= ?').bind(id, at),
      env.DB.prepare('DELETE FROM bio_store WHERE sage_id = ? AND updated_at <= ?').bind(id, at),
      env.DB.prepare(
        'INSERT INTO bio_tombstones (sage_id, blob, deleted_at, gen, received_at) VALUES (?, ?, ?, 0, ?) ' +
          'ON CONFLICT(sage_id) DO UPDATE SET blob = excluded.blob, deleted_at = excluded.deleted_at, received_at = excluded.received_at WHERE excluded.deleted_at >= bio_tombstones.deleted_at',
      ).bind(id, i.blob, at, now),
    )
    accepted.push(id)
  }
  if (stmts.length) await env.DB.batch(stmts)
  return json({ accepted, rejected }, 200, cors)
}

// Supabase lê os pedidos de apagar.
async function handlePullBioDeletions(request, url, env) {
  if (!(await verifySignature(request, url, '', env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), MAX_PULL)
  const { results } = await env.DB.prepare('SELECT sage_id, device_id, blob, blob_hash, deleted_at FROM bio_del_outbox ORDER BY received_at LIMIT ?').bind(limit).all()
  return json({ items: results.map((x) => ({ sageId: x.sage_id, deviceId: x.device_id, blob: x.blob, hash: x.blob_hash, deletedAt: x.deleted_at })) })
}

// Supabase confirma o que aplicou (com o hash: um pedido mais recente do mesmo trabalhador fica para a próxima).
async function handleAckBioDeletions(request, url, env) {
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413)
  if (!(await verifySignature(request, url, text, env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  let items
  try {
    items = JSON.parse(text)?.items
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!Array.isArray(items) || items.length > MAX_ACK || items.some((i) => typeof i?.sageId !== 'string' || typeof i?.hash !== 'string')) return json({ error: 'invalid_payload' }, 400)
  const stmts = items.map((i) => env.DB.prepare('DELETE FROM bio_del_outbox WHERE sage_id = ? AND blob_hash = ?').bind(i.sageId, i.hash))
  if (stmts.length) await env.DB.batch(stmts)
  return json({ deleted: items.length })
}

// Supabase publica as lápides para os tablets. Corpo: { gen, final, items: [{ sageId, blob, deletedAt }] }.
async function handleBioTombstones(request, url, env) {
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
  const items = body?.items
  if (!Number.isSafeInteger(gen) || gen <= 0 || !Array.isArray(items) || items.length > 500) return json({ error: 'invalid_payload' }, 400)
  const now = Math.floor(Date.now() / 1000)
  const stmts = []
  let rejected = 0
  for (const i of items) {
    if (!delItemValid(i)) {
      rejected++
      continue
    }
    stmts.push(
      env.DB.prepare(
        'INSERT INTO bio_tombstones (sage_id, blob, deleted_at, gen, received_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(sage_id) DO UPDATE SET blob = excluded.blob, deleted_at = excluded.deleted_at, gen = excluded.gen, received_at = excluded.received_at WHERE excluded.deleted_at >= bio_tombstones.deleted_at',
      ).bind(i.sageId.trim(), i.blob, Math.floor(i.deletedAt), gen, now),
    )
  }
  // no último bloco saem as lápides de envios anteriores (já expiradas no Supabase); as de gen 0 (pedidos ainda não publicados) ficam
  if (body.final === true) stmts.push(env.DB.prepare('DELETE FROM bio_tombstones WHERE gen <> ? AND gen <> 0').bind(gen))
  if (stmts.length) await env.DB.batch(stmts)
  return json({ stored: items.length - rejected, rejected })
}

// Tablet ← relay. Corpo: { deviceId, since? }. Devolve todas as lápides, ou só { unchanged: true } se nada mudou desde `since`.
async function handleBioDeleted(request, env) {
  const cors = corsHeaders(env)
  const r = await tabletRequest(request, env)
  if (r.error) return r.error
  const head = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(gen), 0) AS g, COALESCE(MAX(received_at), 0) AS r FROM bio_tombstones').first()
  const version = `${head.g}.${head.n}.${head.r}`
  if (r.body?.since === version) return json({ unchanged: true, version }, 200, cors)
  const { results } = await env.DB.prepare('SELECT sage_id, blob, deleted_at FROM bio_tombstones ORDER BY deleted_at LIMIT ?').bind(MAX_TOMBSTONES).all()
  return json({ version, items: results.map((x) => ({ sageId: x.sage_id, blob: x.blob, deletedAt: x.deleted_at })) }, 200, cors)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' && ['/punch', '/punch/delete', '/roster', '/biometrics', '/bio-fetch', '/bio-delete', '/bio-deleted'].includes(url.pathname)) return new Response(null, { status: 204, headers: corsHeaders(env) })
    if (request.method === 'POST' && url.pathname === '/biometrics') return handleBioPost(request, env)
    if (request.method === 'POST' && url.pathname === '/bio-delete') return handleBioDelete(request, env)
    if (request.method === 'POST' && url.pathname === '/bio-deleted') return handleBioDeleted(request, env)
    if (request.method === 'GET' && url.pathname === '/pull-bio-deletions') return handlePullBioDeletions(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack-bio-deletions') return handleAckBioDeletions(request, url, env)
    if (request.method === 'POST' && url.pathname === '/bio-tombstones') return handleBioTombstones(request, url, env)
    if (request.method === 'POST' && url.pathname === '/bio-fetch') return handleBioFetch(request, env)
    if (request.method === 'GET' && url.pathname === '/pull-bio') return handlePullBio(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack-bio') return handleAckBio(request, url, env)
    if (request.method === 'POST' && url.pathname === '/bio-store') return handleBioStore(request, url, env)
    if (request.method === 'POST' && url.pathname === '/punch/delete') return handleDelete(request, env)
    if (request.method === 'GET' && url.pathname === '/pull-deletions') return handlePullDeletions(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack-deletions') return handleAckDeletions(request, url, env)
    if (request.method === 'POST' && url.pathname === '/roster') return handleRosterPost(request, url, env)
    if (request.method === 'GET' && url.pathname === '/roster') return handleRosterGet(request, url, env)
    if (request.method === 'POST' && url.pathname === '/punch') return handlePunch(request, env)
    if (request.method === 'GET' && url.pathname === '/pull') return handlePull(request, url, env)
    if (request.method === 'POST' && url.pathname === '/ack') return handleAck(request, url, env)
    if (request.method === 'GET' && url.pathname === '/devices-status') return handleDevicesStatus(request, url, env)
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true })
    return json({ error: 'not_found' }, 404)
  },
}
