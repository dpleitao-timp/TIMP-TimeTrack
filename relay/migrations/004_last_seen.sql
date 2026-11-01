-- Hora do ultimo contacto de cada tablet com o relay (segundos unix). Atualiza-se em
-- cada pedido autenticado do tablet (picagem, lista de trabalhadores, pedido de apagar),
-- e a intranet le-a por GET /devices-status (assinado) para mostrar se o relogio esta vivo.
-- Bases novas ja a trazem em schema.sql.
--   npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --file=relay/migrations/004_last_seen.sql
ALTER TABLE devices ADD COLUMN last_seen INTEGER;
