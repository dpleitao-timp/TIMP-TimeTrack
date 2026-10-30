-- Para uma base de dados já existente. Correr uma só vez:
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/003_deletions.sql
CREATE TABLE IF NOT EXISTS deletions (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,
  device_id   TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
