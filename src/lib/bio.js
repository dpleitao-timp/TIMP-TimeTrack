// Biometria entre tablets, pelo mesmo caminho das picagens: tablet → relay (Cloudflare) → Supabase, e Supabase → relay → tablets.
// O tablet nunca fala com o Supabase. O que viaja é sempre CIFRADO aqui, com a "chave da frota" (a mesma frase-passe escrita nas
// Definições de cada tablet): o relay e o Supabase só guardam blobs ilegíveis e nunca veem um vetor. Quem não tem a chave não
// consegue ler nem forjar um registo (o AES-GCM autentica), e cada blob fica preso ao seu SAGE ID e motor (dados adicionais
// autenticados), por isso o relay não o pode trocar de trabalhador.
//
// Regras acordadas com o utilizador:
//  - o perfil de Administrador NÃO viaja: a biometria recebida entra sempre como utilizador normal;
//  - só se recebe o que falta: um registo local utilizável (motor atual) nunca é substituído pelo do relay;
//  - apagar um trabalhador num tablet apaga-o em todos os tablets e no Supabase (lápides cifradas, ver mais abaixo);
//  - os vetores de um motor/modelo não servem noutro: só se recebe o do motor atual.
import { listUnsentWorkers, markBioSent, listWorkerHeads, listWorkers, listRoster, saveWorker, deleteWorker, getBioDeletionQueue, clearBioDeletions, getBioTombs, saveBioTombs } from './db.js'
import { engineTag, isBioConfigured } from './settings.js'

const enc = new TextEncoder()
const SALT = enc.encode('timp-timetrack-bio-v1') // público: a segurança está na frase-passe
const ITERATIONS = 250_000
const MAX_VECTORS = 60
const BATCH_ITEMS = 20 // registos por pedido ao relay
const BATCH_CHARS = 180_000 // o relay aceita corpos até 256 KB
const FETCH_IDS = 50
const FETCH_EVERY_MS = 30 * 60 * 1000 // sem novidades na lista, não volta a perguntar ao relay antes disto

// ---- bytes <-> base64 e vetores <-> base64
const toB64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const vecToB64 = (floats) => toB64(new Uint8Array(new Float32Array(floats).buffer))
const b64ToVec = (b64) => {
  const bytes = fromB64(b64)
  if (bytes.length % 4) throw new Error('vetor inválido')
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4))
}

// ---- chave da frota (PBKDF2 → AES-GCM de 256 bits; a derivação demora, por isso guarda-se)
let keyCache = { pass: '', key: null }
async function fleetKey(pass) {
  if (keyCache.key && keyCache.pass === pass) return keyCache.key
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  keyCache = { pass, key }
  return key
}
const aad = (sageId, engine) => enc.encode(`${sageId}|${engine}`)

// Cifra um registo. vectors: lista de vetores (arrays de números). Devolve o blob (texto JSON) que segue para o relay.
export async function sealBio({ sageId, name, engine, vectors, updatedAt }, pass) {
  const key = await fleetKey(pass)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = enc.encode(JSON.stringify({ v: 1, sageId, engine, name, updatedAt, vectors: vectors.map(vecToB64) }))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sageId, engine) }, key, plain)
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(new Uint8Array(data)) })
}

// Abre um blob. Devolve { name, updatedAt, vectors } ou null (chave errada, blob adulterado ou de outro trabalhador/motor, ou
// vetores com formato impossível).
export async function openBio(blob, sageId, engine, pass) {
  try {
    const key = await fleetKey(pass)
    const env = JSON.parse(blob)
    if (env?.v !== 1) return null
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(sageId, engine) }, key, fromB64(env.data))
    const p = JSON.parse(new TextDecoder().decode(plain))
    if (p?.v !== 1 || p.sageId !== sageId || p.engine !== engine || !Array.isArray(p.vectors) || !p.vectors.length || p.vectors.length > MAX_VECTORS) return null
    const vectors = p.vectors.map(b64ToVec)
    const dim = vectors[0].length
    if (dim < 32 || dim > 4096 || vectors.some((v) => v.length !== dim || !v.every(Number.isFinite))) return null
    return { name: typeof p.name === 'string' ? p.name : '', updatedAt: Number(p.updatedAt) || 0, vectors }
  } catch {
    return null
  }
}

// ---- lápides (apagar biometria em todos os tablets)
// Quando um tablet apaga um trabalhador, envia uma lápide cifrada com a chave da frota ({ sageId, deletedAt }). O relay e o Supabase
// guardam-na e apagam a biometria que têm; os outros tablets só obedecem às lápides que abrem (quem não tem a chave não consegue
// forjar apagamentos). Uma lápide só apaga o que foi registado ANTES dela: quem refaz a biometria depois não é afetado.
export async function sealDeletion({ sageId, deletedAt }, pass) {
  const key = await fleetKey(pass)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = enc.encode(JSON.stringify({ v: 1, kind: 'del', sageId, deletedAt }))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sageId, 'del') }, key, plain)
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(new Uint8Array(data)) })
}

