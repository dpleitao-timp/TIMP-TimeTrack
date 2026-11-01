-- Chave por dispositivo (auditoria de segurança, fase 2 da A1): em vez de um token (um segredo que se copia e se usa de outro computador),
-- cada tablet gera uma chave que o navegador não deixa exportar e o relay guarda só a parte pública. Cada pedido do tablet vai assinado.
--   devices.pub_key       chave pública do tablet (ECDSA P-256, SPKI em base64url); NULL = ainda não ligado
--   devices.token_hash    passa a ser o hash do CÓDIGO DE INSTALAÇÃO (uso único): fica '' depois de o tablet se ligar
--   devices.code_expires  quando o código deixa de servir (segundos unix); NULL = não caduca (os tokens antigos, que migram sozinhos)
--   devices.enrolled_at   quando o tablet se ligou
--   device_nonces         identificadores de pedidos já vistos (impede repetir um pedido assinado durante a janela de 5 minutos)
-- Aplicar antes de publicar o relay (bases novas já trazem tudo em schema.sql):
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/008_device_keys.sql
ALTER TABLE devices ADD COLUMN pub_key TEXT;
ALTER TABLE devices ADD COLUMN enrolled_at INTEGER;
ALTER TABLE devices ADD COLUMN code_expires INTEGER;

CREATE TABLE IF NOT EXISTS device_nonces (
  device_id TEXT NOT NULL,
  nonce     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS device_nonces_ts_idx ON device_nonces (ts);
