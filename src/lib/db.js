import { openDB } from 'idb'

// IndexedDB local: trabalhadores (embeddings encriptados), fila de picagens e meta.
let dbPromise
function db() {
  dbPromise ??= openDB('timp-ponto', 1, {
    upgrade(d) {
      d.createObjectStore('workers', { keyPath: 'id' })
      d.createObjectStore('queue', { keyPath: 'eventId' })
      d.createObjectStore('meta')
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
export async function saveWorker({ id, name, embeddings, role = 'user' }) {
  const d = await db()
  const enc = await Promise.all(embeddings.map(encrypt))
  await d.put('workers', { id, name, role, embeddings: enc, createdAt: Date.now() })
}

export async function listWorkers() {
  const d = await db()
  const rows = await d.getAll('workers')
  // Registos anteriores à existência de perfis: o mais antigo passa a Administrador.
  const oldest = rows.length && !rows.some((w) => w.role === 'admin') ? [...rows].sort((x, y) => x.createdAt - y.createdAt)[0].id : null
  // Registos que não decifram (ex.: criados com a chave errada) ficam sem vetores
  // e marcados como `broken`, para poderem ser apagados e registados de novo.
  return Promise.all(
    rows.map(async (w) => {
      const base = { id: w.id, name: w.name, createdAt: w.createdAt, role: w.role === 'admin' || w.id === oldest ? 'admin' : 'user' }
      try {
        return { ...base, embeddings: await Promise.all(w.embeddings.map(decrypt)) }
      } catch {
        return { ...base, embeddings: [], broken: true }
      }
    }),
  )
}

// Só existe administração protegida se houver um Administrador utilizável (com vetores legíveis).
export const hasUsableAdmin = (workers) => workers.some((w) => w.role === 'admin' && !w.broken)

// Tem de ficar sempre pelo menos um Administrador ativo (utilizável): nem se apaga nem se despromove o último.
async function assertNotLastAdmin(id) {
  const workers = await listWorkers()
  const target = workers.find((w) => w.id === id)
  if (target?.role === 'admin' && !target.broken && workers.filter((w) => w.role === 'admin' && !w.broken).length === 1) {
    throw Object.assign(new Error('Tem de ficar pelo menos um Administrador ativo.'), { code: 'LAST_ADMIN' })
  }
}

export async function setWorkerRole(id, role) {
  const d = await db()
  const w = await d.get('workers', id)
  if (!w) return
  if (role !== 'admin') await assertNotLastAdmin(id)
  // grava também o perfil dos registos antigos (sem campo `role`), para a regra do "mais antigo" não voltar a atuar
  await d.put('workers', { ...w, role })
}

export async function deleteWorker(id) {
  await assertNotLastAdmin(id)
  const d = await db()
  await d.delete('workers', id)
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
// eventId = dispositivo + contador => reenvios idempotentes no servidor.
export async function enqueuePunch({ deviceId, direction, sageId, workerName, confidence }) {
  const d = await db()
  const counter = await nextCounter()
  const offset = await getClockOffset()
  const punch = {
    eventId: `${deviceId}-${String(counter).padStart(6, '0')}`,
    deviceId,
    direction,
    sageId,
    workerName, // só local: nunca vai para a cloud
    confidence: Math.round(confidence * 1000) / 1000,
    punchedAt: new Date(Date.now() + offset).toISOString(),
    synced: 0, // 0 = pendente, 1 = enviada (índice simples sem criar index)
    attempts: 0,
  }
  await d.put('queue', punch)
  return punch
}

export async function listQueue() {
  const d = await db()
  const all = await d.getAll('queue')
  return all.sort((a, b) => b.punchedAt.localeCompare(a.punchedAt))
}

export async function pendingPunches() {
  return (await listQueue()).filter((p) => !p.synced).reverse()
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
    if (row.synced && row.punchedAt < limit) await tx.store.delete(row.eventId)
  }
  await tx.done
}
