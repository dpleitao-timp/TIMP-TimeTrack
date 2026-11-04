// Teste de fumo do relay. Usa o mesmo esquema de assinatura da Edge Function pull-punches.
//   RELAY=http://127.0.0.1:8787 DEVICE=dev-test CODE=<código de instalação> SECRET=<PULL_SECRET> node relay/scripts/smoke-test.mjs
// O dispositivo tem de ter a obra OBRA-TESTE no relay. O teste liga-o com o código de instalação (uso único; depois usa a chave guardada em
// KEYDIR, ver _device.mjs). Opcionais: DEVICE_NO_OBRA e CODE_NO_OBRA (dispositivo SEM obra); DEVICE_FRESH e CODE_FRESH (por ligar, para
// testar a ligação); DEVICE_MULTI e CODE_MULTI (obra OBRA-TESTE e a obra extra OBRA-B em device_obras); DEVICE_ALL e CODE_ALL (obra OBRA-TESTE e a linha '*' em device_obras: todas as obras da lista); DEVICE_EXPIRED e CODE_EXPIRED (código caducado); DEVICE_REVOKED e CODE_REVOKED (dispositivo revogado).
import { createHmac } from 'node:crypto'
import { loadClient, enroll, newKeys } from './_device.mjs'

const { RELAY = 'http://127.0.0.1:8787', DEVICE = 'dev-test', CODE, SECRET, DEVICE_NO_OBRA, CODE_NO_OBRA, DEVICE_FRESH, CODE_FRESH, DEVICE_EXPIRED, CODE_EXPIRED, DEVICE_REVOKED, CODE_REVOKED, DEVICE_MULTI, CODE_MULTI, DEVICE_ALL, CODE_ALL } = process.env
if (!SECRET) throw new Error('Defina SECRET (e CODE, ou uma chave já guardada em KEYDIR)')
const dev = await loadClient(RELAY, DEVICE, CODE) // o tablet de teste, ligado ao relay
const multi = DEVICE_MULTI ? await loadClient(RELAY, DEVICE_MULTI, CODE_MULTI) : null // opcional: relógio com obras extra (OBRA-TESTE por defeito e OBRA-B em device_obras)
const all = DEVICE_ALL ? await loadClient(RELAY, DEVICE_ALL, CODE_ALL) : null // opcional: relógio de todas as obras (obra OBRA-TESTE e a linha '*' em device_obras)
const noObraDev = DEVICE_NO_OBRA ? await loadClient(RELAY, DEVICE_NO_OBRA, CODE_NO_OBRA) : null

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
const post = (body, opts) => dev.req('POST', '/punch', body, opts)

const base = Date.now() % 900000 // evita colisões entre execuções

// 1. escrita válida e reenvio idempotente
let r = await post({ deviceId: DEVICE, punches: [punch(base), punch(base + 1, { direction: 'out' })] })
let j = await r.json()
check('POST /punch aceita 2 picagens', r.status === 200 && j.accepted.length === 2 && !!j.serverTime, JSON.stringify(j))
r = await post({ deviceId: DEVICE, punches: [punch(base)] })
check('reenvio do mesmo evento é aceite', r.status === 200)
r = await post({ deviceId: DEVICE, punches: [punch(base + 20, { direction: 'meal_out' }), punch(base + 21, { direction: 'meal_in' })] })
j = await r.json()
check('saída e entrada de almoço/jantar são aceites', r.status === 200 && j.accepted.length === 2 && j.rejected.length === 0, JSON.stringify(j))

