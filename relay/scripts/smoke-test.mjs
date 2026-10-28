// Teste de fumo do relay. Usa o mesmo esquema de assinatura da Edge Function pull-punches.
//   RELAY=http://127.0.0.1:8787 DEVICE=dev-test TOKEN=<token> SECRET=<PULL_SECRET> node relay/scripts/smoke-test.mjs
import { createHmac } from 'node:crypto'

const { RELAY = 'http://127.0.0.1:8787', DEVICE = 'dev-test', TOKEN, SECRET } = process.env
if (!TOKEN || !SECRET) throw new Error('Defina TOKEN e SECRET')

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} ${ok ? '' : extra}`)
  if (!ok) failed++
}

const sign = (method, path, body = '', ts = Math.floor(Date.now() / 1000)) =>
  ({ ts, sig: createHmac('sha256', SECRET).update(`${method}\n${path}\n${ts}\n${body}`).digest('hex') })

async function signed(method, path, body = '', opts = {}) {
  const { ts, sig } = sign(method, path, body, opts.ts)
  return fetch(RELAY + path, {
    method,
    headers: { 'x-timestamp': String(ts), 'x-signature': opts.badSig ? '0'.repeat(64) : sig, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body || undefined,
  })
}

const punch = (counter, over = {}) => ({
  eventId: `${DEVICE}-${String(counter).padStart(6, '0')}`,
  sageId: '12345',
  direction: 'in',
  punchedAt: new Date().toISOString(),
  confidence: 0.91,
  ...over,
})
const post = (body, token = TOKEN) =>
  fetch(`${RELAY}/punch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': token }, body: JSON.stringify(body) })

const base = Date.now() % 900000 // evita colisões entre execuções

// 1. escrita válida e reenvio idempotente
let r = await post({ deviceId: DEVICE, punches: [punch(base), punch(base + 1, { direction: 'out' })] })
let j = await r.json()
check('POST /punch aceita 2 picagens', r.status === 200 && j.accepted.length === 2 && !!j.serverTime, JSON.stringify(j))
r = await post({ deviceId: DEVICE, punches: [punch(base)] })
check('reenvio do mesmo evento é aceite', r.status === 200)

// 2. autenticação do tablet
r = await post({ deviceId: DEVICE, punches: [punch(base + 2)] }, 'token-errado')
check('token errado → 401', r.status === 401)
r = await post({ deviceId: 'dev-inexistente', punches: [punch(base + 3, { eventId: `dev-inexistente-${base}` })] })
check('dispositivo desconhecido → 401', r.status === 401)

// 3. validação
r = await post({
  deviceId: DEVICE,
  punches: [
    punch(base + 4, { eventId: `outro-${base}` }),
    punch(base + 5, { punchedAt: new Date(Date.now() + 3600e3).toISOString() }),
    punch(base + 6, { direction: 'x' }),
    punch(base + 7, { sageId: '  ' }),
  ],
})
j = await r.json()
check('picagens inválidas rejeitadas (ID alheio, futuro, direção, SAGE ID vazio)', j.rejected.length === 4, JSON.stringify(j))

// 4. o tablet não consegue ler
r = await fetch(`${RELAY}/pull?limit=10`, { headers: { 'x-device-token': TOKEN } })
check('token do tablet não serve para /pull → 401', r.status === 401)
r = await signed('GET', '/pull?limit=10', '', { badSig: true })
check('assinatura inválida → 401', r.status === 401)
r = await signed('GET', '/pull?limit=10', '', { ts: Math.floor(Date.now() / 1000) - 3600 })
check('assinatura antiga (replay) → 401', r.status === 401)

// 5. leitura assinada, sem nomes, e confirmação
r = await signed('GET', '/pull?limit=50')
j = await r.json()
const mine = (j.punches || []).filter((p) => p.eventId === `${DEVICE}-${String(base).padStart(6, '0')}`)
check('GET /pull assinado devolve as picagens', r.status === 200 && mine.length === 1, JSON.stringify(j))
check('picagem só tem SAGE ID e dados do movimento', mine[0] && !('workerName' in mine[0]) && mine[0].sageId === '12345' && mine[0].deviceId === DEVICE)

const ids = j.punches.map((p) => p.eventId)
r = await signed('POST', '/ack', JSON.stringify({ eventIds: ids }))
check('POST /ack apaga as picagens lidas', r.status === 200 && (await r.json()).deleted === ids.length)
r = await signed('GET', '/pull?limit=50')
check('depois do ack o relay fica vazio', (await r.json()).punches.length === 0)

console.log(failed ? `\n${failed} teste(s) falharam` : '\nTudo OK')
process.exit(failed ? 1 : 0)
