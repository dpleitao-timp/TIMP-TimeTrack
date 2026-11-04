// Cria (ou volta a ligar) um tablet no relay: gera um CÓDIGO DE INSTALAÇÃO de uso único e imprime o SQL para o registar.
//   node relay/scripts/add-device.mjs dev-entrada <obra> [obra-extra ...]
// A obra é obrigatória e fica fixa no relay: o tablet só pica nessa obra e só recebe a lista, a biometria e as lápides dessa obra.
// O código escreve-se uma vez em Definições do tablet (campo "Código de instalação"). O tablet gera então uma chave própria, que não
// sai dele, e o relay passa a conhecer só a parte pública: o código deixa de servir e não há nenhum segredo guardado no tablet que se
// copie para outro computador. O código caduca em 7 dias. No relay fica apenas o hash.
// Se o dispositivo já existir, o código novo permite ligá-lo de novo (por exemplo, tablet substituído ou chave perdida); o tablet atual
// continua a funcionar com a chave que tem até se ligar com o código novo.
import { randomBytes, createHash } from 'node:crypto'

const id = process.argv[2]
const obra = (process.argv[3] || '').trim().replace(/'/g, "''")
// Obras extra (opcional, a partir do 4.º argumento): o relógio passa a poder picar também nelas (ver relay/migrations/010_device_obras.sql)
const extras = process.argv.slice(4).map((o) => o.trim().replace(/'/g, "''")).filter(Boolean)
if (!id || !/^[A-Za-z0-9_-]{3,40}$/.test(id) || !obra || [obra, ...extras].some((o) => o.length > 64 || /["\\]/.test(o))) {
  console.error('Uso: node relay/scripts/add-device.mjs <id-do-dispositivo> <obra> [obra-extra ...]   (id com letras, números, - e _; a obra é obrigatória; as extra são para relógios que servem várias obras)')
  process.exit(1)
}

// 16 caracteres de um alfabeto sem 0/O/1/I (80 bits), em grupos de 4: fácil de escrever num tablet. 256 é múltiplo de 32: sem enviesamento.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const raw = [...randomBytes(16)].map((b) => ALPHABET[b % 32]).join('')
const code = raw.match(/.{4}/g).join('-')
const hash = createHash('sha256').update(raw).digest('hex') // o relay aceita o código com ou sem hífenes e em maiúsculas

console.log(`ID do dispositivo : ${id}`)
console.log(`Código de instalação (escrever em Definições do tablet; uso único, caduca em 7 dias): ${code}\n`)
console.log('Executar no relay:')
console.log(`npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "INSERT INTO devices (id, token_hash, obra, code_expires) VALUES ('${id}', '${hash}', '${obra}', unixepoch() + 604800) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, active = 1, obra = excluded.obra, code_expires = excluded.code_expires"\n`)
if (extras.length) {
  console.log('Obras extra deste relógio (substitui as que tinha; a obra acima fica como obra por defeito):')
  console.log(`npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "DELETE FROM device_obras WHERE device_id = '${id}'"`)
  console.log(`npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "INSERT INTO device_obras (device_id, obra) VALUES ${extras.map((o) => `('${id}', '${o}')`).join(', ')}"\n`)
}
console.log('Revogar (o tablet deixa de poder falar com o relay):')
console.log(`npx wrangler d1 execute timp-punch-relay --remote --config relay/wrangler.jsonc --command "UPDATE devices SET active = 0, pub_key = NULL, token_hash = '' WHERE id = '${id}'"`)