// Devolve { deletedAt } ou null (chave errada, adulterada, ou de outro trabalhador).
export async function openDeletion(blob, sageId, pass) {
  try {
    const key = await fleetKey(pass)
    const env = JSON.parse(blob)
    if (env?.v !== 1) return null
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(sageId, 'del') }, key, fromB64(env.data))
    const p = JSON.parse(new TextDecoder().decode(plain))
    if (p?.v !== 1 || p.kind !== 'del' || p.sageId !== sageId || !Number.isFinite(p.deletedAt)) return null
    return { deletedAt: p.deletedAt }
  } catch {
    return null
  }
}

// ---- tablet → relay
const relay = (settings) => settings.relayUrl.replace(/\/$/, '')
const post = (settings, path, body) =>
  fetch(`${relay(settings)}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': settings.deviceToken }, body: JSON.stringify(body) })

let sending = false
// Envia ao relay a biometria que ainda não foi enviada (a registada ou atualizada neste tablet). Seguro chamar repetidamente.
// Devolve { sent, skipped, error? }; skipped = o relay recusou (blob demasiado grande ou inválido) e não se repete.
export async function flushBiometrics(settings) {
  if (sending || !isBioConfigured(settings) || !navigator.onLine) return { sent: 0, skipped: 0 }
  sending = true
  let sent = 0
  let skipped = 0
  try {
    const unsent = await listUnsentWorkers()
    let batch = []
    let chars = 0
    const send = async () => {
      if (!batch.length) return
      const res = await post(settings, '/biometrics', { deviceId: settings.deviceId, items: batch.map((b) => b.item) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const out = await res.json()
      const accepted = new Set(out.accepted ?? [])
      const rejected = new Set(out.rejected ?? [])
      for (const b of batch) {
        const key = `${b.item.sageId}|${b.item.engine}`
        if (!accepted.has(key) && !rejected.has(key)) continue // o relay não disse nada sobre ele: fica para a próxima
        await markBioSent(b.item.sageId, b.rev)
        if (rejected.has(key)) skipped++
        else sent++
      }
      batch = []
      chars = 0
    }
    for (const w of unsent) {
      const blob = await sealBio({ sageId: w.id, name: w.name, engine: w.engine, vectors: w.embeddings, updatedAt: w.rev ?? w.createdAt ?? Date.now() }, settings.bioKey)
      if (batch.length && (batch.length >= BATCH_ITEMS || chars + blob.length > BATCH_CHARS)) await send()
      batch.push({ rev: w.rev, item: { sageId: w.id, engine: w.engine, blob, updatedAt: w.rev ?? w.createdAt ?? Date.now() } })
      chars += blob.length
    }
    await send()
    return { sent, skipped }
  } catch (e) {
    return { sent, skipped, error: String(e?.message || e) }
  } finally {
    sending = false
  }
}

let sendingDel = false
// Envia ao relay os apagamentos por enviar. Fica na fila até o relay os aceitar (por isso funciona sem rede e depois da chave).
// Devolve { sentDeletions, error? }.
export async function flushBioDeletions(settings) {
  if (sendingDel || !isBioConfigured(settings) || !navigator.onLine) return { sentDeletions: 0 }
  sendingDel = true
  let sentDeletions = 0
  try {
    const queue = await getBioDeletionQueue()
    for (let i = 0; i < queue.length; i += 50) {
      const part = queue.slice(i, i + 50)
      const items = await Promise.all(part.map(async (q) => ({ sageId: q.sageId, deletedAt: q.at, blob: await sealDeletion({ sageId: q.sageId, deletedAt: q.at }, settings.bioKey) })))
      const res = await post(settings, '/bio-delete', { deviceId: settings.deviceId, items })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const out = await res.json()
      const done = new Set([...(out.accepted ?? []), ...(out.rejected ?? [])]) // os recusados são inválidos: não se repetem
      await clearBioDeletions(part.filter((q) => done.has(q.sageId)))
      sentDeletions += part.filter((q) => (out.accepted ?? []).includes(q.sageId)).length
    }
    return { sentDeletions }
  } catch (e) {
    return { sentDeletions, error: String(e?.message || e) }
  } finally {
    sendingDel = false
  }
}

// ---- relay → tablet
// Vai buscar as lápides e apaga aqui os trabalhadores apagados noutros tablets (só os registados antes do apagar; nunca apaga o
// único Administrador utilizável, para o tablet não ficar com a administração aberta). Devolve { deleted, kept, failed, error? };
// failed = lápides que não abrem (chave da frota diferente) e por isso se ignoram.
export async function applyBioTombstones(settings) {
  if (!isBioConfigured(settings) || !navigator.onLine) return { deleted: 0, kept: 0, failed: 0 }
  let deleted = 0
  let kept = 0
  let failed = 0
  try {
    const saved = await getBioTombs()
    const res = await post(settings, '/bio-deleted', { deviceId: settings.deviceId, since: saved.version })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const out = await res.json()
    if (out.unchanged) return { deleted, kept, failed }
    const map = { ...saved.map }
    const heads = new Map((await listWorkerHeads()).map((w) => [w.id, w]))
    for (const it of out.items ?? []) {
      const d = await openDeletion(it.blob, it.sageId, settings.bioKey)
      if (!d) {
        failed++
        continue
      }
      map[it.sageId] = Math.max(map[it.sageId] ?? 0, d.deletedAt)
      const local = heads.get(it.sageId)
      if (!local || (local.rev ?? local.createdAt ?? 0) > d.deletedAt) continue // não há, ou foi refeito depois do apagar
      try {
        await deleteWorker(it.sageId, { propagate: false })
        deleted++
      } catch {
        kept++ // único Administrador utilizável: fica
      }
    }
    // com lápides que não abriram não se guarda a versão: volta a pedir-se quando a chave estiver certa
    await saveBioTombs(map, failed ? saved.version : out.version)
    return { deleted, kept, failed }
  } catch (e) {
    return { deleted, kept, failed, error: String(e?.message || e) }
  }
}

let lastTry = { at: 0, key: '' }
// Vai buscar ao relay a biometria dos trabalhadores da obra do tablet que ainda não a têm (ou que só a têm de outro motor).
// Devolve { received, failed, error? }; failed = chegaram blobs que não abrem (chave da frota diferente, ou adulterados).
// Sem `force`, só pergunta ao relay se a lista de em falta mudou ou passou meia hora (o Supabase só publica de 6 em 6 horas).
export async function fetchMissingBiometrics(settings, { force = false } = {}) {
  const obra = (settings.obra || '').trim()
  if (!isBioConfigured(settings) || !navigator.onLine || !obra) return { received: 0, failed: 0 }
  let received = 0
  let failed = 0
  try {
    const tag = engineTag()
    const heads = new Map((await listWorkerHeads()).map((w) => [w.id, w]))
    const need = (await listRoster()).map((r) => r.sageId).filter((id) => !heads.has(id) || heads.get(id).engine !== tag)
    if (!need.length) return { received: 0, failed: 0 }
    const key = need.join(',')
    if (!force && lastTry.key === key && Date.now() - lastTry.at < FETCH_EVERY_MS) return { received: 0, failed: 0 }
    lastTry = { at: Date.now(), key }

    const roster = new Map((await listRoster()).map((r) => [r.sageId, r.name]))
    const tombs = (await getBioTombs()).map
    for (let i = 0; i < need.length; i += FETCH_IDS) {
      const ids = need.slice(i, i + FETCH_IDS)
      const res = await post(settings, '/bio-fetch', { deviceId: settings.deviceId, engine: tag, obra, ids })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { items = [] } = await res.json()
      // o estado local pode ter mudado entre o pedido e a resposta: relê-se (nunca se substitui um registo utilizável)
      const now = new Map((await listWorkers()).map((w) => [w.id, w]))
      for (const it of items) {
        if (!ids.includes(it.sageId) || it.engine !== tag) continue
        const local = now.get(it.sageId)
        if (local && !local.stale && !local.broken) continue
        if ((tombs[it.sageId] ?? 0) >= it.updatedAt) continue // foi apagado noutro tablet depois de esta biometria ser registada
        const bio = await openBio(it.blob, it.sageId, it.engine, settings.bioKey)
        if (!bio) {
          failed++
          continue
        }
        await saveWorker({
          id: it.sageId,
          name: roster.get(it.sageId) || bio.name || it.sageId,
          embeddings: bio.vectors,
          role: local?.role ?? 'user', // o perfil nunca viaja: mantém-se o que o tablet já tinha (ou utilizador normal)
          createdAt: local?.createdAt,
          engine: tag,
          bioSent: true, // veio do relay: não se volta a enviar
        })
        received++
      }
    }
    return { received, failed }
  } catch (e) {
    return { received, failed, error: String(e?.message || e) }
  }
}

// Envia e recebe, já (apagamentos primeiro, para não se voltar a receber o que acabou de ser apagado). Botão das Definições.
export async function syncBiometrics(settings) {
  const delUp = await flushBioDeletions(settings)
  const delDown = await applyBioTombstones(settings)
  const up = await flushBiometrics(settings)
  const down = await fetchMissingBiometrics(settings, { force: true })
  return { ...up, ...down, deleted: delDown.deleted, kept: delDown.kept, sentDeletions: delUp.sentDeletions, error: delUp.error || delDown.error || up.error || down.error }
}
