// Ajuda dos testes de fumo: faz de tablet (gera a chave, liga-se ao relay com o código de instalação e assina os pedidos), como a app
// (src/lib/relay.js). As chaves ficam em KEYDIR (por omissão, uma pasta temporária) para os vários testes usarem o mesmo dispositivo: o
// código de instalação só se pode gastar uma vez. Só para testes: aqui as chaves são exportáveis para se poderem guardar.
import { webcrypto, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { subtle } = webcrypto
const enc = new TextEncoder()
const ALG = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: 'SHA-256' }
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const sha = (s) => createHash('sha256').update(s).digest('hex')

export const newKeys = () => subtle.generateKey(ALG, true, ['sign', 'verify'])

// POST /enroll. proofKeys: chaves com que se assina a prova (por omissão as mesmas; trocá-las deve falhar).
export async function enroll(relay, id, code, keys, { ts = Math.floor(Date.now() / 1000), proofKeys = keys } = {}) {
  const pub = b64u(await subtle.exportKey('spki', keys.publicKey))
  const proof = b64u(await subtle.sign(SIGN, proofKeys.privateKey, enc.encode(`enroll\n${id}\n${ts}\n${pub}`)))
  return fetch(`${relay}/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-enroll-code': code },
    body: JSON.stringify({ deviceId: id, publicKey: pub, ts, proof }),
  })
}

// Um tablet ligado. req(método, caminho+query, corpo, opções): pedido assinado. Opções para testar falhas:
//   badSig (assinatura inválida), ts (hora), nonce, id (id no cabeçalho, assinado), signBody (assina este corpo e envia outro).
export function client(relay, id, keys) {
  return {
    id,
    async req(method, pathAndQuery, body, o = {}) {
      const bodyText = body === undefined ? '' : JSON.stringify(body)
      const signedText = o.signBody === undefined ? bodyText : JSON.stringify(o.signBody)
      const ts = o.ts ?? Math.floor(Date.now() / 1000)
      const nonce = o.nonce ?? b64u(webcrypto.getRandomValues(new Uint8Array(16)))
      const sid = o.id ?? id
      const msg = `${method}\n${pathAndQuery}\n${ts}\n${nonce}\n${sid}\n${sha(signedText)}`
      const sig = o.badSig ? b64u(new Uint8Array(64)) : b64u(await subtle.sign(SIGN, keys.privateKey, enc.encode(msg)))
      return fetch(`${relay}${pathAndQuery}`, {
        method,
        headers: { 'x-device-id': sid, 'x-timestamp': String(ts), 'x-nonce': nonce, 'x-signature': sig, ...(bodyText ? { 'Content-Type': 'application/json' } : {}) },
        body: bodyText || undefined,
      })
    },
  }
}

// Devolve o tablet `id`: carrega a chave guardada ou, se é a primeira vez, gera-a e liga-o com `code`.
export async function loadClient(relay, id, code) {
  const dir = process.env.KEYDIR || path.join(os.tmpdir(), 'timp-relay-test-keys')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  let keys
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    keys = { privateKey: await subtle.importKey('jwk', j.private, ALG, true, ['sign']), publicKey: await subtle.importKey('jwk', j.public, ALG, true, ['verify']) }
  } else {
    if (!code) throw new Error(`Falta o código de instalação de ${id} (ou a chave guardada em ${dir})`)
    keys = await newKeys()
    const r = await enroll(relay, id, code, keys)
    if (!r.ok) throw new Error(`ligar ${id} ao relay falhou: HTTP ${r.status} ${await r.text()}`)
    fs.writeFileSync(file, JSON.stringify({ private: await subtle.exportKey('jwk', keys.privateKey), public: await subtle.exportKey('jwk', keys.publicKey) }))
  }
  return client(relay, id, keys)
}
