// Regras do ecrã de leitura partilhadas por quem reconhece uma cara: picar (Kiosk) e entrar na administração (AdminLogin).
export const FAST_REAL = 0.8 // confiança mínima do anti-foto para dispensar o piscar no modo rápido
export const BAD_SHOW_MS = 1500 // "foto" / "não reconhecido" só aparecem se durarem isto sem interrupção

// Prova de vida: piscar ou virar a cabeça (ou, no modo rápido, o modelo já ter a certeza). r vem do reconhecedor.
export const isAlive = (s, r) => !s.liveness || r.blink || r.turn || (s.fastLiveness && r.real >= FAST_REAL && r.live >= FAST_REAL)
