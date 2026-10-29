// Gera um token para um tablet e imprime o SQL para o registar no relay.
//   node relay/scripts/add-device.mjs dev-entrada [obra]
// Com obra, o tablet só recebe a lista de trabalhadores dessa obra (recomendado).
// O token em claro só aparece aqui; no relay fica apenas o hash.
// Se o dispositivo já existir, o comando impresso troca o token (e reativa-o).
import { randomBytes, createHash } from 'node:crypto'

const id = process.argv[2]
const obra = (process.argv[3] || '').replace(/'/g, "''")
if (!id || !/^[A-Za-z0-9_-]{3,40}$/.test(id)) {
  console.error('Uso: node relay/scripts/add-device.mjs <id-do-dispositivo>   (letras, números, - e _)')
  process.exit(1)
}
const token = randomBytes(32).toString('base64url')
const hash = createHash('sha256').update(token).digest('hex')

console.log(`ID do dispositivo : ${id}`)
console.log(`Token (copiar para Definições do tablet, não se repete): ${token}\n`)
console.log('Executar no relay:')
console.log(`npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "INSERT INTO devices (id, token_hash, obra) VALUES ('${id}', '${hash}', ${obra ? `'${obra}'` : 'NULL'}) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, active = 1, obra = excluded.obra"\n`)
console.log('Revogar:')
console.log(`npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "UPDATE devices SET active = 0 WHERE id = '${id}'"`)
