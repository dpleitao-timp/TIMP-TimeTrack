-- Biometria cifrada pelos tablets: tabelas novas no relay (bases novas ja as trazem em schema.sql).
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/005_biometrics.sql
CREATE TABLE IF NOT EXISTS bio_outbox (
  sage_id     TEXT NOT NULL,
  engine      TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  blob        TEXT NOT NULL,
  blob_hash   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (sage_id, engine)
);

CREATE TABLE IF NOT EXISTS bio_store (
  sage_id    TEXT NOT NULL,
  engine     TEXT NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  gen        INTEGER NOT NULL,
  PRIMARY KEY (sage_id, engine)
);
