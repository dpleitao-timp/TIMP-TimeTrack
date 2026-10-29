-- Para uma base de dados já existente (a 001 é o schema.sql original). Correr uma só vez:
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/002_roster.sql
ALTER TABLE devices ADD COLUMN obra TEXT;

CREATE TABLE IF NOT EXISTS roster (
  sage_id TEXT NOT NULL,
  obra    TEXT NOT NULL,
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1,
  gen     INTEGER NOT NULL,
  PRIMARY KEY (sage_id, obra)
);
CREATE INDEX IF NOT EXISTS roster_obra_idx ON roster (obra);
