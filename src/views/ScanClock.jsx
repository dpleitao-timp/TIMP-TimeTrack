import { useEffect, useRef, useState } from 'react'
import { getClockOffset } from '../lib/db.js'
import { fmtDateTime } from '../lib/date.js'

// Data e hora (ecrã de leitura e ecrã de repouso: canto inferior esquerdo; ecrã inicial: também canto inferior esquerdo, ver className). Usa a hora corrigida pelo servidor (a mesma que
// se grava na picagem). É um span para poder ficar dentro do botão do ecrã de repouso.
export default function ScanClock({ className = '' }) {
  const [now, setNow] = useState(() => Date.now())
  const offset = useRef(0)
  useEffect(() => {
    let alive = true
    getClockOffset().then((o) => {
      if (alive) offset.current = o
    })
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return <span className={`scan-clock ${className}`}>{fmtDateTime(now)}</span>
}
