// Horário de funcionamento do tablet. Fora dele a câmara desliga-se e o ecrã fica preto (poupa bateria, calor e
// privacidade); um toque no ecrã ativa o tablet durante alguns minutos, por isso ninguém fica impedido de picar.
export const WAKE_MS = 5 * 60 * 1000 // quanto tempo fica ativo depois de um toque fora do horário

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

// Sábado ou domingo com "desligar" escolhido: o dia inteiro fica em repouso (pelo dia do calendário do aparelho).
export function weekendOff(settings, date = new Date()) {
  if (!settings?.scheduleOn) return false
  const day = date.getDay() // 0 = domingo, 6 = sábado
  return (day === 6 && !!settings.scheduleOffSat) || (day === 0 && !!settings.scheduleOffSun)
}

// Está dentro do horário? Sem horário ligado, ou com horas inválidas ou iguais, está sempre (salvo fim de semana desligado).
// Aceita horários que passam da meia-noite (das 22:00 às 06:00).
export function inHours(settings, date = new Date()) {
  if (!settings?.scheduleOn) return true
  if (weekendOff(settings, date)) return false
  const from = toMin(settings.scheduleFrom)
  const to = toMin(settings.scheduleTo)
  if (from === null || to === null || from === to) return true
  const now = date.getHours() * 60 + date.getMinutes()
  return from < to ? now >= from && now < to : now >= from || now < to
}