// 2. autenticação do tablet
r = await post({ deviceId: DEVICE, punches: [punch(base + 2)] }, { badSig: true })
check('assinatura inválida → 401', r.status === 401)
r = await post({ deviceId: 'dev-inexistente', punches: [punch(base + 3, { eventId: `dev-inexistente-${base}` })] }, { id: 'dev-inexistente' })
check('dispositivo desconhecido → 401', r.status === 401)
r = await post({ deviceId: 'dev-inexistente', punches: [punch(base + 3)] })
check('o id do corpo tem de ser o do dispositivo que assina → 400', r.status === 400, String(r.status))

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
    punch(base + 10, { obra: 'OUTRA-OBRA' }),
  ],
})
j = await r.json()
check('picagens inválidas rejeitadas (ID alheio, futuro, direção, SAGE ID vazio, sem obra, obra que não é a do dispositivo)', j.rejected.length === 7, JSON.stringify(j))
// a obra compara-se sem maiúsculas nem espaços, e fica gravada a do dispositivo
r = await post({ deviceId: DEVICE, punches: [punch(base + 11, { obra: '  obra-teste ' })] })
j = await r.json()
check('a obra do dispositivo compara-se sem maiúsculas nem espaços', r.status === 200 && j.accepted.length === 1 && j.rejected.length === 0, JSON.stringify(j))
r = await signed('GET', '/pull?limit=50')
j = await r.json()
check('a picagem fica gravada com a obra do dispositivo', j.punches.find((p) => p.eventId === `${DEVICE}-${String(base + 11).padStart(6, '0')}`)?.obra === 'OBRA-TESTE', JSON.stringify(j).slice(0, 160))
await signed('POST', '/ack', JSON.stringify({ eventIds: [`${DEVICE}-${String(base + 11).padStart(6, '0')}`] }))
if (noObraDev) {
  r = await noObraDev.req('POST', '/punch', { deviceId: DEVICE_NO_OBRA, punches: [punch(base + 12, { eventId: `${DEVICE_NO_OBRA}-${String(base + 12).padStart(6, '0')}` })] })
  check('dispositivo sem obra no relay não pode picar → 403', r.status === 403, String(r.status))
}

// 4. o tablet não consegue ler
r = await dev.req('GET', '/pull?limit=10')
check('a chave do tablet não serve para /pull (só a assinatura do Supabase) → 401', r.status === 401)
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
r = await dev.req('POST', '/roster', { gen, final: true, workers: roster })
check('tablet não pode publicar a lista → 401', r.status === 401)
const body = JSON.stringify({ gen, final: true, workers: roster })
r = await signed('POST', '/roster', body)
j = await r.json()
check('Supabase publica a lista assinada (4 válidos, 1 recusado)', r.status === 200 && j.stored === 4 && j.rejected === 1, JSON.stringify(j))
const getRoster = (qs, opts) => dev.req('GET', `/roster?device=${DEVICE}${qs}`, undefined, opts)
r = await getRoster('&obra=OBRA-TESTE')
j = await r.json()
check('tablet lê só os ativos da sua obra, por nome', r.status === 200 && j.workers.map((w) => w.sageId).join() === 'S1,S2' && j.workers.every((w) => !('obra' in w)), JSON.stringify(j))
const genOut = j.generatedAt
r = await getRoster('&obra=%20obra-teste%20')
check('a obra compara-se sem maiúsculas nem espaços', (await r.json()).workers?.length === 2)
r = await getRoster(`&obra=OBRA-TESTE&since=${genOut}`)
check('sem alterações devolve unchanged', (await r.json()).unchanged === true)
r = await getRoster('&obra=OBRA-TESTE', { badSig: true })
check('assinatura inválida na lista → 401', r.status === 401)
r = await getRoster('&obra=OUTRA-OBRA')
j = await r.json()
check('o tablet não escolhe a obra: pedir outra devolve a lista da obra do dispositivo', r.status === 200 && j.workers.map((w) => w.sageId).join() === 'S1,S2', JSON.stringify(j))
r = await getRoster('')
j = await r.json()
check('sem indicar obra usa a do dispositivo', r.status === 200 && j.workers.length === 2, JSON.stringify(j))
if (noObraDev) {
  r = await noObraDev.req('GET', `/roster?device=${DEVICE_NO_OBRA}&obra=OBRA-TESTE`)
  check('dispositivo sem obra no relay não lê a lista → 403', r.status === 403, String(r.status))
}
const body2 = JSON.stringify({ gen: gen + 1, final: true, workers: [{ sageId: 'S2', name: 'Bruno C.', obra: 'OBRA-TESTE', active: true }] })
r = await signed('POST', '/roster', body2)
r = await getRoster('&obra=OBRA-TESTE')
j = await r.json()
check('novo envio apaga quem saiu da lista e atualiza nomes', j.workers.length === 1 && j.workers[0].name === 'Bruno C.', JSON.stringify(j))
r = await signed('POST', '/roster', JSON.stringify({ gen: gen + 2, final: true, workers: [] }))
check('lista vazia limpa tudo', ((await (await getRoster('&obra=OBRA-TESTE')).json()).workers || []).length === 0)

