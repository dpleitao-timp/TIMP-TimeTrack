// Datas sempre em dd/mm/yyyy (independente do idioma ou do navegador).
const pad = (n) => String(n).padStart(2, '0')

// '2026-10-27' -> '27/10/2026'
export function isoToDMY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

// '27/10/2026' -> '2026-10-27' (null se não for uma data válida)
export function dmyToIso(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text || '')
  if (!m) return null
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

// Vai pondo as barras enquanto se escreve: '27102026' -> '27/10/2026'
export function maskDMY(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

// Instante completo: dd/mm/yyyy hh:mm:ss (24 h, hora local)
export function fmtDateTime(value) {
  const d = new Date(value)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Data local do instante, como yyyy-mm-dd (toISOString daria a data em UTC)
export const localIso = (value = new Date()) => {
  const d = new Date(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
