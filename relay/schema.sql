-- Relay de picagens (Cloudflare D1). Só guarda picagens à espera de serem lidas pelo Supabase.

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,              -- ex.: dev-a1b2c3d4
  token_hash  TEXT NOT NULL,                 -- sha256 hex do token do tablet (o token em claro nunca é guardado)
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 = revogado
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,          -- dispositivo + contador => idempotência
  device_id   TEXT NOT NULL,
  payload     TEXT NOT NULL,                 -- JSON: eventId, sageId, direction, punchedAt, confidence
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS outbox_device_idx ON outbox (device_id);
