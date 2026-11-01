// Regras do ecrã de leitura partilhadas por quem reconhece uma cara: picar (Kiosk) e entrar na administração (AdminLogin).
export const BAD_SHOW_MS = 1500 // "foto" / "não reconhecido" só aparecem se durarem isto sem interrupção

// Prova de vida: piscar ou virar a cabeça, sempre. O modelo anti-foto, por muito seguro que esteja, não a dispensa (o "modo rápido de vida", que o
// fazia, foi retirado: uma foto ou um vídeo que o modelo classificasse alto passava sem qualquer movimento). r vem do reconhecedor.
// Não há definição que a desligue (o interruptor "Deteção de vida" foi retirado): sem piscar nem mexer a cabeça não há picagem nem entrada na administração.
export const isAlive = (r) => r.blink || r.turn

// Tipos de picagem que este tablet admite, pela ordem dos botões: entrada, saída para almoço/jantar, entrada de almoço/jantar, saída.
// Depende do tipo de tablet (só de entradas, só de saídas) e de ter o almoço/jantar ligado.
export const allowedDirections = (s) =>
  [
    s.mode !== 'out' && 'in',
    s.mealPunches && s.mode !== 'in' && 'meal_out',
    s.mealPunches && s.mode !== 'out' && 'meal_in',
    s.mode !== 'in' && 'out',
  ].filter(Boolean)
