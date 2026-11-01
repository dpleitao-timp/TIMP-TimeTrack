-- A biometria deixou de sair dos tablets (a partilha entre tablets foi retirada: vetores faciais só no tablet que os registou).
-- Apaga as tabelas que a transportavam, e com elas os blobs cifrados que lá estejam, e a tabela das lápides/âmbito (roster_seen).
-- É irreversível: o que estava nestas tabelas perde-se (eram só cópias; os vetores continuam nos tablets que os registaram).
-- Aplicar depois de publicar o relay novo (o relay antigo ainda as usa):
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/009_drop_biometrics.sql
DROP TABLE IF EXISTS bio_outbox;
DROP TABLE IF EXISTS bio_store;
DROP TABLE IF EXISTS bio_del_outbox;
DROP TABLE IF EXISTS bio_tombstones;
DROP TABLE IF EXISTS roster_seen;
