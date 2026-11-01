// Pedidos do tablet ao relay, assinados com a chave do próprio dispositivo (ver relay/src/index.js, authDevice).
// A chave (ECDSA P-256) gera-se no tablet com `extractable: false`: o navegador não deixa tirá-la de lá, por isso copiar o que está no
// tablet (Definições, localStorage, IndexedDB) não dá nenhum segredo que se use noutro computador. O relay só tem a parte pública.
// Ligar o tablet ao relay (enrol): o código de instalação (uso único, dado por add-device.mjs) vai uma só vez com a chave pública e
// depois deixa de servir. Os tablets que já tinham um token das versões anteriores ligam-se sozinhos com ele, uma só vez.
import { loadSettings, saveSettings } from './settings.js'
import { getClockOffset, setClockOffset, getDeviceKeys, saveDeviceKeys } from './db.js'

const enc = new TextEncoder()
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: 'SHA-256' }

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256Hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const base = (settings) => settings.relayUrl.replace(/\/$/, '')

// A chave do dispositivo: cria-se uma só vez e fica guardada. A chave pública exporta-se sempre; a privada nunca.
async function deviceKeys() {
  let keys = await getDeviceKeys()
  if (!keys) {
    keys = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])
    await saveDeviceKeys(keys)
  }
  return keys
}

async function signedHeaders(settings, method, pathAndQuery, bodyText) {
  const { privateKey } = await deviceKeys()
  const ts = Math.floor((Date.now() + (await getClockOffset())) / 1000) // a hora corrigida pelo relay (ver bad_timestamp)
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)))
  const msg = `${method}\n${pathAndQuery}\n${ts}\n${nonce}\n${settings.deviceId}\n${await sha256Hex(bodyText)}`
  const signature = await crypto.subtle.sign(SIGN, privateKey, enc.encode(msg))
  return { 'x-device-id': settings.deviceId, 'x-timestamp': String(ts), 'x-nonce': nonce, 'x-signature': b64u(signature) }
}

// Pedido assinado ao relay. `path` inclui a query (GET /roster?...). `body`: objeto, vai em JSON. Devolve a Response.
// Se a hora do tablet estiver muito desacertada, o relay responde bad_timestamp com a hora dele: acerta-se e repete-se uma vez.
export async function relayRequest(settings, method, path, body) {
  await ensureEnrolled()
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  let res
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await signedHeaders(settings, method, path, bodyText)
    if (bodyText) headers['Content-Type'] = 'application/json'
    res = await fetch(`${base(settings)}${path}`, { method, headers, body: bodyText || undefined })
    if (res.status !== 401 || attempt) break
    const j = await res.clone().json().catch(() => null)
    if (j?.error !== 'bad_timestamp' || !j.serverTime) break
    await setClockOffset(Date.parse(j.serverTime) - Date.now())
  }
  return res
}

// Liga este tablet ao relay com um código de instalação (ou, nas versões antigas, o token). Gera a chave se ainda não existe.
// Lança Error com `code` (o erro do relay) se falhar. Não grava nas definições: quem chama é que decide (ver enrollDevice).
export async function enrollWithCode(settings, code) {
  const { privateKey, publicKey } = await deviceKeys()
  const pub = b64u(await crypto.subtle.exportKey('spki', publicKey))
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = Math.floor((Date.now() + (await getClockOffset())) / 1000)
    const proof = b64u(await crypto.subtle.sign(SIGN, privateKey, enc.encode(`enroll\n${settings.deviceId}\n${ts}\n${pub}`)))
    const res = await fetch(`${base(settings)}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-enroll-code': code.trim() },
      body: JSON.stringify({ deviceId: settings.deviceId, publicKey: pub, ts, proof }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok) return
    if (res.status === 401 && j.error === 'bad_timestamp' && j.serverTime && !attempt) {
      await setClockOffset(Date.parse(j.serverTime) - Date.now())
      continue
    }
    throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { code: j.error || `http_${res.status}` })
  }
}

// Depois de ligado: guarda que está ligado e apaga o código das definições (já não serve, e não fica nada guardado).
export function markEnrolled() {
  saveSettings({ ...loadSettings(), enrolled: true, deviceToken: '' })
  window.dispatchEvent(new Event('settings-changed')) // a interface relê as definições
}

// Tablets que já tinham um token (versões anteriores): ligam-se sozinhos com ele, uma só vez; o token deixa de valer no relay.
let enrolling = null
export function ensureEnrolled() {
  const cur = loadSettings() // o que está guardado (quem chama pode ter uma cópia antiga das definições)
  if (cur.enrolled === true || !cur.deviceToken || !cur.relayUrl) return Promise.resolve()
  enrolling ??= enrollWithCode(cur, cur.deviceToken)
    .then(markEnrolled)
    .finally(() => {
      enrolling = null
    })
  return enrolling
}