// 7. apagar picagens: o tablet pede, o Supabase lê o pedido e confirma
const del = (body, opts) => dev.req('POST', '/punch/delete', body, opts)
const d1 = `${DEVICE}-${String(base + 100).padStart(6, '0')}`
const d2 = `${DEVICE}-${String(base + 101).padStart(6, '0')}`
await post({ deviceId: DEVICE, punches: [punch(base + 100), punch(base + 101)] })
r = await del({ deviceId: DEVICE, eventIds: [d1, `outro-${base}`] }, { badSig: true })
check('apagar com assinatura inválida → 401', r.status === 401)
r = await del({ deviceId: DEVICE, eventIds: [d1, `outro-${base}`] })
j = await r.json()
check('só aceita apagar picagens do próprio dispositivo', r.status === 200 && j.accepted.length === 1 && j.accepted[0] === d1, JSON.stringify(j))
r = await signed('GET', '/pull?limit=50')
j = await r.json()
const left = (j.punches || []).map((p) => p.eventId)
check('a picagem apagada sai do relay se ainda lá estava', !left.includes(d1) && left.includes(d2), JSON.stringify(left))
r = await dev.req('GET', '/pull-deletions')
check('a chave do tablet não serve para /pull-deletions → 401', r.status === 401)
r = await signed('GET', '/pull-deletions')
j = await r.json()
check('Supabase lê o pedido de apagar', r.status === 200 && j.deletions.some((x) => x.eventId === d1 && x.deviceId === DEVICE), JSON.stringify(j))
r = await signed('POST', '/ack-deletions', JSON.stringify({ eventIds: j.deletions.map((x) => x.eventId) }))
check('POST /ack-deletions confirma', r.status === 200)
r = await signed('GET', '/pull-deletions')
check('depois do ack não há pedidos', (await r.json()).deletions.length === 0)
await signed('POST', '/ack', JSON.stringify({ eventIds: [d2] })) // limpeza

// 8. dados de reconhecimento (2º mais parecido, anti-foto): chegam ao Supabase; inválidos viram null e não rejeitam
const r1 = `${DEVICE}-${String(base + 200).padStart(6, '0')}`
const r2 = `${DEVICE}-${String(base + 201).padStart(6, '0')}`
r = await post({ deviceId: DEVICE, punches: [punch(base + 200, { second: 0.42, real: 0.7, live: 0.8 }), punch(base + 201, { second: 7, real: 'x', live: -1 })] })
j = await r.json()
check('picagem com dados de reconhecimento é aceite (inválidos não a rejeitam)', r.status === 200 && j.accepted.length === 2 && j.rejected.length === 0, JSON.stringify(j))
r = await signed('GET', '/pull?limit=50')
j = await r.json()
const g1 = j.punches.find((p) => p.eventId === r1)
const g2 = j.punches.find((p) => p.eventId === r2)
check('o Supabase recebe second/real/live', g1?.second === 0.42 && g1?.real === 0.7 && g1?.live === 0.8, JSON.stringify(g1))
check('valores fora de 0..1 ou não numéricos chegam como null', g2 && g2.second === null && g2.real === null && g2.live === null, JSON.stringify(g2))
await signed('POST', '/ack', JSON.stringify({ eventIds: [r1, r2] })) // limpeza

