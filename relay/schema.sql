-- Relay de picagens (Cloudflare D1). Só guarda picagens à espera de serem lidas pelo Supabase.

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,              -- ex.: dev-a1b2c3d4
  token_hash  TEXT NOT NULL,                 -- sha256 hex do token do tablet (o token em claro nunca é guardado)
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 = revogado
  obra        TEXT,                          -- obra do tablet: se definida, a lista de trabalhadores é só dessa obra
  last_seen   INTEGER,                       -- último contacto autenticado do tablet (segundos unix), para saber se está vivo
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

-- Pedidos do tablet para apagar picagens já enviadas. O Supabase lê-os, apaga-as e confirma (o relay apaga o pedido).
CREATE TABLE IF NOT EXISTS deletions (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,
  device_id   TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- Lista de trabalhadores por obra (enviada pelo Supabase, lida pelos tablets). Só SAGE ID e nome.
CREATE TABLE IF NOT EXISTS roster (
  sage_id TEXT NOT NULL,
  obra    TEXT NOT NULL,
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1,
  gen     INTEGER NOT NULL,                  -- instante do envio; os registos de envios antigos são apagados no fim
  PRIMARY KEY (sage_id, obra)
);
CREATE INDEX IF NOT EXISTS roster_obra_idx ON roster (obra);

-- Biometria (vetores faciais) CIFRADA pelos tablets com a chave da frota: o relay só vê blobs ilegíveis.
-- bio_outbox: o que os tablets enviaram e o Supabase ainda não leu (um registo por trabalhador e motor; o mais recente substitui).
CREATE TABLE IF NOT EXISTS bio_outbox (
  sage_id     TEXT NOT NULL,
  engine      TEXT NOT NULL,                 -- motor/modelo com que foi feita (os vetores de um motor não servem noutro)
  device_id   TEXT NOT NULL,
  blob        TEXT NOT NULL,                 -- JSON cifrado (AES-GCM) pelo tablet
  blob_hash   TEXT NOT NULL,                 -- sha256 do blob: o Supabase confirma com ele e só sai do relay o que foi lido
  updated_at  INTEGER NOT NULL,              -- quando o tablet fez o registo (ms)
  received_at INTEGER NOT NULL,
  PRIMARY KEY (sage_id, engine)
);

-- bio_store: a biometria que o Supabase publica (de 6 em 6 horas, com a lista) para os tablets que não a têm.
CREATE TABLE IF NOT EXISTS bio_store (
  sage_id    TEXT NOT NULL,
  engine     TEXT NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  gen        INTEGER NOT NULL,               -- instante do envio; os registos de envios antigos são apagados no fim
  PRIMARY KEY (sage_id, engine)
);

-- Apagar biometria (um tablet apaga um trabalhador: tem de desaparecer de todos os tablets e do Supabase).
-- Cada pedido é uma "lápide" CIFRADA pelo tablet com a chave da frota (o relay não a lê; os tablets só obedecem às que abrem).
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
