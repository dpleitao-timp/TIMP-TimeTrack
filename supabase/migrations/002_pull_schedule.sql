-- O Supabase vai buscar as picagens ao relay a cada minuto.
-- Antes de aplicar, criar dois segredos no Vault (SQL editor):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/pull-punches', 'punch_pull_url');
--   select vault.create_secret('<mesmo valor de CRON_SECRET da função>',                 'punch_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'pull-punches',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'punch_pull_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'punch_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
