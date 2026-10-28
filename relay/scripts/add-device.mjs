// Gera um token para um tablet e imprime o SQL para o registar no relay.
//   node relay/scripts/add-device.mjs dev-entrada
// O token em claro só aparece aqui; no relay fica apenas o hash.
import { randomBytes, createHash } from 'node:crypto'

const id = process.argv[2]
if (!id || !/^[A-Za-z0-9_-]{3,40}$/.test(id)) {
  console.error('Uso: node relay/scripts/add-device.mjs <id-do-dispositivo>   (letras, números, - e _)')
  process.exit(1)
}
const token = randomBytes(32).toString('base64url')
const hash = createHash('sha256').update(token).digest('hex')

console.log(`ID do dispositivo : ${id}`)
console.log(`Token (copiar para Definições do tablet, não se repete): ${token}\n`)
console.log('Executar no relay:')
console.log(`npx wrangler d1 execute timp-punch-relay --remote --command "INSERT INTO devices (id, token_hash) VALUES ('${id}', '${hash}')"\n`)
console.log('Revogar:')
console.log(`npx wrangler d1 execute timp-punch-relay --remote --command "UPDATE devices SET active = 0 WHERE id = '${id}'"`)
