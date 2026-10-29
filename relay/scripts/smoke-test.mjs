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
  obra: 'OBRA-TESTE',
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
    punch(base + 8, { obra: '' }),
    punch(base + 9, { obra: undefined }),
  ],
})
j = await r.json()
check('picagens inválidas rejeitadas (ID alheio, futuro, direção, SAGE ID vazio, sem obra)', j.rejected.length === 6, JSON.stringify(j))

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
check('picagem só tem SAGE ID, obra e dados do movimento', mine[0] && !('workerName' in mine[0]) && mine[0].sageId === '12345' && mine[0].obra === 'OBRA-TESTE' && mine[0].deviceId === DEVICE)

const ids = j.punches.map((p) => p.eventId)
r = await signed('POST', '/ack', JSON.stringify({ eventIds: ids }))
check('POST /ack apaga as picagens lidas', r.status === 200 && (await r.json()).deleted === ids.length)
r = await signed('GET', '/pull?limit=50')
check('depois do ack o relay fica vazio', (await r.json()).punches.length === 0)

// 6. lista de trabalhadores: o Supabase publica, o tablet lê só a sua obra
const gen = Date.now()
const roster = [
  { sageId: 'S1', name: 'Ana Silva', obra: 'OBRA-TESTE', active: true },
  { sageId: 'S2', name: 'Bruno Costa', obra: 'OBRA-TESTE', active: true },
  { sageId: 'S3', name: 'Carla Dias', obra: 'OBRA-TESTE', active: false },
  { sageId: 'S4', name: 'Diogo Reis', obra: 'OUTRA-OBRA', active: true },
  { sageId: '', name: 'sem id', obra: 'OBRA-TESTE', active: true },
]
r = await fetch(`${RELAY}/roster`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': TOKEN }, body: JSON.stringify({ gen, final: true, workers: roster }) })
check('tablet não pode publicar a lista → 401', r.status === 401)
const body = JSON.stringify({ gen, final: true, workers: roster })
r = await signed('POST', '/roster', body)
j = await r.json()
check('Supabase publica a lista assinada (4 válidos, 1 recusado)', r.status === 200 && j.stored === 4 && j.rejected === 1, JSON.stringify(j))
const getRoster = (qs, token = TOKEN) => fetch(`${RELAY}/roster?device=${DEVICE}${qs}`, { headers: { 'x-device-token': token } })
r = await getRoster('&obra=OBRA-TESTE')
j = await r.json()
check('tablet lê só os ativos da sua obra, por nome', r.status === 200 && j.workers.map((w) => w.sageId).join() === 'S1,S2' && j.workers.every((w) => !('obra' in w)), JSON.stringify(j))
const genOut = j.generatedAt
r = await getRoster('&obra=%20obra-teste%20')
check('a obra compara-se sem maiúsculas nem espaços', (await r.json()).workers?.length === 2)
r = await getRoster(`&obra=OBRA-TESTE&since=${genOut}`)
check('sem alterações devolve unchanged', (await r.json()).unchanged === true)
r = await getRoster('&obra=OBRA-TESTE', 'token-errado')
check('token errado na lista → 401', r.status === 401)
r = await getRoster('')
check('sem obra → 400', r.status === 400)
const body2 = JSON.stringify({ gen: gen + 1, final: true, workers: [{ sageId: 'S2', name: 'Bruno C.', obra: 'OBRA-TESTE', active: true }] })
r = await signed('POST', '/roster', body2)
r = await getRoster('&obra=OBRA-TESTE')
j = await r.json()
check('novo envio apaga quem saiu da lista e atualiza nomes', j.workers.length === 1 && j.workers[0].name === 'Bruno C.', JSON.stringify(j))
r = await signed('POST', '/roster', JSON.stringify({ gen: gen + 2, final: true, workers: [] }))
check('lista vazia limpa tudo', ((await (await getRoster('&obra=OBRA-TESTE')).json()).workers || []).length === 0)

console.log(failed ? `\n${failed} teste(s) falharam` : '\nTudo OK')
process.exit(failed ? 1 : 0)
