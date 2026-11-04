-- Configuração do relógio definida na intranet (página Time Clocks): a função do tablet e o almoço/jantar passam a vir do relay, como a obra.
-- NULL = a intranet nunca definiu: o tablet fica com o que tem nas Definições. Quando a intranet define (POST /devices-config), o tablet lê estes
-- valores com a lista de trabalhadores (de 5 em 5 minutos) e as opções passam a ser só de leitura no tablet.
-- Aplicar ANTES de publicar o relay novo, uma instrução de cada vez com --command (o --file falhou com "Authentication error 10000" nesta conta, em 2026-11-04):
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "ALTER TABLE devices ADD COLUMN mode TEXT"
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "ALTER TABLE devices ADD COLUMN meal_punches INTEGER"
-- (Bases novas já as trazem em schema.sql.)
ALTER TABLE devices ADD COLUMN mode TEXT;          -- 'both' | 'in' | 'out'
ALTER TABLE devices ADD COLUMN meal_punches INTEGER; -- 1 = com saída e entrada de almoço/jantar, 0 = sem
