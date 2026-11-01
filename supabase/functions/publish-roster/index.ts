// Edge Function: publish-roster
// Envia ao relay (Cloudflare) a lista de trabalhadores por obra, para os tablets a lerem no Registar.
// Lê da vista `timetrack_roster` (sage_id, name, obra, active), criada pela migração 005 sobre as tabelas da
// intranet (workers, worker_work_sites, work_sites).
// Só se enviam os ativos, e só SAGE ID, nome e obra.
// Depois da lista, publica também a biometria cifrada pelos tablets (`timetrack_biometrics`, migração 009) dos ativos, para os
// tablets que ainda a não têm (de 6 em 6 horas, com o mesmo agendamento). O Supabase não decifra nada.
//
// Segredos (os mesmos da pull-punches): RELAY_URL, PULL_SECRET, CRON_SECRET.
// Publicar sem verificação JWT (a autenticação é o x-cron-secret):
//   supabase functions deploy publish-roster --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHUNK = 400 // o relay aceita até 500 por pedido
const PAGE = 1000
const BIO_PAGE = 200 // registos de biometria lidos de cada vez (cada blob pode ter dezenas de KB)
const BIO_CHUNK_ITEMS = 40 // o relay aceita até 50 por pedido
const BIO_CHUNK_CHARS = 180000 // e corpos até 256 KB

const enc = new TextEncoder()
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function signedPost(path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const key = await crypto.subtle.importKey('raw', enc.encode(Deno.env.get('PULL_SECRET')!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`POST\n${path}\n${ts}\n${body}`)))
  const res = await fetch(`${Deno.env.get('RELAY_URL')!.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'x-timestamp': ts, 'x-signature': sig, 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) throw new Error(`relay POST ${path} -> HTTP ${res.status}`)
  return res.json()
}

function timingSafeEqual(a: string, b: string) {
  const x = enc.encode(a)
  const y = enc.encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET') ?? ''
  if (!secret || !timingSafeEqual(req.headers.get('x-cron-secret') ?? '', secret)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    // todos os ativos, por páginas (o limite por omissão do Supabase é 1000 linhas)
    const rows: { sage_id: string; name: string; obra: string }[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('timetrack_roster')
        .select('sage_id, name, obra')
        .eq('active', true)
        .order('obra')
        .order('sage_id')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`roster: ${error.message}`)
      rows.push(...data)
      if (data.length < PAGE) break
    }

    const gen = Date.now() // identifica este envio; no último bloco o relay apaga os registos dos envios anteriores
    const chunks = rows.length ? Math.ceil(rows.length / CHUNK) : 1
    let stored = 0
    let rejected = 0
    for (let i = 0; i < chunks; i++) {
      const workers = rows.slice(i * CHUNK, (i + 1) * CHUNK).map((r) => ({ sageId: String(r.sage_id), name: r.name, obra: r.obra, active: true }))
      const out = await signedPost('/roster', JSON.stringify({ gen, final: i === chunks - 1, workers }))
      stored += out.stored ?? 0
      rejected += out.rejected ?? 0
    }
    // Biometria cifrada pelos tablets (migração 009), para os tablets que ainda a não têm. Só a dos trabalhadores ativos desta
    // lista; o relay entrega a cada tablet apenas a dos da sua obra. Num bloco à parte: se falhar, a lista já foi publicada
    // e o erro só aparece em `bioError`. O Supabase não decifra nada: reenvia os blobs tal como estão.
    const bio = { sent: 0, stored: 0, rejected: 0 }
    let bioError: string | undefined
    try {
      const active = new Set(rows.map((r) => String(r.sage_id)))
      const items: { sageId: string; engine: string; blob: string; updatedAt: number }[] = []
      for (let from = 0; ; from += BIO_PAGE) {
        const { data, error } = await supabase
          .from('timetrack_biometrics')
          .select('sage_id, engine, blob, updated_at')
          .order('sage_id')
          .order('engine')
          .range(from, from + BIO_PAGE - 1)
        if (error) throw new Error(`biometrics: ${error.message}`)
        for (const b of data) if (active.has(String(b.sage_id))) items.push({ sageId: String(b.sage_id), engine: b.engine, blob: b.blob, updatedAt: Date.parse(b.updated_at) })
        if (data.length < BIO_PAGE) break
      }
      // blocos limitados em número e em tamanho (o relay aceita corpos até 256 KB e 50 registos)
      const bgen = Date.now()
      const blocks: (typeof items)[] = []
      let cur: typeof items = []
      let chars = 0
      for (const it of items) {
        if (cur.length && (cur.length >= BIO_CHUNK_ITEMS || chars + it.blob.length > BIO_CHUNK_CHARS)) {
          blocks.push(cur)
          cur = []
          chars = 0
        }
        cur.push(it)
        chars += it.blob.length
      }
      blocks.push(cur) // o último (pode ser vazio: se já não há biometria, o relay esvazia o armazém)
      for (let i = 0; i < blocks.length; i++) {
        const out = await signedPost('/bio-store', JSON.stringify({ gen: bgen, final: i === blocks.length - 1, items: blocks[i] }))
        bio.stored += out.stored ?? 0
        bio.rejected += out.rejected ?? 0
      }
      bio.sent = items.length
    } catch (e) {
      console.error(e)
      bioError = String((e as Error)?.message ?? e).slice(0, 300)
    }

    // Lápides de apagar biometria (migração 011): dizem aos tablets que ainda têm o trabalhador que o apaguem. Só as dos últimos 365 dias.
    // Num bloco à parte; se a leitura falhar não se publica nada (para não esvaziar as lápides do relay por engano).
    const tomb = { sent: 0, stored: 0, rejected: 0 }
    let tombError: string | undefined
    try {
      const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
      const all: { sageId: string; blob: string; deletedAt: number }[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('timetrack_biometric_deletions')
          .select('sage_id, blob, deleted_at')
          .gte('deleted_at', since)
          .order('sage_id')
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`deletions: ${error.message}`)
        for (const d of data) all.push({ sageId: String(d.sage_id), blob: d.blob, deletedAt: Date.parse(d.deleted_at) })
        if (data.length < PAGE) break
      }
      const tgen = Date.now()
      const tblocks: (typeof all)[] = []
      let tcur: typeof all = []
      let tchars = 0
      for (const d of all) {
        if (tcur.length && (tcur.length >= 100 || tchars + d.blob.length > BIO_CHUNK_CHARS)) {
          tblocks.push(tcur)
          tcur = []
          tchars = 0
        }
        tcur.push(d)
        tchars += d.blob.length
      }
      tblocks.push(tcur) // o último pode ser vazio: já não há lápides válidas, o relay esvazia as publicadas
      for (let i = 0; i < tblocks.length; i++) {
        const out = await signedPost('/bio-tombstones', JSON.stringify({ gen: tgen, final: i === tblocks.length - 1, items: tblocks[i] }))
        tomb.stored += out.stored ?? 0
        tomb.rejected += out.rejected ?? 0
      }
      tomb.sent = all.length
    } catch (e) {
      console.error(e)
      tombError = String((e as Error)?.message ?? e).slice(0, 300)
    }

    return new Response(JSON.stringify({ sent: rows.length, stored, rejected, bio, bioError, tomb, tombError }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: 'publish_failed', detail: String((e as Error)?.message ?? e).slice(0, 300) }), { status: 502 })
  }
})
