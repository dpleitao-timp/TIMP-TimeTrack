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
export async function saveWorker({ id, name, embeddings }) {
  const d = await db()
  const enc = await Promise.all(embeddings.map(encrypt))
  await d.put('workers', { id, name, embeddings: enc, createdAt: Date.now() })
}

export async function listWorkers() {
  const d = await db()
  const rows = await d.getAll('workers')
  // Registos que não decifram (ex.: criados com a chave errada) ficam sem vetores
  // e marcados como `broken`, para poderem ser apagados e registados de novo.
  return Promise.all(
    rows.map(async (w) => {
      try {
        return { id: w.id, name: w.name, createdAt: w.createdAt, embeddings: await Promise.all(w.embeddings.map(decrypt)) }
      } catch {
        return { id: w.id, name: w.name, createdAt: w.createdAt, embeddings: [], broken: true }
      }
    }),
  )
}

export async function deleteWorker(id) {
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
export async function enqueuePunch({ deviceId, direction, workerId, workerName, confidence }) {
  const d = await db()
  const counter = await nextCounter()
  const offset = await getClockOffset()
  const punch = {
    eventId: `${deviceId}-${String(counter).padStart(6, '0')}`,
    deviceId,
    direction,
    workerId,
    workerName,
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
