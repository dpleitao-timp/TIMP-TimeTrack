import { openDB } from 'idb'
import { engineTag } from './settings.js'

// IndexedDB local: trabalhadores (embeddings encriptados), fila de picagens e meta.
let dbPromise
function db() {
  dbPromise ??= openDB('timp-ponto', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('workers', { keyPath: 'id' })
        d.createObjectStore('queue', { keyPath: 'eventId' })
        d.createObjectStore('meta')
      }
      if (oldVersion < 2) d.createObjectStore('roster', { keyPath: 'sageId' }) // lista de trabalhadores da obra (vem do relay)
    },
  })
  return dbPromise
}

// --- Encriptação dos vetores (AES-GCM, chave não exportável guardada em IndexedDB) ---
// A promessa é partilhada: chamadas concorrentes não geram chaves diferentes.
let keyPromise
function getKey() {
  keyPromise ??= (async () => {
    const d = await db()
    let key = await d.get('meta', 'aesKey')
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await d.put('meta', key, 'aesKey')
    }
    return key
  })().catch((e) => {
    keyPromise = undefined
    throw e
  })
  return keyPromise
}

async function encrypt(floats) {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Float32Array(floats).buffer)
  return { iv, data }
}

async function decrypt({ iv, data }) {
  const key = await getKey()
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  return Array.from(new Float32Array(buf))
}

// --- Trabalhadores ---
// role: 'admin' | 'user'. O primeiro trabalhador registado é sempre Administrador.
// rev: instante da última gravação da biometria. bioSent: a biometria já foi enviada ao relay (ou veio de lá); só se envia o que
// ainda não foi. Os registos que chegam do relay entram com bioSent verdadeiro e sempre como 'user'.
export async function saveWorker({ id, name, embeddings, role = 'user', createdAt, engine, bioSent = false }) {
  const d = await db()
  const enc = await Promise.all(embeddings.map(encrypt))
  await d.put('workers', { id, name, role, embeddings: enc, createdAt: createdAt ?? Date.now(), engine: engine ?? engineTag(), rev: Date.now(), bioSent })
}

// Lê um registo da base: decifra os vetores. Os que não decifram (ex.: criados com a chave errada) ficam sem vetores e
// marcados como `broken`, para poderem ser apagados e registados de novo.
async function readRow(w, current, oldest) {
  const engine = w.engine ?? 'faceres' // registos anteriores ao motor alternativo
  // `stale`: biometria feita com outro motor; não serve para reconhecer até ser atualizada
  const base = {
    id: w.id,
    name: w.name,
    createdAt: w.createdAt,
    rev: w.rev,
    bioSent: w.bioSent === true,
    engine,
    stale: engine !== current,
    role: w.role === 'admin' || w.id === oldest ? 'admin' : 'user',
  }
  try {
    return { ...base, embeddings: await Promise.all(w.embeddings.map(decrypt)) }
  } catch {
    return { ...base, embeddings: [], broken: true }
  }
}

export async function listWorkers() {
  const d = await db()
  const rows = await d.getAll('workers')
  // Registos anteriores à existência de perfis (sem campo `role`): se não há Administrador, o mais antigo deles passa a
  // Administrador. Só conta quem não tem `role` gravado: os que chegam do relay entram como 'user' de propósito.
  const oldest = rows.length && !rows.some((w) => w.role === 'admin') ? ([...rows].filter((w) => w.role == null).sort((x, y) => x.createdAt - y.createdAt)[0]?.id ?? null) : null
  const current = engineTag()
  return Promise.all(rows.map((w) => readRow(w, current, oldest)))
}

// Identificação dos registos sem decifrar nada (barato): id, motor, perfil.
export async function listWorkerHeads() {
  const d = await db()
  return (await d.getAll('workers')).map((w) => ({ id: w.id, engine: w.engine ?? 'faceres', role: w.role === 'admin' ? 'admin' : 'user', createdAt: w.createdAt, rev: w.rev }))
}

