import { useEffect, useState } from 'react'
import { initHuman } from './face.js'

// 'loading' | 'ready' | 'error'. initHuman devolve sempre a mesma promessa, por isso chamar aqui não recarrega nada.
export function useModelsReady() {
  const [state, setState] = useState('loading')
  useEffect(() => {
    let on = true
    initHuman()
      .then(() => on && setState('ready'))
      .catch(() => on && setState('error'))
    return () => {
      on = false
    }
  }, [])
  return state
}
