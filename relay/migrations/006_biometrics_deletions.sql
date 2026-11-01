-- Apagar biometria em todos os tablets e no Supabase: tabelas novas no relay (bases novas ja as trazem em schema.sql).
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/006_biometrics_deletions.sql
-- bio_del_outbox: pedidos dos tablets que o Supabase ainda não leu (confirma com o hash do blob).
CREATE TABLE IF NOT EXISTS bio_del_outbox (
  sage_id     TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  blob        TEXT NOT NULL,                 -- lápide cifrada
  blob_hash   TEXT NOT NULL,
  deleted_at  INTEGER NOT NULL,              -- quando o tablet apagou (ms)
  received_at INTEGER NOT NULL
);

-- bio_tombstones: as lápides que os tablets vão buscar. Entram logo que o tablet avisa (gen = 0) e o Supabase volta a
-- publicá-las de 6 em 6 horas (gen = instante do envio; as de envios antigos saem no fim, as de gen 0 ficam).
CREATE TABLE IF NOT EXISTS bio_tombstones (
  sage_id     TEXT PRIMARY KEY,
  blob        TEXT NOT NULL,
  deleted_at  INTEGER NOT NULL,
  gen         INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
