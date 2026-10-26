import { useEffect, useId, useState } from 'react'
import type { TimeKind, TimeSpec } from '../lib/types'

interface NumberFieldProps {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  integer?: boolean
}

/** Number input that lets you clear and retype; only valid values are committed. */
export function NumberField({ label, value, onChange, min = 0, max, step = 1, unit, integer }: NumberFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (text: string) => {
    setDraft(text)
    const v = Number(text)
    if (text.trim() === '' || !Number.isFinite(v)) return
    if (integer && !Number.isInteger(v)) return
    if (v < min || (max !== undefined && v > max)) return
    onChange(v)
  }
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setDraft(String(value))}
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  )
}

export function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

const KIND_LABEL: Record<TimeKind, string> = {
  fixed: 'Always the same',
  normal: 'Varies (normal)',
  uniform: 'Varies (even spread)',
  triangular: 'Varies (triangular)',
}

const SPREAD_LABEL: Record<TimeKind, string> = {
  fixed: '',
  normal: 'Standard deviation',
  uniform: 'Plus or minus',
  triangular: 'Plus or minus',
}

export function TimeField({ label, spec, onChange }: { label: string; spec: TimeSpec; onChange: (t: TimeSpec) => void }) {
  const id = useId()
  return (
    <fieldset className="time-field">
      <legend>{label}</legend>
      <NumberField label="Time" unit="s" step={1} value={spec.value} onChange={(value) => onChange({ ...spec, value })} />
      <label className="field" htmlFor={id}>
        <span className="field-label">Variation</span>
        <select id={id} value={spec.kind} onChange={(e) => onChange({ ...spec, kind: e.target.value as TimeKind })}>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {spec.kind !== 'fixed' && (
        <NumberField
          label={SPREAD_LABEL[spec.kind]}
          unit="s"
          value={spec.spread}
          onChange={(spread) => onChange({ ...spec, spread })}
        />
      )}
    </fieldset>
  )
}
