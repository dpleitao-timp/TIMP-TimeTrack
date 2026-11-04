// Relay de picagens (Cloudflare Worker + D1).
//
//   Tablet  ── POST /punch ──►  [outbox]  ◄── GET /pull, POST /ack ──  Supabase
//   Tablet  ◄── GET /roster ──  [roster]  ◄── POST /roster ──  Supabase
//   Tablet  ── POST /punch/delete ──►  [deletions]  ◄── GET /pull-deletions, POST /ack-deletions ──  Supabase
//   Tablet  ── qualquer pedido autenticado ──►  [devices.last_seen]  ◄── GET /devices-status ──  Supabase (função relay-status da intranet)
//   [devices, device_obras]  ◄── POST /devices-config ──  Supabase (função relay-device-config da intranet: registar, obras, revogar)
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
const MAX_ROSTER_LIST = 10000 // linhas (trabalhador e obra) devolvidas a um tablet; um relógio de várias obras pode receber a empresa toda

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

// As respostas têm dados de pessoas e do estado dos tablets: nunca ficam em cache, e o navegador não adivinha o tipo.
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } })

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

// O ID de uma picagem é `<id do dispositivo>-<contador>`: o prefixo tem de ser o do dispositivo E a seguir só dígitos. Só com o prefixo, o dispositivo
// `dev-1` podia enviar `dev-1-2-000001` e ficar com o ID de uma picagem do dispositivo `dev-1-2` (que depois seria ignorada como repetida) ou apagá-la.
const eventIdOk = (deviceId, id) => typeof id === 'string' && id.length <= 64 && id.startsWith(`${deviceId}-`) && /^\d+$/.test(id.slice(deviceId.length + 1))

// A obra compara-se sem maiúsculas nem espaços nas pontas (como a intranet).
const obraKey = (s) => String(s ?? '').trim().toLowerCase()

// Cada dispositivo tem uma obra FIXA no relay (devices.obra): é ela, e não o que o tablet diz, que manda. Sem obra, o dispositivo
// não pode picar nem ler a lista de trabalhadores (o `add-device.mjs` pede a obra). Devolve a Response de erro, ou null se tem obra.
const noObra = (device, cors) => (obraKey(device.obra) ? null : json({ error: 'device_without_obra' }, 403, cors))

