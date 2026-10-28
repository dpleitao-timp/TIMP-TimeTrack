// Última picagem por trabalhador (SAGE ID -> instante), para o intervalo mínimo entre picagens.
// Vive fora do ecrã de picar para sobreviver entre leituras e poder ser limpo ao apagar uma picagem.
export const lastPunch = new Map()