// Registos utilizáveis (motor atual, legíveis) cuja biometria ainda não foi enviada ao relay.
export async function listUnsentWorkers() {
  const d = await db()
  const current = engineTag()
  const rows = (await d.getAll('workers')).filter((w) => w.bioSent !== true && (w.engine ?? 'faceres') === current)
  const out = await Promise.all(rows.map((w) => readRow(w, current, null)))
  return out.filter((w) => !w.broken && w.embeddings.length)
}

// Marca como enviado, mas só se o registo não mudou entretanto (`rev`): uma biometria atualizada durante o envio tem de seguir de novo.
export async function markBioSent(id, rev) {
  const d = await db()
  const tx = d.transaction('workers', 'readwrite')
  const w = await tx.store.get(id)
  if (w && w.rev === rev) await tx.store.put({ ...w, bioSent: true })
  await tx.done
}

// Só existe administração protegida se houver um Administrador utilizável (vetores legíveis e do motor atual).
export const isUsable = (w) => !w.broken && !w.stale
export const hasUsableAdmin = (workers) => workers.some((w) => w.role === 'admin' && isUsable(w))

// Tem de ficar sempre pelo menos um Administrador ativo (utilizável): nem se apaga nem se despromove o último.
// Exceção ao apagar: se o Administrador for a única pessoa registada, pode apagar-se e o tablet volta
// ao estado inicial (o próximo registo fica Administrador).
async function assertNotLastAdmin(id, { allowIfOnlyWorker = false } = {}) {
  const workers = await listWorkers()
  const target = workers.find((w) => w.id === id)
  if (allowIfOnlyWorker && workers.length === 1) return
  if (target?.role === 'admin' && isUsable(target) && workers.filter((w) => w.role === 'admin' && isUsable(w)).length === 1) {
    throw Object.assign(new Error('Tem de ficar pelo menos um Administrador ativo.'), { code: 'LAST_ADMIN' })
  }
}

// --- Lista de trabalhadores da obra (publicada pelo Supabase, lida do relay): só SAGE ID e nome ---
export async function replaceRoster(workers, generatedAt, obra = '') {
  const d = await db()
  const tx = d.transaction(['roster', 'meta'], 'readwrite')
  await tx.objectStore('roster').clear()
  for (const w of workers) await tx.objectStore('roster').put({ sageId: String(w.sageId), name: w.name })
  await tx.objectStore('meta').put(generatedAt ?? 0, 'rosterGen')
  await tx.objectStore('meta').put(obra, 'rosterObra') // a obra a que esta lista pertence
  await tx.objectStore('meta').put(Date.now(), 'rosterAt')
  await tx.done
}

export async function touchRoster() {
  const d = await db()
  await d.put('meta', Date.now(), 'rosterAt')
}

export async function listRoster() {
  const d = await db()
  return (await d.getAll('roster')).sort((a, b) => a.name.localeCompare(b.name))
}

export async function rosterMeta() {
  const d = await db()
  return { gen: (await d.get('meta', 'rosterGen')) || 0, at: (await d.get('meta', 'rosterAt')) || 0, obra: (await d.get('meta', 'rosterObra')) || '' }
}

export async function setWorkerRole(id, role) {
  const d = await db()
  const w = await d.get('workers', id)
  if (!w) return
  if (role !== 'admin') await assertNotLastAdmin(id)
  // grava também o perfil dos registos antigos (sem campo `role`), para a regra do "mais antigo" não voltar a atuar
  await d.put('workers', { ...w, role })
}

// propagate: o apagar tem de chegar a todos os tablets e ao Supabase (fila `bioDelQueue`, enviada por bio.js). Fica a falso
// quando o apagar veio de outro tablet (senão voltava a ser enviado).
export async function deleteWorker(id, { propagate = true } = {}) {
  await assertNotLastAdmin(id, { allowIfOnlyWorker: true })
  const d = await db()
  await d.delete('workers', id)
  if (propagate) await queueBioDeletion(id)
}

// --- Apagar biometria em todos os tablets: fila de pedidos por enviar, lápides já vistas e versão da lista do relay ---
export async function queueBioDeletion(id, at = Date.now()) {
  const d = await db()
  const q = (await d.get('meta', 'bioDelQueue')) || []
  await d.put('meta', [...q.filter((x) => x.sageId !== id), { sageId: id, at }], 'bioDelQueue')
}