// Obras em que o dispositivo pode picar: a sua obra fixa (a primeira, a por defeito) e as extra de `device_obras` (relógios que servem várias
// obras, como o da sede). Só o relay as define: o tablet não as pede nem as alarga. Sem extras, é só a fixa, como sempre. Se a tabela ainda não
// existe (migração 010 por aplicar) fica só a fixa, para o relay não deixar de aceitar picagens.
// A linha especial `*` em device_obras quer dizer "todas as obras da lista de trabalhadores" (as que têm trabalhadores ativos hoje): o relógio aceita e lista
// também as obras que vierem a existir, sem ninguém mexer no relay. Continua a valer a autorização de cada trabalhador (cada um só vê as suas obras).
const ALL_OBRAS = '*'
async function deviceObras(env, device) {
  const list = [device.obra.trim()]
  const add = (o) => {
    o = String(o ?? '').trim()
    if (o && o !== ALL_OBRAS && o.length <= 64 && !list.some((x) => obraKey(x) === obraKey(o))) list.push(o)
  }
  try {
    const { results } = await env.DB.prepare('SELECT obra FROM device_obras WHERE device_id = ? ORDER BY rowid').bind(device.id).all()
    const all = results.some((r) => String(r.obra ?? '').trim() === ALL_OBRAS)
    for (const r of results) add(r.obra)
    if (all) {
      const { results: rows } = await env.DB.prepare('SELECT DISTINCT obra FROM roster WHERE active = 1 ORDER BY obra').all()
      for (const r of rows) add(r.obra)
    }
  } catch (e) {
    console.error('device_obras:', e)
  }
  return list
}

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
  // Pedido já visto? Numa só ida à base de dados: guarda-se o nonce e atualiza-se o último contacto do tablet, mas só se o nonce era novo (`changes()` conta as
  // linhas da instrução anterior), por isso repetir um pedido apanhado não faz o tablet parecer vivo. Os nonces com mais de 10 minutos já não passam a
  // verificação da hora, por isso limpam-se só de vez em quando (1 pedido em 16) e não a cada pedido.
  const nowS = Math.floor(Date.now() / 1000)
  const stmts = [
    env.DB.prepare('INSERT OR IGNORE INTO device_nonces (device_id, nonce, ts) VALUES (?, ?, ?)').bind(deviceId, nonce, Number(ts)),
    env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND changes() > 0').bind(nowS, deviceId),
  ]
  if (Math.random() < 1 / 16) stmts.push(env.DB.prepare('DELETE FROM device_nonces WHERE ts < ?').bind(nowS - SIGNATURE_SKEW_S * 2))
  const [seen] = await env.DB.batch(stmts)
  if (!seen.meta.changes) return { error: json({ error: 'replay' }, 401, cors) }
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
  const allowedObras = await deviceObras(env, device) // a obra fixa do dispositivo e as extra que o relay lhe deu

  const backlog = await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox WHERE device_id = ?').bind(deviceId).first()
  if (backlog.n >= MAX_BACKLOG_PER_DEVICE) return json({ error: 'backlog_full' }, 429, cors)

  const now = Date.now()
  const stmts = []
  const accepted = []
  const rejected = []
  for (const p of punches) {
    const t = Date.parse(p?.punchedAt)
    // a obra da picagem tem de ser uma das deste dispositivo; fica gravada tal como o relay a tem (não como o tablet a escreveu)
    const punchObra = typeof p?.obra === 'string' ? allowedObras.find((o) => obraKey(o) === obraKey(p.obra)) : undefined
    const valid =
      eventIdOk(deviceId, p?.eventId) && // o ID tem de pertencer a este dispositivo
      typeof p?.sageId === 'string' &&
      p.sageId.trim() !== '' &&
      p.sageId.length <= 32 &&
      typeof p?.obra === 'string' &&
      p.obra.trim() !== '' &&
      p.obra.length <= 64 &&
      punchObra !== undefined && // um tablet só pica nas obras que o relay lhe atribuiu
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
      obra: punchObra,
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

  const valid = ids.filter((i) => eventIdOk(deviceId, i))
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

// Configuração do relógio definida na intranet (função e almoço/jantar), que o tablet aplica com a lista. null = a intranet não definiu. Se as colunas
// ainda não existem (migração 011 por aplicar) devolve tudo a null, para a lista continuar a funcionar.
async function deviceConfig(env, deviceId) {
  try {
    const c = await env.DB.prepare('SELECT mode, meal_punches FROM devices WHERE id = ?').bind(deviceId).first()
    return { mode: ['both', 'in', 'out'].includes(c?.mode) ? c.mode : null, mealPunches: c?.meal_punches === 0 || c?.meal_punches === 1 ? c.meal_punches === 1 : null }
  } catch (e) {
    console.error('device config:', e)
    return { mode: null, mealPunches: null }
  }
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
  const obras = await deviceObras(env, device) // [obra por defeito, ...extras]; só a por defeito na maioria dos relógios
  const multi = obras.length > 1
  // Assinatura do conjunto de obras: se o relay lhe der ou tirar obras, o tablet tem de ler a lista de novo mesmo sem lista nova do Supabase. O tablet
  // devolve-a em `set`; sem `set` (tablets antigos) só conta a geração. Fica vazia nos relógios de uma só obra.
  const sig = multi ? (await sha256Hex(obras.map(obraKey).sort().join('|'))).slice(0, 24) : '' // um resumo: a lista de obras pode ter dezenas de nomes

  const head = await env.DB.prepare('SELECT MAX(gen) AS gen FROM roster').first()
  const generatedAt = head?.gen ?? 0
  const setOk = !url.searchParams.has('set') || url.searchParams.get('set') === sig
  const config = await deviceConfig(env, device.id) // vai em todas as respostas: uma mudança na intranet chega ao tablet na leitura seguinte
  if (generatedAt && setOk && Number(url.searchParams.get('since')) === generatedAt) return json({ unchanged: true, generatedAt, obra, config }, 200, cors)

  if (!multi) {
    const { results } = await env.DB.prepare('SELECT sage_id, name FROM roster WHERE lower(trim(obra)) = lower(?) AND active = 1 ORDER BY name LIMIT ?').bind(obra, MAX_ROSTER_LIST).all()
    return json({ generatedAt, obra, obras, sig, config, workers: results.map((r) => ({ sageId: r.sage_id, name: r.name })) }, 200, cors)
  }

  // Relógio com várias obras: todos os trabalhadores ativos dessas obras, cada um com as obras em que está autorizado hoje (só as deste relógio,
  // pela ordem delas: a por defeito primeiro). A lista da Supabase já traz só as atribuições em vigor no dia.
  // O D1 só aceita 100 parâmetros por consulta: com muitas obras (relógio de "todas as obras") não se filtra no SQL, filtra-se aqui.
  const filterSql = obras.length <= 90
  const marks = obras.map(() => 'lower(?)').join(',')
  const { results } = await env.DB.prepare(`SELECT sage_id, name, obra FROM roster WHERE ${filterSql ? `lower(trim(obra)) IN (${marks}) AND ` : ''}active = 1 ORDER BY name, sage_id LIMIT ?`)
    .bind(...(filterSql ? obras : []), MAX_ROSTER_LIST)
    .all()
  if (results.length >= MAX_ROSTER_LIST) console.error('roster: lista cortada no limite de', MAX_ROSTER_LIST, 'linhas')
  const canon = new Map(obras.map((o) => [obraKey(o), o])) // obra (sem maiúsculas) → nome do relay
  const bySage = new Map()
  for (const r of results) {
    const mine = canon.get(obraKey(r.obra))
    if (!mine) continue
    const w = bySage.get(r.sage_id) ?? { sageId: r.sage_id, name: r.name, have: new Set() }
    w.have.add(mine)
    bySage.set(r.sage_id, w)
  }
  const workers = [...bySage.values()].map((w) => ({ sageId: w.sageId, name: w.name, obras: obras.filter((o) => w.have.has(o)) })) // a por defeito primeiro
  return json({ generatedAt, obra, obras, sig, config, workers }, 200, cors)
}

// ------------------------------------------------------------------ Supabase → relay: estado dos relógios
// Para cada dispositivo: se está ativo, a obra, o último contacto (segundos unix, ou null se nunca falou) e
// quantas picagens estão no relay à espera do Supabase. `now` é a hora do relay, para quem lê não depender do
// relógio do seu próprio computador.
async function handleDevicesStatus(request, url, env) {
  if (!(await verifySignature(request, url, '', env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  const { results } = await env.DB.prepare(
    "SELECT d.id, d.active, d.obra, d.last_seen, (d.pub_key IS NOT NULL) AS enrolled, (SELECT COUNT(*) FROM outbox o WHERE o.device_id = d.id) AS backlog, (SELECT COUNT(*) FROM device_obras x WHERE x.device_id = d.id AND x.obra = '*') AS all_obras FROM devices d ORDER BY d.id",
  ).all()
  return json({
    now: Math.floor(Date.now() / 1000),
    devices: results.map((r) => ({ id: r.id, active: r.active === 1, obra: r.obra, lastSeen: r.last_seen, enrolled: r.enrolled === 1, backlog: r.backlog, allObras: r.all_obras > 0 })),
  })
}

// ------------------------------------------------------------------ Supabase → relay: configuração dos relógios
// POST /devices-config (assinado com HMAC, só o Supabase) é o que a página Time Clocks da intranet usa em vez de comandos à mão:
//   { action: 'register', deviceId, obra, codeHash, allObras? }  cria o relógio (ou dá-lhe um código de instalação novo e reativa-o): o
//                                                                relay guarda só o hash do código (SHA-256, 64 hex), que caduca em 7 dias
//   { action: 'config', deviceId, obra, allObras? }              muda a obra por defeito e se serve todas as obras (linha `*` em device_obras)
//   { action: 'revoke', deviceId }                               desativa e apaga a chave do tablet e qualquer código pendente
//   { action: 'reactivate', deviceId }                           volta a ativar
// O código de instalação nunca passa por aqui, só o hash. Um relógio revogado só volta a falar com um código novo (`register`).
const CODE_VALID_S = 7 * 24 * 3600
async function handleDevicesConfig(request, url, env) {
  const text = await readBody(request)
  if (text === null) return json({ error: 'too_large' }, 413)
  if (!(await verifySignature(request, url, text, env.PULL_SECRET))) return json({ error: 'unauthorized' }, 401)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const id = body?.deviceId
  const action = body?.action
  const obra = typeof body?.obra === 'string' ? body.obra.trim() : ''
  const allObras = typeof body?.allObras === 'boolean' ? body.allObras : null // null: não mexe
  const mode = ['both', 'in', 'out'].includes(body?.mode) ? body.mode : null // função do tablet; null: não mexe
  const mealPunches = typeof body?.mealPunches === 'boolean' ? (body.mealPunches ? 1 : 0) : null // almoço/jantar; null: não mexe
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,40}$/.test(id) || !['register', 'config', 'revoke', 'reactivate'].includes(action)) return json({ error: 'invalid_payload' }, 400)
  if ((action === 'register' || action === 'config') && (!obra || obra.length > 64 || obra === ALL_OBRAS)) return json({ error: 'invalid_obra' }, 400)
  if (action === 'register' && !/^[0-9a-f]{64}$/.test(String(body.codeHash ?? ''))) return json({ error: 'invalid_code_hash' }, 400)

  const setAll = () =>
    allObras === null
      ? []
      : [allObras ? env.DB.prepare('INSERT OR IGNORE INTO device_obras (device_id, obra) VALUES (?, ?)').bind(id, ALL_OBRAS) : env.DB.prepare('DELETE FROM device_obras WHERE device_id = ? AND obra = ?').bind(id, ALL_OBRAS)]
  // função e almoço/jantar só se tocam quando vêm no pedido (a coluna nunca se escreve por engano com null)
  const setSettings = () => [
    ...(mode === null ? [] : [env.DB.prepare('UPDATE devices SET mode = ? WHERE id = ?').bind(mode, id)]),
    ...(mealPunches === null ? [] : [env.DB.prepare('UPDATE devices SET meal_punches = ? WHERE id = ?').bind(mealPunches, id)]),
  ]
  try {
    if (action === 'register') {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO devices (id, token_hash, obra, code_expires) VALUES (?, ?, ?, unixepoch() + ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, active = 1, obra = excluded.obra, code_expires = excluded.code_expires',
        ).bind(id, body.codeHash, obra, CODE_VALID_S),
        ...setAll(),
        ...setSettings(),
      ])
      return json({ ok: true })
    }
    const known = await env.DB.prepare('SELECT id FROM devices WHERE id = ?').bind(id).first()
    if (!known) return json({ error: 'unknown_device' }, 404)
    if (action === 'config') await env.DB.batch([env.DB.prepare('UPDATE devices SET obra = ? WHERE id = ?').bind(obra, id), ...setAll(), ...setSettings()])
    else if (action === 'revoke') await env.DB.prepare("UPDATE devices SET active = 0, pub_key = NULL, token_hash = '' WHERE id = ?").bind(id).run()
    else await env.DB.prepare('UPDATE devices SET active = 1 WHERE id = ?').bind(id).run()
    return json({ ok: true })
  } catch (e) {
    console.error('devices-config:', e)
    return json({ error: 'config_failed' }, 500)
  }
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
    if (request.method === 'POST' && url.pathname === '/devices-config') return handleDevicesConfig(request, url, env)
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true })
    return json({ error: 'not_found' }, 404)
  },
}