// 9. chave por dispositivo: repetir, hora, corpo adulterado, outra chave, token antigo, e a ligação (enrol) com o código de uso único
const roster9 = `/roster?device=${DEVICE}&obra=OBRA-TESTE`
const NONCE = ('N' + Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(20, 'x') // novo a cada execução (o relay guarda os nonces 10 minutos)
r = await dev.req('GET', roster9, undefined, { nonce: NONCE })
check('pedido assinado com um nonce novo passa', r.status === 200, String(r.status))
r = await dev.req('GET', roster9, undefined, { nonce: NONCE })
j = await r.json().catch(() => ({}))
check('repetir o mesmo pedido assinado (mesmo nonce) → 401 replay', r.status === 401 && j.error === 'replay', JSON.stringify(j))
// o último contacto do tablet só se atualiza com pedidos novos: repetir um pedido apanhado (mesmo nonce) não o faz parecer vivo
const lastSeen = async () => (await (await signed('GET', '/devices-status')).json()).devices.find((d) => d.id === DEVICE)?.lastSeen
const seen0 = await lastSeen()
await new Promise((x) => setTimeout(x, 1200))
const NONCE2 = ('M' + Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(20, 'x')
await dev.req('GET', roster9, undefined, { nonce: NONCE2 })
const seen1 = await lastSeen()
await new Promise((x) => setTimeout(x, 1200))
r = await dev.req('GET', roster9, undefined, { nonce: NONCE2 })
const seen2 = await lastSeen()
check('um pedido novo atualiza o último contacto', seen1 > seen0, `${seen0} ${seen1}`)
check('repetir o pedido (mesmo nonce) → 401 e NÃO atualiza o último contacto', r.status === 401 && seen2 === seen1, `${r.status} ${seen1} ${seen2}`)
r = await dev.req('GET', roster9, undefined, { ts: Math.floor(Date.now() / 1000) - 3600 })
j = await r.json().catch(() => ({}))
check('hora muito desacertada → 401 bad_timestamp com a hora do relay (o tablet acerta-se)', r.status === 401 && j.error === 'bad_timestamp' && Number.isFinite(Date.parse(j.serverTime)), JSON.stringify(j))
r = await dev.req('POST', '/punch', { deviceId: DEVICE, punches: [punch(base + 300)] }, { signBody: { deviceId: DEVICE, punches: [punch(base + 301)] } })
check('corpo diferente do que foi assinado → 401', r.status === 401, String(r.status))
r = await post({ deviceId: DEVICE, punches: [punch(base + 302)] }, { id: DEVICE_NO_OBRA || 'dev-outro' })
check('assinar com a chave de um dispositivo e dizer que é outro → 401', r.status === 401, String(r.status))
r = await fetch(`${RELAY}/punch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': 'um-token-qualquer' }, body: JSON.stringify({ deviceId: DEVICE, punches: [punch(base + 303)] }) })
check('o token antigo já não autentica nada → 401', r.status === 401, String(r.status))
r = await fetch(`${RELAY}/punch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(300000) })
check('corpo acima do limite → 413 sem o ler (e sem autenticar)', r.status === 413, String(r.status))

// o ID de uma picagem é `<dispositivo>-<dígitos>`: com letras ou hífenes a seguir ao prefixo (era assim que `dev-1` apanhava IDs de `dev-1-2`) é recusado
r = await post({ deviceId: DEVICE, punches: [punch(base + 410, { eventId: `${DEVICE}-2-000001` }), punch(base + 411, { eventId: `${DEVICE}-12a` }), punch(base + 412, { eventId: `${DEVICE}-` })] })
j = await r.json()
check('ID com algo que não são dígitos depois do prefixo do dispositivo é rejeitado', r.status === 200 && j.rejected.length === 3 && j.accepted.length === 3, JSON.stringify(j))
r = await dev.req('POST', '/punch/delete', { deviceId: DEVICE, eventIds: [`${DEVICE}-2-000001`, `${DEVICE}-x`] })
j = await r.json()
check('apagar também só aceita IDs do dispositivo (prefixo e dígitos)', r.status === 200 && j.accepted.length === 0, JSON.stringify(j))

// a semelhança (confidence) fora de -1..1 ou não numérica não pode chegar ao Supabase (numeric(5,3) rebentava o lote inteiro): vira null e a picagem segue
const cid = (n) => `${DEVICE}-${String(base + n).padStart(6, '0')}`
r = await post({ deviceId: DEVICE, punches: [punch(base + 400, { confidence: 0.5 }), punch(base + 401, { confidence: 1000 }), punch(base + 402, { confidence: -0.4 }), punch(base + 403, { confidence: 'x' }), punch(base + 404, { confidence: -50 })] })
j = await r.json()
check('picagens com confidence inválida são aceites (não perdem a picagem)', r.status === 200 && j.accepted.length === 5 && j.rejected.length === 0, JSON.stringify(j))
r = await signed('GET', '/pull?limit=100')
j = await r.json()
const conf = [400, 401, 402, 403, 404].map((n) => j.punches.find((p) => p.eventId === cid(n))?.confidence)
check('confidence: 0.5 e -0.4 ficam; 1000, "x" e -50 chegam como null', JSON.stringify(conf) === '[0.5,null,-0.4,null,null]', JSON.stringify(conf))
await signed('POST', '/ack', JSON.stringify({ eventIds: [400, 401, 402, 403, 404].map(cid) })) // limpeza

// a biometria já não passa pelo relay: os pedidos que a transportavam deixaram de existir
for (const [method, path] of [['POST', '/biometrics'], ['POST', '/bio-fetch'], ['POST', '/bio-delete'], ['POST', '/bio-deleted']]) {
  r = await dev.req(method, path, { deviceId: DEVICE })
  check(`${path} já não existe → 404`, r.status === 404, String(r.status))
}
for (const [method, path] of [['GET', '/pull-bio'], ['GET', '/pull-bio-deletions']]) {
  r = await signed(method, path)
  check(`${path} já não existe → 404`, r.status === 404, String(r.status))
}

// Relógio com várias obras (a obra por defeito OBRA-TESTE e a extra OBRA-B, em device_obras): pica nas duas, a lista traz as obras de cada um
if (multi) {
  const mid = (n) => `${DEVICE_MULTI}-${String(base + n).padStart(6, '0')}`
  const mp = (n, over = {}) => punch(base + n, { eventId: mid(n), ...over })
  const mpost = (body, opts) => multi.req('POST', '/punch', body, opts)
  r = await mpost({ deviceId: DEVICE_MULTI, punches: [mp(500), mp(501, { obra: 'OBRA-B', direction: 'out' }), mp(502, { obra: ' obra-b ' }), mp(503, { obra: 'OBRA-C' })] })
  j = await r.json()
  check('relógio com obras extra: aceita a por defeito e a extra, recusa as outras', r.status === 200 && j.rejected.join() === mid(503) && j.accepted.length === 4, JSON.stringify(j))
  r = await signed('GET', '/pull?limit=100')
  j = await r.json()
  const mobra = (n) => j.punches.find((p) => p.eventId === mid(n))?.obra
  check('a picagem fica com a obra do relay (a extra, sem depender das maiúsculas)', mobra(500) === 'OBRA-TESTE' && mobra(501) === 'OBRA-B' && mobra(502) === 'OBRA-B' && mobra(503) === undefined, JSON.stringify([500, 501, 502, 503].map(mobra)))
  await signed('POST', '/ack', JSON.stringify({ eventIds: [mid(500), mid(501), mid(502)] })) // limpeza
  // o dispositivo de uma só obra continua a não poder picar na extra do outro
  r = await post({ deviceId: DEVICE, punches: [punch(base + 510, { obra: 'OBRA-B' })] })
  j = await r.json()
  check('um dispositivo sem obras extra não pica na obra extra de outro', r.status === 200 && j.rejected.length === 1, JSON.stringify(j))

  const genM = Date.now() + 10
  const rosterM = [
    { sageId: 'M1', name: 'Ana Silva', obra: 'OBRA-TESTE', active: true },
    { sageId: 'M1', name: 'Ana Silva', obra: 'OBRA-B', active: true },
    { sageId: 'M2', name: 'Bruno Costa', obra: 'OBRA-B', active: true },
    { sageId: 'M3', name: 'Carla Dias', obra: 'OBRA-B', active: false },
    { sageId: 'M4', name: 'Diogo Reis', obra: 'OBRA-TESTE', active: true },
    { sageId: 'M5', name: 'Eva Lima', obra: 'OBRA-C', active: true },
  ]
  r = await signed('POST', '/roster', JSON.stringify({ gen: genM, final: true, workers: rosterM }))
  const getM = (qs = '') => multi.req('GET', `/roster?device=${DEVICE_MULTI}${qs}`)
  r = await getM()
  j = await r.json()
  const byId = Object.fromEntries((j.workers || []).map((w) => [w.sageId, w.obras?.join('|')]))
  check('relógio com obras extra: lista os ativos das suas obras e as obras de cada um (a por defeito primeiro)', r.status === 200 && JSON.stringify(byId) === JSON.stringify({ M1: 'OBRA-TESTE|OBRA-B', M2: 'OBRA-B', M4: 'OBRA-TESTE' }) && j.obras.join() === 'OBRA-TESTE,OBRA-B', JSON.stringify(j))
  check('a lista inclui a assinatura do conjunto de obras', typeof j.sig === 'string' && j.sig !== '', JSON.stringify(j.sig))
  const sigM = j.sig
  r = await getM(`&since=${j.generatedAt}&set=${encodeURIComponent(sigM)}`)
  check('sem alterações e com o mesmo conjunto de obras → unchanged', (await r.json()).unchanged === true)
  r = await getM(`&since=${j.generatedAt}&set=`)
  j = await r.json()
  check('com outro conjunto de obras (set) a lista volta a ser enviada', !j.unchanged && j.workers?.length === 3, JSON.stringify(j))
  r = await getM(`&since=${j.generatedAt}`)
  check('sem indicar o conjunto (tablets antigos) conta só a geração → unchanged', (await r.json()).unchanged === true)
  // o dispositivo de uma só obra vê só a sua, sem obras por trabalhador
  r = await getRoster('')
  j = await r.json()
  check('o dispositivo de uma só obra continua a receber só a sua obra, sem obras por trabalhador', r.status === 200 && j.workers.map((w) => w.sageId).join() === 'M1,M4' && j.workers.every((w) => !('obras' in w)) && j.sig === '' && j.obras.length === 1, JSON.stringify(j))
}

// Relógio de "todas as obras" (linha `*` em device_obras): aceita as obras que a lista tem (mesmo as que não estavam quando se configurou) e recusa as outras
if (all) {
  const aid = (n) => `${DEVICE_ALL}-${String(base + n).padStart(6, '0')}`
  const ap = (n, over = {}) => punch(base + n, { eventId: aid(n), ...over })
  const genA = Date.now() + 20
  await signed('POST', '/roster', JSON.stringify({ gen: genA, final: true, workers: [
    { sageId: 'N1', name: 'Nuno Alves', obra: 'OBRA-TESTE', active: true },
    { sageId: 'N1', name: 'Nuno Alves', obra: 'OBRA-NOVA', active: true },
    { sageId: 'N2', name: 'Olga Pinto', obra: 'OBRA-NOVA', active: true },
    { sageId: 'N3', name: 'Paulo Reis', obra: 'OBRA-SEM-ATIVOS', active: false },
  ] }))
  r = await all.req('POST', '/punch', { deviceId: DEVICE_ALL, punches: [ap(600, { obra: 'OBRA-NOVA' }), ap(601, { obra: ' obra-nova ' }), ap(602, { obra: 'OBRA-TESTE' }), ap(603, { obra: 'OBRA-INVENTADA' }), ap(604, { obra: 'OBRA-SEM-ATIVOS' })] })
  j = await r.json()
  check('relógio de todas as obras: aceita as da lista e recusa as que a lista não tem', r.status === 200 && j.rejected.sort().join() === [aid(603), aid(604)].sort().join(), JSON.stringify(j))
  r = await signed('GET', '/pull?limit=100')
  j = await r.json()
  check('grava a obra com o nome do relay', j.punches.find((p) => p.eventId === aid(601))?.obra === 'OBRA-NOVA', JSON.stringify(j.punches.find((p) => p.eventId === aid(601))))
  await signed('POST', '/ack', JSON.stringify({ eventIds: [aid(600), aid(601), aid(602)] })) // limpeza
  r = await all.req('GET', `/roster?device=${DEVICE_ALL}`)
  j = await r.json()
  const aby = Object.fromEntries((j.workers || []).map((w) => [w.sageId, w.obras.join('|')]))
  check('a lista de todas as obras traz as obras de cada trabalhador (a por defeito primeiro)', JSON.stringify(aby) === JSON.stringify({ N1: 'OBRA-TESTE|OBRA-NOVA', N2: 'OBRA-NOVA' }) && j.obras.join() === 'OBRA-TESTE,OBRA-NOVA', JSON.stringify(j))
  check('a assinatura do conjunto de obras é um resumo curto', /^[0-9a-f]{24}$/.test(j.sig), j.sig)
  // uma obra nova na lista passa a valer sozinha, e a lista é enviada de novo mesmo sem ter mudado a geração do Supabase? (muda: é um envio novo)
  await signed('POST', '/roster', JSON.stringify({ gen: genA + 1, final: true, workers: [{ sageId: 'N1', name: 'Nuno Alves', obra: 'OBRA-TESTE', active: true }, { sageId: 'N1', name: 'Nuno Alves', obra: 'OBRA-MAIS-NOVA', active: true }] }))
  r = await all.req('POST', '/punch', { deviceId: DEVICE_ALL, punches: [ap(610, { obra: 'OBRA-MAIS-NOVA' }), ap(611, { obra: 'OBRA-NOVA' })] })
  j = await r.json()
  check('uma obra que aparece na lista passa a ser aceite sem mexer no relay (e uma que saiu deixa de ser)', r.status === 200 && j.rejected.join() === aid(611), JSON.stringify(j))
  await signed('POST', '/ack', JSON.stringify({ eventIds: [aid(610)] })) // limpeza
}

// Configuração dos relógios pela intranet (POST /devices-config, assinado): registar, obra, função, almoço/jantar, revogar. Sem comandos à mão.
{
  const { createHash } = await import('node:crypto')
  const cfgId = `dev-cfg-${Date.now().toString(36)}`.slice(0, 40)
  const rawCode = 'ABCDEFGHJKLMNPQR' // código de teste (16 caracteres, sem hífenes); o relay só recebe o hash
  const codeHash = createHash('sha256').update(rawCode).digest('hex')
  const cfg = (b, opts) => signed('POST', '/devices-config', JSON.stringify(b), opts)
  r = await dev.req('POST', '/devices-config', { action: 'config', deviceId: DEVICE, obra: 'X' })
  check('a chave do tablet não serve para /devices-config → 401', r.status === 401, String(r.status))
  r = await cfg({ action: 'config', deviceId: DEVICE, obra: 'X' }, { badSig: true })
  check('/devices-config com assinatura inválida → 401', r.status === 401)
  r = await cfg({ action: 'register', deviceId: cfgId, obra: 'OBRA-CFG', codeHash: 'nao-e-hash' })
  check('registar com um hash inválido → 400', r.status === 400, String(r.status))
  r = await cfg({ action: 'register', deviceId: 'a b', obra: 'OBRA-CFG', codeHash })
  check('registar com um id inválido → 400', r.status === 400)
  r = await cfg({ action: 'config', deviceId: 'dev-que-nao-existe', obra: 'OBRA-CFG' })
  check('configurar um relógio que não existe → 404', r.status === 404, String(r.status))
  r = await cfg({ action: 'register', deviceId: cfgId, obra: 'OBRA-CFG', codeHash, allObras: false, mode: 'in', mealPunches: true })
  check('registar um relógio novo pela intranet', r.status === 200 && (await r.json()).ok === true, String(r.status))
  const keysCfg = await newKeys()
  r = await enroll(RELAY, cfgId, rawCode, keysCfg)
  check('o tablet liga-se com o código cujo hash a intranet registou', r.status === 200, String(r.status))
  const { client: mkClient } = await import('./_device.mjs')
  const cfgDev = mkClient(RELAY, cfgId, keysCfg)
  r = await cfgDev.req('GET', `/roster?device=${cfgId}`)
  j = await r.json()
  check('a lista traz a obra, a função e o almoço/jantar definidos na intranet', r.status === 200 && j.obra === 'OBRA-CFG' && j.config?.mode === 'in' && j.config?.mealPunches === true, JSON.stringify(j.config))
  r = await cfg({ action: 'config', deviceId: cfgId, obra: 'OBRA-CFG-2', allObras: true, mode: 'both', mealPunches: false })
  check('mudar obra, função, almoço/jantar e "todas as obras"', r.status === 200)
  r = await cfgDev.req('GET', `/roster?device=${cfgId}&since=${j.generatedAt}&set=`)
  j = await r.json()
  check('a mudança chega ao tablet mesmo sem lista nova (unchanged também leva a config)', j.obra === 'OBRA-CFG-2' && j.config?.mode === 'both' && j.config?.mealPunches === false, JSON.stringify(j).slice(0, 200))
  r = await signed('GET', '/devices-status')
  j = await r.json()
  const st = j.devices.find((d) => d.id === cfgId)
  check('devices-status diz se o relógio serve todas as obras', st?.allObras === true && st?.obra === 'OBRA-CFG-2', JSON.stringify(st))
  r = await cfg({ action: 'config', deviceId: cfgId, obra: 'OBRA-CFG-2', allObras: false })
  r = await signed('GET', '/devices-status')
  check('desligar "todas as obras" tira a linha *', (await r.json()).devices.find((d) => d.id === cfgId)?.allObras === false)
  r = await cfg({ action: 'config', deviceId: cfgId, obra: 'OBRA-CFG-2' })
  j = await (await cfgDev.req('GET', `/roster?device=${cfgId}`)).json()
  check('um pedido sem função nem almoço/jantar não os apaga', j.config?.mode === 'both' && j.config?.mealPunches === false, JSON.stringify(j.config))
  r = await cfg({ action: 'revoke', deviceId: cfgId })
  check('revogar pela intranet', r.status === 200)
  r = await cfgDev.req('GET', `/roster?device=${cfgId}`)
  check('o tablet revogado deixa de falar com o relay → 401', r.status === 401, String(r.status))
  r = await cfg({ action: 'reactivate', deviceId: cfgId })
  r = await cfgDev.req('GET', `/roster?device=${cfgId}`)
  check('reativar não devolve a chave ao tablet: precisa de um código novo → 401', r.status === 401, String(r.status))
  const hash2 = createHash('sha256').update('SEGUNDOCODIGOTESTE').digest('hex')
  r = await cfg({ action: 'register', deviceId: cfgId, obra: 'OBRA-CFG-2', codeHash: hash2 })
  r = await enroll(RELAY, cfgId, 'SEGUNDOCODIGOTESTE', await newKeys())
  check('um código novo (register) volta a ligar o relógio', r.status === 200, String(r.status))
}

if (DEVICE_FRESH && CODE_FRESH) {
  const keys = await newKeys()
  r = await enroll(RELAY, DEVICE_FRESH, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', keys)
  check('ligar com o código errado → 401', r.status === 401, String(r.status))
  r = await enroll(RELAY, DEVICE_FRESH, CODE_FRESH, keys, { proofKeys: await newKeys() })
  check('ligar com uma prova que não é da chave enviada → 401 (e o código não se gasta)', r.status === 401, String(r.status))
  r = await enroll(RELAY, DEVICE_FRESH, CODE_FRESH, keys, { ts: Math.floor(Date.now() / 1000) - 3600 })
  j = await r.json().catch(() => ({}))
  check('ligar com a hora desacertada → bad_timestamp', r.status === 401 && j.error === 'bad_timestamp', JSON.stringify(j))
  r = await enroll(RELAY, DEVICE_FRESH, CODE_FRESH.toLowerCase(), keys) // o código aceita-se em minúsculas e com hífenes
  check('ligar com o código certo (escrito em minúsculas) → 200', r.status === 200 && (await r.json()).ok === true, String(r.status))
  r = await enroll(RELAY, DEVICE_FRESH, CODE_FRESH, await newKeys())
  check('o código gasta-se: usá-lo outra vez → 401', r.status === 401, String(r.status))
  const { client } = await import('./_device.mjs')
  const fresh = client(RELAY, DEVICE_FRESH, keys)
  r = await fresh.req('GET', `/roster?device=${DEVICE_FRESH}`)
  check('o dispositivo ligado assina pedidos (sem obra no relay → 403, não 401)', r.status === 403, String(r.status))
}
if (DEVICE_EXPIRED && CODE_EXPIRED) {
  r = await enroll(RELAY, DEVICE_EXPIRED, CODE_EXPIRED, await newKeys())
  check('código caducado → 401', r.status === 401, String(r.status))
}
if (DEVICE_REVOKED && CODE_REVOKED) {
  r = await enroll(RELAY, DEVICE_REVOKED, CODE_REVOKED, await newKeys())
  check('dispositivo revogado não se liga → 401', r.status === 401, String(r.status))
}

console.log(failed ?`\n${failed} teste(s) falharam` : '\nTudo OK')
process.exit(failed ? 1 : 0)
