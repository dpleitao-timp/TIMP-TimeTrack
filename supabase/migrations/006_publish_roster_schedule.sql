-- O Supabase publica a lista de trabalhadores no relay de 6 em 6 horas (00:00, 06:00, 12:00 e 18:00 UTC).
-- Antes de aplicar: publicar a função (supabase functions deploy publish-roster --no-verify-jwt) e criar no Vault o
-- endereço dela (o segredo punch_cron_secret é o mesmo que já existe):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/publish-roster', 'punch_roster_url');
select cron.schedule(
  'publish-roster',
  '0 */6 * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'punch_roster_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'punch_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
