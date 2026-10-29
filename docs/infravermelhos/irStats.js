// Estatísticas de uma imagem de infravermelhos (puro, sem dependências: fácil de testar).
// Um rosto real iluminado em infravermelho tem textura (desvio-padrão da luminância alto) e brilho
// intermédio. Um ecrã de telemóvel aparece escuro/uniforme; uma imagem saturada ou vazia também falha.
export function lumaStats(rgba) {
  const n = rgba.length / 4
  if (!n) return { mean: 0, std: 0 }
  let sum = 0
  let sum2 = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    sum += l
    sum2 += l * l
  }
  const mean = sum / n
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) }
}

// Decide se o que a câmara de infravermelhos vê parece um rosto real.
//  found  - o detetor encontrou um rosto na imagem IR
//  score  - confiança dessa deteção (0..1)
//  mean/std - estatísticas do recorte do rosto
//  align  - distância (0..~1) entre os centros do rosto IR e do rosto da câmara normal
export function irVerdict({ found, score, mean, std, align }, cfg) {
  if (!found) return false
  return score >= cfg.irMinScore && std >= cfg.irMinStd && mean > 20 && mean < 245 && (align ?? 0) <= 0.45
}
