import { useEffect, useState } from 'react'

export function useCamera(videoRef) {
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stream
    let cancelled = false
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        const v = videoRef.current
        v.srcObject = stream
        await v.play()
        setReady(true)
      } catch (e) {
        setError(e?.message || 'Sem acesso à câmara')
      }
    })()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [videoRef])

  return { ready, error }
}
