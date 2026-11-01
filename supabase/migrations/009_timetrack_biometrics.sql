-- Biometria dos tablets (vetores faciais), CIFRADA pelos tablets com a chave da frota.
-- O Supabase só guarda e reenvia blobs ilegíveis: nunca tem a chave nem decifra nada (nem a intranet consegue ler vetores).
-- Caminho, igual ao das picagens: tablet -> relay (Cloudflare) -> Edge Function pull-punches -> esta tabela;
-- e, de 6 em 6 horas, Edge Function publish-roster -> relay -> tablets que não têm a biometria desse trabalhador.
--
-- Um registo por trabalhador e motor/modelo (os vetores de um motor não servem noutro):
--   engine = 'faceres' (Human FaceRes) ou 'sface-fp32' (SFace); o tablet só recebe o do motor que usa.
--
-- Dados biométricos são de categoria especial (RGPD, art. 9.º): ver a avaliação de impacto antes de ligar em produção.
-- Só a Edge Function (service role) lê e escreve; nunca a API pública.
create table if not exists public.timetrack_biometrics (
  sage_id     text        not null,
  engine      text        not null check (engine ~ '^[a-z0-9-]{1,32}$'),
  blob        text        not null,                         -- JSON cifrado (AES-GCM) pelo tablet
  blob_hash   text        not null,                         -- sha256 do blob
  updated_at  timestamptz not null,                         -- quando o tablet fez o registo
  device_id   text        not null,                         -- tablet que o enviou (rasto)
  received_at timestamptz not null default now(),
  primary key (sage_id, engine)
);

alter table public.timetrack_biometrics enable row level security;
revoke all on public.timetrack_biometrics from public, anon, authenticated;
grant select, insert, update, delete on public.timetrack_biometrics to service_role;

-- Grava os registos que vieram do relay. Um registo mais antigo do que o que já cá está NÃO o substitui (um tablet que
-- esteve sem rede e volta com uma biometria antiga não desfaz uma atualização mais recente feita noutro tablet).
-- p_items: [{ "sage_id", "engine", "blob", "blob_hash", "updated_at_ms", "device_id" }, ...]
-- Devolve { stored, kept } (kept = já havia um mais recente).
create or replace function public.timetrack_store_biometrics(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_stored int := 0;
  v_kept int := 0;
  v_rows int;
begin
  for r in
    select i->>'sage_id' as sage_id, i->>'engine' as engine, i->>'blob' as blob, i->>'blob_hash' as blob_hash,
           to_timestamp(((i->>'updated_at_ms')::double precision) / 1000.0) as updated_at, i->>'device_id' as device_id
    from jsonb_array_elements(p_items) i
  loop
    insert into public.timetrack_biometrics as b (sage_id, engine, blob, blob_hash, updated_at, device_id, received_at)
    values (r.sage_id, r.engine, r.blob, r.blob_hash, r.updated_at, r.device_id, now())
    on conflict (sage_id, engine) do update
      set blob = excluded.blob, blob_hash = excluded.blob_hash, updated_at = excluded.updated_at,
          device_id = excluded.device_id, received_at = now()
      where b.updated_at <= excluded.updated_at;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_stored := v_stored + 1; else v_kept := v_kept + 1; end if;
  end loop;
  return jsonb_build_object('stored', v_stored, 'kept', v_kept);
end;
$$;

revoke all on function public.timetrack_store_biometrics(jsonb) from public, anon, authenticated;
grant execute on function public.timetrack_store_biometrics(jsonb) to service_role;
