-- Lista de trabalhadores por obra que o Supabase publica no relay para os tablets (Registar).
-- Não é uma tabela nova: é uma VIEW sobre as tabelas que a intranet já tem.
--   sage_id = workers.sage_id        (SAGE ID do trabalhador, 5 caracteres alfanuméricos)
--             workers_others.punch_code (outsourced: código de ponto de 6 caracteres, E00001...; db/313 da intranet)
--   name    = full_name
--   obra    = work_sites.name         (o mesmo código de obra que se escreve no tablet)
--   active  = trabalhador ativo, obra ativa e atribuição em vigor hoje (start_date/end_date da atribuição, no fuso
--             horário do país da obra, como o resto da intranet; Europe/Lisbon se a obra não tiver país)
--
-- ORDEM: aplicar primeiro o db/313 da intranet (cria workers_others.punch_code); só depois esta migração.
-- Os códigos de 5 e de 6 caracteres nunca colidem, por isso sage_id identifica sem ambiguidade.
create or replace view public.timetrack_roster
with (security_invoker = true) as
select sage_id, name, obra, bool_or(active) as active
from (
  -- trabalhadores TIMP
  select
    w.sage_id::text as sage_id,
    w.full_name     as name,
    ws.name         as obra,
    (
      w.active
      and ws.active
      and (wws.start_date is null or wws.start_date <= (now() at time zone coalesce(c.timezone, 'Europe/Lisbon'))::date)
      and (wws.end_date   is null or wws.end_date   >= (now() at time zone coalesce(c.timezone, 'Europe/Lisbon'))::date)
    ) as active
  from public.worker_work_sites wws
  join public.workers    w  on w.id  = wws.worker_id
  join public.work_sites ws on ws.id = wws.work_site_id
  left join public.countries c on c.id = ws.country_id
  where w.sage_id is not null

  union all

  -- trabalhadores outsourced
  select
    o.punch_code::text as sage_id,
    o.full_name        as name,
    ws.name            as obra,
    (
      o.active
      and ws.active
      and (ows.start_date is null or ows.start_date <= (now() at time zone coalesce(c.timezone, 'Europe/Lisbon'))::date)
      and (ows.end_date   is null or ows.end_date   >= (now() at time zone coalesce(c.timezone, 'Europe/Lisbon'))::date)
    ) as active
  from public.worker_others_work_sites ows
  join public.workers_others o  on o.id  = ows.worker_id
  join public.work_sites     ws on ws.id = ows.work_site_id
  left join public.countries c  on c.id  = ws.country_id
  where o.punch_code is not null
) r
group by sage_id, name, obra;

-- Nomes e códigos são dados pessoais: só a Edge Function (service role) pode ler esta vista,
-- nunca a API pública. (security_invoker faz valer o RLS das tabelas de origem para quem não seja service role.)
revoke all on public.timetrack_roster from public, anon, authenticated;
grant select on public.timetrack_roster to service_role;