export async function getBioDeletionQueue() {
  return (await (await db()).get('meta', 'bioDelQueue')) || []
}

// Tira da fila os pedidos já enviados (só se não houve um pedido mais recente do mesmo trabalhador entretanto).
export async function clearBioDeletions(done) {
  const d = await db()
  const q = (await d.get('meta', 'bioDelQueue')) || []
  await d.put('meta', q.filter((x) => !done.some((y) => y.sageId === x.sageId && y.at === x.at)), 'bioDelQueue')
}

// Lápides já vistas ({ sageId: momento do apagar }) e a versão da lista que o relay deu: impedem que se volte a importar biometria
// apagada e permitem não pedir a lista inteira de cada vez.
export async function getBioTombs() {
  const d = await db()
  return { map: (await d.get('meta', 'bioTombs')) || {}, version: (await d.get('meta', 'bioTombVersion')) || '' }
}

export async function saveBioTombs(map, version) {
  const d = await db()
  await d.put('meta', map, 'bioTombs')
  await d.put('meta', version, 'bioTombVersion')
}

// --- Contador e deslocamento de relógio ---
async function nextCounter() {
  const d = await db()
  const tx = d.transaction('meta', 'readwrite')
  const n = ((await tx.store.get('counter')) || 0) + 1
  await tx.store.put(n, 'counter')
  await tx.done
  return n
}

export async function getClockOffset() {
  const d = await db()
  return (await d.get('meta', 'clockOffset')) || 0
}

export async function setClockOffset(ms) {
  const d = await db()
  await d.put('meta', ms, 'clockOffset')
}

// --- Fila de picagens ---
const round3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
// eventId = dispositivo + contador => reenvios idempotentes no servidor.
export async function enqueuePunch({ deviceId, direction, sageId, workerName, obra, confidence, second = null, real = null, live = null }) {
  const d = await db()
  const counter = await nextCounter()
  const offset = await getClockOffset()
  const punch = {
    eventId: `${deviceId}-${String(counter).padStart(6, '0')}`,
    deviceId,
    direction,
    sageId,
    obra, // fica na picagem: mudar a obra nas Definições não altera as já registadas
    workerName, // só local: nunca vai para a cloud
    confidence: Math.round(confidence * 1000) / 1000,
    // dados para afinar o reconhecimento (2º mais parecido e anti-foto); não afetam a picagem
    second: round3(second),
    real: round3(real),
    live: round3(live),
    punchedAt: new Date(Date.now() + offset).toISOString(),
    synced: 0, // 0 = pendente, 1 = enviada (índice simples sem criar index)
    attempts: 0,
  }
  await d.put('queue', punch)
  return punch
}

// Picagens que estão a ser enviadas neste momento: já podem ter chegado ao relay, por isso não se apagam.
const sending = new Set()
export const markSending = (ids) => ids.forEach((id) => sending.add(id))
export const clearSending = (ids) => ids.forEach((id) => sending.delete(id))

// Apaga uma picagem. Se ainda não foi enviada, desaparece sem mais. Se já foi enviada, fica marcada como apagada
// (`voided`) e deixa de aparecer; o pedido para o Supabase a apagar segue pelo relay (ver `flushQueue`) e só então
// o registo local é removido. A que está a ser enviada neste momento não se apaga (podia chegar ao relay a meio).
export async function deletePunch(eventId) {
  const d = await db()
  const tx = d.transaction('queue', 'readwrite')
  const row = await tx.store.get(eventId)
  if (!row) {
    await tx.done
    return null
  }
  if (sending.has(eventId)) {
    await tx.done
    throw Object.assign(new Error('A picagem está a ser enviada.'), { code: 'SENDING' })
  }
  if (row.synced) await tx.store.put({ ...row, voided: true })
  else await tx.store.delete(eventId)
  await tx.done
  return row
}

// Picagens já enviadas que foram apagadas aqui e cujo pedido de apagar ainda não chegou ao relay.
export async function pendingVoids() {
  const d = await db()
  return (await d.getAll('queue')).filter((p) => p.voided)
}

