// Avaliação do reconhecimento com os rostos já registados no tablet (precisa de pelo menos 2 trabalhadores).
// Mede o que faltava: a semelhança entre PESSOAS DIFERENTES, que diz o risco de picar a pessoa errada, ao lado da semelhança
// da mesma pessoa. Imita a leitura: uma pessoa é comparada com o MELHOR dos vetores guardados de cada outra.
// sim(a, b): função de semelhança do motor em uso; threshold: o limiar em vigor.
export function evaluate(workers, sim, threshold) {
  const list = workers.filter((w) => !w.stale && !w.broken && w.embeddings?.length)
  const genuine = [] // cada vetor contra o melhor dos outros vetores da mesma pessoa
  const impostor = [] // cada vetor de A contra o melhor vetor de B
  const pair = new Map() // pior caso (a mais alta) por par de pessoas
  for (const a of list) {
    if (a.embeddings.length > 1) {
      a.embeddings.forEach((q, i) => genuine.push(Math.max(...a.embeddings.filter((_, j) => j !== i).map((e) => sim(q, e)))))
    }
    for (const b of list) {
      if (a === b) continue
      for (const q of a.embeddings) {
        const s = Math.max(...b.embeddings.map((e) => sim(q, e)))
        impostor.push(s)
        const key = [a.id, b.id].sort().join('|')
        pair.set(key, Math.max(pair.get(key) ?? -Infinity, s))
      }
    }
  }
  const mean = (v) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : null)
  const closest = [...pair.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([k, v]) => {
      const [x, y] = k.split('|').map((id) => list.find((w) => w.id === id))
      return { names: `${x.name} / ${y.name}`, sim: v }
    })
  const maxImpostor = impostor.length ? Math.max(...impostor) : null
  return {
    workers: list.length,
    enough: list.length >= 2,
    impostor: { n: impostor.length, mean: mean(impostor), max: maxImpostor },
    genuine: { n: genuine.length, mean: mean(genuine), min: genuine.length ? Math.min(...genuine) : null },
    far: impostor.length ? impostor.filter((s) => s >= threshold).length / impostor.length : null, // fração aceite ao limiar
    suggested: maxImpostor === null ? null : maxImpostor + 0.05,
    closest,
  }
}
