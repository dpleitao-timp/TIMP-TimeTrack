-- Relay de picagens (Cloudflare D1). Só guarda picagens à espera de serem lidas pelo Supabase.

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,              -- ex.: dev-a1b2c3d4
  token_hash  TEXT NOT NULL,                 -- sha256 hex do CÓDIGO DE INSTALAÇÃO (uso único; fica '' depois de o tablet se ligar). Em claro nunca é guardado
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 = revogado
  obra        TEXT,                          -- obra do tablet: se definida, a lista de trabalhadores é só dessa obra
  last_seen   INTEGER,                       -- último contacto autenticado do tablet (segundos unix), para saber se está vivo
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  pub_key     TEXT,                          -- chave pública do tablet (ECDSA P-256, SPKI base64url); NULL = ainda não ligado
  enrolled_at INTEGER,                       -- quando o tablet se ligou
  code_expires INTEGER                       -- quando o código de instalação (token_hash) caduca; NULL = não caduca
);

-- Obras EXTRA em que um dispositivo também pode picar (além da sua `devices.obra`, a obra por defeito). Só o relay as define. Ver
-- relay/migrations/010_device_obras.sql.
CREATE TABLE IF NOT EXISTS device_obras (
  device_id TEXT NOT NULL,
  obra      TEXT NOT NULL,
  PRIMARY KEY (device_id, obra)
);

-- Identificadores de pedidos já vistos: um pedido assinado não se pode repetir na janela de 5 minutos.
CREATE TABLE IF NOT EXISTS device_nonces (
  device_id TEXT NOT NULL,
  nonce     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS device_nonces_ts_idx ON device_nonces (ts);

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
