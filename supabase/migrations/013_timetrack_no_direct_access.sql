-- M1 da auditoria de segurança: a tabela `timetrack` deixa de ter acesso direto para utilizadores autenticados.
--
-- Antes (migração 001): qualquer utilizador autenticado (qualquer pessoa com sessão na intranet) lia TODAS as picagens e podia alterar
-- TODAS as colunas (hora, SAGE ID, direção, obra), não só o estado. Era uma policy provisória ("TODO: restringir por obra/equipa").
--
-- Verificado nos repositórios TIMP-Intranet e timesheets-mobile-app: nenhum lê nem escreve na `timetrack` diretamente. A intranet usa só
-- funções `security definer` (timesheets_punches_for_day, timesheets_punch_summary, timesheets_delete_punch, timesheets_set_punch_direction,
-- validar/rejeitar da db/307, time_attendance_device_activity e time_attendance_unmatched_obras), que verificam a autenticação forte e a
-- permissão de cada pessoa (e registam auditoria), e correm com os direitos do dono da tabela, por isso continuam a funcionar sem estas policies.
-- A própria db/307 da intranet já dizia que "a policy punches_validate_authenticated deixa qualquer utilizador autenticado alterar o estado".
--
-- Depois: sem policies e sem privilégios para anon/authenticated. Só a Edge Function pull-punches (service role) e as funções acima mexem na tabela.
--
-- Para desfazer (não recomendado):
--   create policy timetrack_select_authenticated on public.timetrack for select to authenticated using (true);
--   create policy timetrack_validate_authenticated on public.timetrack for update to authenticated using (true) with check (status in ('pending','validated','rejected'));
--   grant select, update on public.timetrack to authenticated;
--
-- Depois de aplicar, confirmar na intranet (Timesheets: modal "Punches"/Time Tracker, e a página Time Clocks) que continua tudo a abrir.
drop policy if exists timetrack_select_authenticated on public.timetrack;
drop policy if exists timetrack_validate_authenticated on public.timetrack;
-- nomes antigos, caso o rename da migração 004 nunca tenha corrido nesta base
drop policy if exists punches_select_authenticated on public.timetrack;
drop policy if exists punches_validate_authenticated on public.timetrack;

revoke all on public.timetrack from public, anon, authenticated;
grant select, insert, update, delete on public.timetrack to service_role;
