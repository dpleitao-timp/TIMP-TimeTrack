-- Apagar picagens a pedido do tablet (o Administrador apaga uma picagem já enviada).
-- O tablet não fala com o Supabase: pede ao relay, e a Edge Function pull-punches lê o pedido e chama esta função.
--
-- Cada picagem apagada fica guardada em timetrack_deletions (linha completa em JSON), para haver rasto.
-- Uma picagem que o chefe de equipa já validou (status = 'validated') NÃO se apaga: fica como está e o pedido fica
-- registado como recusado.
create table if not exists public.timetrack_deletions (
  id          bigint generated always as identity primary key,
  event_id    text not null,
  device_id   text not null,
  outcome     text not null check (outcome in ('deleted', 'kept_validated', 'not_found')),
  row_data    jsonb,                                   -- a picagem tal como estava (se existia)
  requested_at timestamptz not null default now()
);

create index if not exists timetrack_deletions_event_idx on public.timetrack_deletions (event_id);

alter table public.timetrack_deletions enable row level security;
revoke all on public.timetrack_deletions from public, anon, authenticated;
grant select, insert on public.timetrack_deletions to service_role;

-- p_items: [{ "event_id": "...", "device_id": "..." }, ...]  (o device_id tem de ser o da picagem)
-- Devolve { deleted, kept_validated, not_found }.
create or replace function public.timetrack_apply_deletions(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_row public.timetrack%rowtype;
  v_deleted int := 0;
  v_kept int := 0;
  v_missing int := 0;
begin
  for r in select i->>'event_id' as event_id, i->>'device_id' as device_id from jsonb_array_elements(p_items) i loop
    select * into v_row from public.timetrack where event_id = r.event_id and device_id = r.device_id;
    if not found then
      insert into public.timetrack_deletions (event_id, device_id, outcome) values (r.event_id, r.device_id, 'not_found');
      v_missing := v_missing + 1;
    elsif v_row.status = 'validated' then
      insert into public.timetrack_deletions (event_id, device_id, outcome, row_data) values (r.event_id, r.device_id, 'kept_validated', to_jsonb(v_row));
      v_kept := v_kept + 1;
    else
      delete from public.timetrack where event_id = r.event_id;
      insert into public.timetrack_deletions (event_id, device_id, outcome, row_data) values (r.event_id, r.device_id, 'deleted', to_jsonb(v_row));
      v_deleted := v_deleted + 1;
    end if;
  end loop;
  return jsonb_build_object('deleted', v_deleted, 'kept_validated', v_kept, 'not_found', v_missing);
end;
$$;

revoke all on function public.timetrack_apply_deletions(jsonb) from public, anon, authenticated;
grant execute on function public.timetrack_apply_deletions(jsonb) to service_role;
