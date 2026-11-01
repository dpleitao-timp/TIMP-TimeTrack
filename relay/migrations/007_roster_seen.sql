-- Quem já esteve na lista de cada obra (A1 da auditoria de segurança): um tablet só pode enviar biometria e pedir para apagar
-- biometria de trabalhadores da SUA obra. A lista atual (`roster`) só tem quem está ativo hoje; quem saiu da obra já não consta
-- dela, mas apagar a biometria de quem saiu é justamente o caso mais comum. Por isso o relay guarda aqui, durante 400 dias, quem
-- esteve na lista de cada obra (atualiza-se a cada publicação da lista, de 6 em 6 horas).
-- Aplicar antes de publicar o relay (bases novas já a trazem em schema.sql):
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/007_roster_seen.sql
CREATE TABLE IF NOT EXISTS roster_seen (
  sage_id TEXT NOT NULL,
  obra    TEXT NOT NULL,                     -- em minúsculas e sem espaços nas pontas (como se compara)
  seen_at INTEGER NOT NULL,                  -- última vez que constou da lista (segundos unix)
  PRIMARY KEY (sage_id, obra)
);

-- quem consta da lista neste momento já "esteve" nela
INSERT OR IGNORE INTO roster_seen (sage_id, obra, seen_at) SELECT sage_id, lower(trim(obra)), unixepoch() FROM roster;
