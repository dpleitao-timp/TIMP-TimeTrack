-- Apagar biometria: um tablet apaga um trabalhador e isso apaga-o aqui e em todos os tablets.
-- O tablet envia uma "lápide" CIFRADA com a chave da frota (o Supabase não a lê). Esta tabela guarda-as: servem para
--   1) apagar a biometria que está em timetrack_biometrics (a função abaixo, chamada pela Edge Function pull-punches), e
--   2) a publish-roster as publicar de 6 em 6 horas para os tablets que ainda têm o trabalhador (só obedecem às que abrem).
-- Uma lápide só apaga o que foi registado ANTES de ela existir: quem refaz a biometria depois do apagar não é afetado.
-- Depende da migração 009. Só a Edge Function (service role) lê e escreve.
create table if not exists public.timetrack_biometric_deletions (
  sage_id     text        primary key,
  blob        text        not null,                         -- lápide cifrada pelo tablet
  blob_hash   text        not null,
  deleted_at  timestamptz not null,                         -- quando o tablet apagou
  device_id   text        not null,
  received_at timestamptz not null default now()
);

alter table public.timetrack_biometric_deletions enable row level security;
revoke all on public.timetrack_biometric_deletions from public, anon, authenticated;
grant select, insert, update, delete on public.timetrack_biometric_deletions to service_role;

-- p_items: [{ "sage_id", "blob", "blob_hash", "deleted_at_ms", "device_id" }, ...]
-- Apaga a biometria registada até ao momento do apagar e guarda a lápide (a mais recente de cada trabalhador).
-- Devolve { deleted, tombstones }.
create or replace function public.timetrack_delete_biometrics(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_deleted int := 0;
  v_tombs int := 0;
  v_rows int;
begin
  for r in
    select i->>'sage_id' as sage_id, i->>'blob' as blob, i->>'blob_hash' as blob_hash,
           to_timestamp(((i->>'deleted_at_ms')::double precision) / 1000.0) as deleted_at, i->>'device_id' as device_id
    from jsonb_array_elements(p_items) i
  loop
    delete from public.timetrack_biometrics where sage_id = r.sage_id and updated_at <= r.deleted_at;
    get diagnostics v_rows = row_count;
    v_deleted := v_deleted + v_rows;

    insert into public.timetrack_biometric_deletions as d (sage_id, blob, blob_hash, deleted_at, device_id, received_at)
    values (r.sage_id, r.blob, r.blob_hash, r.deleted_at, r.device_id, now())
    on conflict (sage_id) do update
      set blob = excluded.blob, blob_hash = excluded.blob_hash, deleted_at = excluded.deleted_at,
          device_id = excluded.device_id, received_at = now()
      where d.deleted_at <= excluded.deleted_at;
    get diagnostics v_rows = row_count;
    v_tombs := v_tombs + v_rows;
  end loop;
  -- lápides com mais de 400 dias já não interessam (os tablets só as pedem até 365)
  delete from public.timetrack_biometric_deletions where deleted_at < now() - interval '400 days';
  return jsonb_build_object('deleted', v_deleted, 'tombstones', v_tombs);
end;
$$;

revoke all on function public.timetrack_delete_biometrics(jsonb) from public, anon, authenticated;
grant execute on function public.timetrack_delete_biometrics(jsonb) to service_role;

-- A gravação da biometria (migração 009) passa a recusar a que é anterior ou igual ao momento em que o trabalhador foi apagado:
-- um tablet que esteve sem rede e volta com uma biometria antiga não ressuscita quem foi apagado.
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
    if exists (select 1 from public.timetrack_biometric_deletions d where d.sage_id = r.sage_id and d.deleted_at >= r.updated_at) then
      v_kept := v_kept + 1;
      continue;
    end if;
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
