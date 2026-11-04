-- Relógios que servem várias obras (por exemplo, o da sede, usado por trabalhadores que andam por obras diferentes).
-- O dispositivo continua com a sua obra FIXA (`devices.obra`, a obra por defeito); aqui ficam as obras EXTRA em que também pode picar.
-- Quem decide é só o relay (como a obra fixa): o tablet nunca escolhe nem alarga a lista. Um dispositivo sem linhas aqui funciona
-- exatamente como antes (uma só obra).
--   - /punch aceita picagens na obra fixa ou numa destas, e grava a obra tal como está aqui;
--   - /roster devolve os trabalhadores ativos de todas essas obras, cada um com as obras em que está autorizado hoje.
-- Aplicar antes de publicar o relay (bases novas já a trazem em schema.sql):
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/010_device_obras.sql
-- Dar obras extra a um relógio:
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "INSERT INTO device_obras (device_id, obra) VALUES ('dev-sede', 'OBRA-A')"
-- Todas as obras da lista de trabalhadores (também as que vierem a existir, sem voltar a mexer aqui): uma linha com `*`
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "INSERT INTO device_obras (device_id, obra) VALUES ('dev-sede', '*')"
-- Tirar:
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "DELETE FROM device_obras WHERE device_id = 'dev-sede' AND obra = 'OBRA-A'"
CREATE TABLE IF NOT EXISTS device_obras (
  device_id TEXT NOT NULL,
  obra      TEXT NOT NULL,                   -- como está na intranet (compara-se sem maiúsculas nem espaços nas pontas)
  PRIMARY KEY (device_id, obra)
);
