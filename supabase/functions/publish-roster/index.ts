// Edge Function: publish-roster
// Envia ao relay (Cloudflare) a lista de trabalhadores por obra, para os tablets a lerem no Registar.
// Lê da vista `timetrack_roster` (sage_id, name, obra, active), criada pela migração 005 sobre as tabelas da
// intranet (workers, worker_work_sites, work_sites).
// Só se enviam os ativos, e só SAGE ID, nome e obra.
//
// Segredos (os mesmos da pull-punches): RELAY_URL, PULL_SECRET, CRON_SECRET.
// Publicar sem verificação JWT (a autenticação é o x-cron-secret):
//   supabase functions deploy publish-roster --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHUNK = 400 // o relay aceita até 500 por pedido
const PAGE = 1000

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
    return new Response(JSON.stringify({ sent: rows.length, stored, rejected }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: 'publish_failed', detail: String((e as Error)?.message ?? e).slice(0, 300) }), { status: 502 })
  }
})
