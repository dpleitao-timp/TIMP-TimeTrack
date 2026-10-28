import { useEffect, useRef, useState } from 'react'
import { isoToDMY, dmyToIso, maskDMY } from '../lib/date.js'

// Campo de data sempre em dd/mm/yyyy. O <input type="date"> nativo segue o idioma do
// navegador (p. ex. mm/dd/yyyy), por isso só é usado como calendário escondido.
export default function DateField({ value, onChange, label }) {
  const [text, setText] = useState(isoToDMY(value))
  const picker = useRef(null)

  useEffect(() => {
    setText(isoToDMY(value))
  }, [value])

  const type = (e) => {
    const masked = maskDMY(e.target.value)
    setText(masked)
    const iso = dmyToIso(masked)
    if (iso) onChange(iso)
  }

  const openPicker = () => {
    const el = picker.current
    if (!el) return
    if (el.showPicker) el.showPicker()
    else el.click()
  }

  return (
    <div className="date-field">
      <input
        type="text"
        inputMode="numeric"
        placeholder="dd/mm/yyyy"
        maxLength={10}
        aria-label={label}
        value={text}
        onChange={type}
        onBlur={() => setText(isoToDMY(value))} // se ficou incompleta, volta à última data válida
      />
      <button type="button" className="date-field-btn" onClick={openPicker} aria-label={label} title={label}>
        📅
      </button>
      <input
        ref={picker}
        type="date"
        className="date-field-native"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
    </div>
  )
}
