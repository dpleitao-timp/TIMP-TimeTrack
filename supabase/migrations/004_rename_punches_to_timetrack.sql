-- A tabela `punches` passa a chamar-se `timetrack`. A Edge Function pull-punches
-- passa a gravar em `timetrack` (redeploy: supabase functions deploy pull-punches
-- --no-verify-jwt). Idempotente: se a TIMP-Intranet ja aplicou o db/312 (que faz
-- o mesmo rename e recria as funcoes da intranet que usam a tabela), nao faz nada.
-- punch_devices fica com o nome que tem.
alter table if exists public.punches rename to timetrack;

alter index if exists public.punches_pkey rename to timetrack_pkey;
alter index if exists public.punches_punched_at_idx rename to timetrack_punched_at_idx;
alter index if exists public.punches_sage_idx rename to timetrack_sage_idx;
alter index if exists public.punches_obra_idx rename to timetrack_obra_idx;

do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'timetrack' and policyname = 'punches_select_authenticated') then
    alter policy punches_select_authenticated on public.timetrack rename to timetrack_select_authenticated;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'timetrack' and policyname = 'punches_validate_authenticated') then
    alter policy punches_validate_authenticated on public.timetrack rename to timetrack_validate_authenticated;
  end if;
end $$;