// O relay aceitou o pedido de apagar: já não é preciso guardar a picagem no tablet.
export async function clearVoids(eventIds) {
  const d = await db()
  const tx = d.transaction('queue', 'readwrite')
  for (const id of eventIds) {
    const row = await tx.store.get(id)
    if (row?.voided) await tx.store.delete(id)
  }
  await tx.done
}

// Milissegundos desde a última picagem deste trabalhador neste tablet (Infinity se não houver).
// Lê a fila guardada na IndexedDB, por isso sobrevive a recargas, atualizações e reinícios (o intervalo mínimo
// entre picagens não pode depender de memória). Picagens recusadas pelo relay não contam; as apagadas também não.
export async function msSinceLastPunch(sageId) {
  const queue = await listQueue() // já vem da mais recente para a mais antiga
  const last = queue.find((p) => (p.sageId ?? p.workerId) === sageId && !p.rejected)
  if (!last) return Infinity
  const now = Date.now() + (await getClockOffset()) // mesma hora usada ao gravar a picagem
  return Math.max(0, now - new Date(last.punchedAt).getTime())
}

// O "dia" de trabalho acaba às 05:00 da manhã (para acomodar o turno da noite): uma picagem às 02:00 conta para o dia anterior e o dia novo
// começa às 05:00. Por agora é fixo.
export const DAY_STARTS_AT_HOUR = 5

// Tipos de picagem que este trabalhador já tem NO DIA DE TRABALHO ATUAL neste tablet (o dia vai das 05:00 às 05:00 do dia seguinte,
// no fuso do tablet, com a hora corrigida pelo servidor, como a que se grava na picagem). Contam as que estão na fila (as apagadas e as
// recusadas pelo relay não). Só vê o que se picou neste tablet.
export async function directionsToday(sageId) {
  const offset = await getClockOffset()
  const key = (t) => {
    const x = new Date(new Date(t).getTime() - DAY_STARTS_AT_HOUR * 36e5) // recua 5 h: assim 00:00 a 04:59 pertencem ao dia anterior
    return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  }
  const today = key(Date.now() + offset)
  const mine = (await listQueue()).filter((p) => (p.sageId ?? p.workerId) === sageId && !p.rejected && key(p.punchedAt) === today)
  return new Set(mine.map((p) => p.direction))
}

export async function listQueue() {
  const d = await db()
  const all = (await d.getAll('queue')).filter((p) => !p.voided) // as apagadas já não contam (nem para o intervalo mínimo)
  return all.sort((a, b) => b.punchedAt.localeCompare(a.punchedAt))
}

// Por enviar: nem enviadas nem recusadas (uma recusada não volta a ser enviada)
export async function pendingPunches() {
  return (await listQueue()).filter((p) => !p.synced && !p.rejected).reverse()
}

// O relay recusou estas picagens (dados inválidos): ficam marcadas e visíveis, nunca como enviadas.
export async function markRejected(eventIds) {
  const d = await db()
  const tx = d.transaction('queue', 'readwrite')
  for (const id of eventIds) {
    const row = await tx.store.get(id)
    if (row && !row.synced) await tx.store.put({ ...row, rejected: true })
  }
  await tx.done
}

export async function markSynced(eventIds) {
  const d = await db()
  const tx = d.transaction('queue', 'readwrite')
  for (const id of eventIds) {
    const row = await tx.store.get(id)
    if (row) await tx.store.put({ ...row, synced: 1 })
  }
  await tx.done
}

export async function bumpAttempts(eventIds) {
  const d = await db()
  const tx = d.transaction('queue', 'readwrite')
  for (const id of eventIds) {
    const row = await tx.store.get(id)
    if (row) await tx.store.put({ ...row, attempts: row.attempts + 1 })
  }
  await tx.done
}

// Remove picagens já sincronizadas com mais de N dias.
export async function pruneSynced(days = 7) {
  const d = await db()
  const limit = new Date(Date.now() - days * 864e5).toISOString()
  const tx = d.transaction('queue', 'readwrite')
  for (const row of await tx.store.getAll()) {
    if (row.synced && !row.voided && row.punchedAt < limit) await tx.store.delete(row.eventId) // as apagadas ficam até o pedido chegar ao relay
  }
  await tx.done
}
