import { useEffect, useRef, useState } from 'react'
import { useCamera } from '../lib/useCamera.js'
import { checkIr } from '../lib/ir.js'
import { useT } from '../lib/i18n.jsx'

// Pré-visualização da câmara de infravermelhos com os valores em direto, para calibrar os limiares:
// ponha o rosto à frente, depois uma fotografia e um ecrã de telemóvel, e compare os valores.
export default function IrTest({ settings }) {
  const { t } = useT()
  const ref = useRef(null)
  const { ready, error } = useCamera(ref, { deviceId: settings.irCameraId, enabled: !!settings.irCameraId })
  const [r, setR] = useState(null)

  useEffect(() => {
    if (!ready) return
    let stop = false
    ;(async () => {
      while (!stop) {
        try {
          setR(await checkIr(ref.current, null, null, settings))
        } catch (e) {
          setR({ error: String(e?.message || e) })
        }
        await new Promise((res) => setTimeout(res, 400))
      }
    })()
    return () => {
      stop = true
    }
  }, [ready, settings.irMinScore, settings.irMinStd])

  if (!settings.irCameraId) return null
  return (
    <div className="ir-test">
      <video ref={ref} muted playsInline />
      <pre>
        {error ||
          (!r
            ? t('settings.irTestWaiting')
            : r.error ||
              [
                `${t('settings.irTestFace')}: ${r.found ? `${(r.score * 100).toFixed(0)}%` : t('settings.irTestNone')}`,
                `${t('settings.irTestTexture')}: ${r.found ? r.std.toFixed(0) : '-'}  (min ${settings.irMinStd})`,
                `${t('settings.irTestBrightness')}: ${r.found ? r.mean.toFixed(0) : '-'}`,
                r.ok ? `✔ ${t('settings.irTestReal')}` : `✖ ${t('settings.irTestFake')}`,
              ].join('\n'))}
      </pre>
    </div>
  )
}
