// Teste de fumo da biometria no relay (ver smoke-test.mjs para as picagens). Precisa de um dispositivo com obra OBRA e de
// trabalhadores na lista dessa obra: OBRA_IN (ativo na OBRA) e OUT (ativo noutra obra), criados antes pelo chamador.
//   RELAY=http://127.0.0.1:8787 DEVICE=dev-test TOKEN=<token> SECRET=<PULL_SECRET> OBRA=OBRA-TESTE \
//   IN=B0001 OUT=B0002 node relay/scripts/smoke-test-bio.mjs
import { createHmac } from 'node:crypto'

const { RELAY = 'http://127.0.0.1:8787', DEVICE = 'dev-test', TOKEN, SECRET, OBRA = 'OBRA-TESTE', IN = 'B0001', OUT = 'B0002' } = process.env
if (!TOKEN || !SECRET) throw new Error('Defina TOKEN e SECRET')

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} ${ok ? '' : extra}`)
  if (!ok) failed++
}

async function signed(method, path, body = '', opts = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', SECRET).update(`${method}\n${path}\n${ts}\n${body}`).digest('hex')
  return fetch(RELAY + path, {
    method,
    headers: { 'x-timestamp': String(ts), 'x-signature': opts.badSig ? '0'.repeat(64) : sig, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body || undefined,
  })
}
const tablet = (path, body, token = TOKEN) =>
  fetch(RELAY + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': token }, body: JSON.stringify(body) })

const ENGINE = 'sface-fp32'
const blob = (tag) => JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', data: `dados-${tag}-${Math.random()}` })
const item = (sageId, b, over = {}) => ({ sageId, engine: ENGINE, blob: b, updatedAt: Date.now(), ...over })

// 1. tablet → relay
const b1 = blob('um')
let r = await tablet('/biometrics', { deviceId: DEVICE, items: [item(IN, b1), item(OUT, blob('dois'))] })
let j = await r.json()
check('POST /biometrics aceita 2 registos', r.status === 200 && j.accepted.length === 2 && j.rejected.length === 0, JSON.stringify(j))

r = await tablet('/biometrics', { deviceId: DEVICE, items: [item('X1', 'curto'), item('X2', blob('x'), { engine: 'MAIUSCULAS' }), item('', blob('x'))] })
j = await r.json()
check('registos inválidos são rejeitados (blob curto, motor inválido, SAGE ID vazio)', r.status === 200 && j.accepted.length === 0 && j.rejected.length === 3, JSON.stringify(j))

r = await tablet('/biometrics', { deviceId: DEVICE, items: [item(IN, b1)] }, 'token-errado')
check('token errado → 401', r.status === 401)
r = await tablet('/biometrics', { deviceId: 'dev-inexistente', items: [item(IN, b1)] })
check('dispositivo desconhecido → 401', r.status === 401)
r = await tablet('/biometrics', { deviceId: DEVICE, items: [] })
check('lista vazia → 400', r.status === 400)
r = await tablet('/biometrics', { deviceId: DEVICE, items: Array.from({ length: 51 }, (_, k) => item(`Z${k}`, b1)) })
check('mais de 50 registos → 400', r.status === 400)
r = await tablet('/biometrics', { deviceId: DEVICE, items: [item(IN, 'x'.repeat(150001))] })
j = await r.json().catch(() => ({}))
check('blob acima do limite é rejeitado', (r.status === 200 && j.rejected?.length === 1) || r.status === 413, `${r.status} ${JSON.stringify(j).slice(0, 80)}`)

// 2. Supabase lê e confirma (com o hash)
r = await fetch(`${RELAY}/pull-bio?limit=20`)
check('GET /pull-bio sem assinatura → 401', r.status === 401)
r = await signed('GET', '/pull-bio?limit=20', '', { badSig: true })
check('GET /pull-bio com assinatura errada → 401', r.status === 401)
r = await signed('GET', '/pull-bio?limit=20', '', { ts: Math.floor(Date.now() / 1000) - 3600 })
check('GET /pull-bio com assinatura antiga → 401', r.status === 401)
r = await signed('GET', '/pull-bio?limit=20')
j = await r.json()
const got = j.items?.find((x) => x.sageId === IN && x.engine === ENGINE)
check('GET /pull-bio devolve o registo com blob e hash', r.status === 200 && got?.blob === b1 && /^[0-9a-f]{64}$/.test(got?.hash) && got?.deviceId === DEVICE, JSON.stringify(j).slice(0, 200))

// o tablet reenvia uma versão nova antes da confirmação: a confirmação com o hash antigo não pode apagá-la
const b2 = blob('novo')
await tablet('/biometrics', { deviceId: DEVICE, items: [item(IN, b2)] })
r = await signed('POST', '/ack-bio', JSON.stringify({ items: [{ sageId: IN, engine: ENGINE, hash: got.hash }] }))
check('POST /ack-bio aceita', r.status === 200)
r = await signed('GET', '/pull-bio?limit=50')
j = await r.json()
const again = j.items.find((x) => x.sageId === IN && x.engine === ENGINE)
check('o registo mais recente substituiu o anterior e sobrevive à confirmação com o hash antigo', again?.blob === b2 && again.hash !== got.hash, JSON.stringify(again).slice(0, 120))
r = await signed('POST', '/ack-bio', JSON.stringify({ items: j.items.map((x) => ({ sageId: x.sageId, engine: x.engine, hash: x.hash })) }))
r = await signed('GET', '/pull-bio?limit=50')
j = await r.json()
check('confirmar com o hash certo esvazia o relay', j.items.filter((x) => x.sageId === IN || x.sageId === OUT).length === 0, JSON.stringify(j).slice(0, 120))
r = await signed('POST', '/ack-bio', JSON.stringify({ items: 'x' }))
check('ack inválido → 400', r.status === 400)

// 3. Supabase publica (bio-store) e o tablet pede
const gen1 = Date.now()
const stored = [item(IN, b2), item(OUT, blob('fora'))]
r = await signed('POST', '/bio-store', JSON.stringify({ gen: gen1, final: true, items: stored }))
j = await r.json()
check('POST /bio-store guarda 2', r.status === 200 && j.stored === 2, JSON.stringify(j))
r = await fetch(`${RELAY}/bio-store`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gen: gen1, final: true, items: stored }) })
check('POST /bio-store sem assinatura → 401', r.status === 401)

r = await tablet('/bio-fetch', { deviceId: DEVICE, engine: ENGINE, ids: [IN, OUT, 'NAOEXISTE'] })
j = await r.json()
check('POST /bio-fetch devolve só quem é da obra do tablet', r.status === 200 && j.items.length === 1 && j.items[0].sageId === IN && j.items[0].blob === b2, JSON.stringify(j).slice(0, 200))
r = await tablet('/bio-fetch', { deviceId: DEVICE, engine: 'faceres', ids: [IN] })
j = await r.json()
check('motor diferente não devolve nada', r.status === 200 && j.items.length === 0, JSON.stringify(j).slice(0, 120))
r = await tablet('/bio-fetch', { deviceId: DEVICE, engine: ENGINE, ids: [IN] }, 'token-errado')
check('/bio-fetch com token errado → 401', r.status === 401)
r = await tablet('/bio-fetch', { deviceId: DEVICE, engine: ENGINE, ids: Array.from({ length: 51 }, (_, k) => `Z${k}`) })
check('/bio-fetch com mais de 50 ids → 400', r.status === 400)
r = await tablet('/bio-fetch', { deviceId: DEVICE, engine: 'x y', ids: [IN] })
check('/bio-fetch com motor inválido → 400', r.status === 400)

// 4. novo envio (outro gen, final): quem desapareceu sai
const gen2 = gen1 + 1
r = await signed('POST', '/bio-store', JSON.stringify({ gen: gen2, final: true, items: [item(OUT, blob('fora2'))] }))
r = await tablet('/bio-fetch', { deviceId: DEVICE, engine: ENGINE, ids: [IN] })
j = await r.json()
check('o envio final apaga os registos de envios anteriores', j.items.length === 0, JSON.stringify(j).slice(0, 120))

// 5. CORS (pré-voo do navegador)
r = await fetch(`${RELAY}/biometrics`, { method: 'OPTIONS' })
check('OPTIONS /biometrics → 204', r.status === 204)
r = await fetch(`${RELAY}/bio-fetch`, { method: 'OPTIONS' })
check('OPTIONS /bio-fetch → 204', r.status === 204)

console.log(failed ? `\n${failed} FALHA(S)` : '\nTudo OK')
process.exit(failed ? 1 : 0)
