import { useEffect, useState } from 'react'

// Câmara sempre ligada: uma única câmara é aberta quando a app arranca e fica aberta, partilhada pelos
// ecrãs (Picar, Administração, Registar). Só é analisada depois de escolher Entrada/Saída; entretanto
// não se mostra nem se processa nenhuma imagem. Assim, escolher Entrada/Saída já a encontra pronta.
let shared = { stream: null, deviceId: '', promise: null }

const SIZE = { width: { ideal: 1280 }, height: { ideal: 720 } }

async function open(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, ...SIZE } : { facingMode: 'user', ...SIZE },
      audio: false,
    })
  } catch (e) {
    // a câmara escolhida já não existe: volta à frontal
    if (!deviceId || e?.name !== 'OverconstrainedError') throw e
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', ...SIZE }, audio: false })
  }
}

const isLive = (stream) => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live')

export function releaseCamera() {
  shared.stream?.getTracks().forEach((t) => t.stop())
  shared = { stream: null, deviceId: '', promise: null }
}

// Devolve a câmara aberta (abre-a se ainda não estiver, ou se a anterior parou ou mudou de dispositivo).
export function acquireCamera(deviceId = '') {
  if (shared.deviceId === deviceId && isLive(shared.stream)) return Promise.resolve(shared.stream)
  if (shared.deviceId === deviceId && shared.promise) return shared.promise
  releaseCamera()
  shared.deviceId = deviceId
  const promise = open(deviceId).then(
    (stream) => {
      if (shared.promise !== promise) {
        stream.getTracks().forEach((t) => t.stop()) // entretanto pediu-se outra câmara
        throw new Error('camera-changed')
      }
      shared.stream = stream
      // se a câmara parar (cabo, suspensão do aparelho), a próxima utilização volta a abri-la
      stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => shared.stream === stream && (shared = { stream: null, deviceId: '', promise: null })))
      return stream
    },
    (e) => {
      if (shared.promise === promise) shared = { stream: null, deviceId: '', promise: null }
      throw e
    },
  )
  shared.promise = promise
  return promise
}

// Arranque antecipado (sem esperar pelo ecrã de picar).
export const warmCamera = (deviceId = '') => acquireCamera(deviceId).catch(() => {})

// Liga a câmara partilhada a um <video>. Sair do ecrã NÃO a desliga.
export function useCamera(videoRef, { deviceId = '' } = {}) {
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setError('')
    ;(async () => {
      try {
        const stream = await acquireCamera(deviceId)
        if (cancelled) return
        const v = videoRef.current
        v.srcObject = stream
        await v.play()
        if (!cancelled) setReady(true)
      } catch (e) {
        if (!cancelled && e?.message !== 'camera-changed') setError(e?.message || 'Sem acesso à câmara')
      }
    })()
    return () => {
      cancelled = true
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [videoRef, deviceId])

  return { ready, error }
}
