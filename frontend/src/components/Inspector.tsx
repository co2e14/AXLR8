import {
  addArm, addStationAfter, moveStation, removeArm, removeStation, renameArm, routeTransfers, updateStation,
  updateTransfer,
} from '../lib/labOps'
import { fmtDuration, fmtPct } from '../lib/format'
import { INPUT, OUTPUT, type Kpis, type LabConfig } from '../lib/types'
import { NumberField, TextField, TimeField } from './fields'
import type { Selection } from './LineSchematic'

interface Props {
  lab: LabConfig
  kpis: Kpis | null
  selection: Selection
  onChange: (lab: LabConfig) => void
  onSelect: (s: Selection) => void
}

const placeName = (lab: LabConfig, id: string) =>
  id === INPUT ? 'Start' : id === OUTPUT ? 'Done' : (lab.stations.find((s) => s.id === id)?.name ?? id)

export function Inspector({ lab, kpis, selection, onChange, onSelect }: Props) {
  if (selection.kind === 'station') {
    const index = lab.stations.findIndex((s) => s.id === selection.id)
    const st = lab.stations[index]
    if (!st) return <LabPanel lab={lab} onChange={onChange} onSelect={onSelect} />
    const stats = kpis?.stations.find((s) => s.id === st.id)
    const set = (patch: Parameters<typeof updateStation>[2]) => onChange(updateStation(lab, st.id, patch))
    return (
      <section className="inspector" aria-label="Station settings">
        <BackLink onSelect={onSelect} />
        <h2>{st.name}</h2>
        <p className="hint">Station {index + 1} of {lab.stations.length}</p>
        <TextField label="Name" value={st.name} onChange={(name) => set({ name })} />
        <TimeField label="Processing time" spec={st.process_time} onChange={(process_time) => set({ process_time })} />
        <div className="field-row">
          <NumberField label="Parallel slots" integer min={1} max={50} value={st.capacity} onChange={(capacity) => set({ capacity })} />
          <NumberField label="Samples per run" integer min={1} max={96} value={st.batch_size} onChange={(batch_size) => set({ batch_size, buffer_size: st.buffer_size === null ? null : Math.max(st.buffer_size, batch_size) })} />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={st.buffer_size !== null}
            onChange={(e) => set({ buffer_size: e.target.checked ? Math.max(st.batch_size, 4) : null })}
          />
          Limit the waiting space
        </label>
        {st.buffer_size !== null && (
          <NumberField
            label="Samples that can wait"
            integer
            min={st.batch_size}
            max={500}
            value={st.buffer_size}
            onChange={(buffer_size) => set({ buffer_size })}
          />
        )}
        <p className="hint">
          When the waiting space is full, the previous station has to hold on to finished samples.
        </p>

        {stats && (
          <dl className="stat-list">
            <dt>Busy</dt>
            <dd>{fmtPct(stats.utilisation)}</dd>
            <dt>Holding finished samples</dt>
            <dd>{fmtPct(stats.blocked_fraction)}</dd>
            <dt>Average wait before starting</dt>
            <dd>{fmtDuration(stats.avg_wait)}</dd>
            <dt>Longest queue</dt>
            <dd>{stats.max_queue}</dd>
          </dl>
        )}

        <div className="button-row">
          <button type="button" onClick={() => onChange(moveStation(lab, st.id, -1))} disabled={index === 0}>
            Move earlier
          </button>
          <button type="button" onClick={() => onChange(moveStation(lab, st.id, 1))} disabled={index === lab.stations.length - 1}>
            Move later
          </button>
        </div>
        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              const next = addStationAfter(lab, index)
              onChange(next)
              onSelect({ kind: 'station', id: next.stations[index + 1].id })
            }}
          >
            Add station after
          </button>
          <button
            type="button"
            className="danger"
            disabled={lab.stations.length === 1}
            onClick={() => {
              onChange(removeStation(lab, st.id))
              onSelect({ kind: 'lab' })
            }}
          >
            Remove station
          </button>
        </div>
      </section>
    )
  }

  if (selection.kind === 'transfer') {
    const t = routeTransfers(lab).find((x) => x.from_id === selection.from && x.to_id === selection.to)
    if (!t) return <LabPanel lab={lab} onChange={onChange} onSelect={onSelect} />
    const set = (patch: Parameters<typeof updateTransfer>[3]) => onChange(updateTransfer(lab, t.from_id, t.to_id, patch))
    return (
      <section className="inspector" aria-label="Move settings">
        <BackLink onSelect={onSelect} />
        <h2>
          {placeName(lab, t.from_id)} to {placeName(lab, t.to_id)}
        </h2>
        <label className="field">
          <span className="field-label">Moved by</span>
          <select value={t.arm ?? ''} onChange={(e) => set({ arm: e.target.value || null })}>
            <option value="">No arm (conveyor or fixed delay)</option>
            {lab.arms.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          {t.arm
            ? 'An arm moves one sample at a time, so samples wait while it is busy elsewhere.'
            : 'Without an arm, any number of samples can be moving at once.'}
        </p>
        <TimeField label="Move time (pick, travel, place)" spec={t.time} onChange={(time) => set({ time })} />
        {lab.arms.length === 0 && (
          <button type="button" onClick={() => onChange(addArm(lab))}>
            Add a cobot arm
          </button>
        )}
      </section>
    )
  }

  return <LabPanel lab={lab} onChange={onChange} onSelect={onSelect} />
}

function BackLink({ onSelect }: { onSelect: (s: Selection) => void }) {
  return (
    <button type="button" className="link" onClick={() => onSelect({ kind: 'lab' })}>
      Back to lab overview
    </button>
  )
}

function LabPanel({ lab, onChange, onSelect }: Pick<Props, 'lab' | 'onChange' | 'onSelect'>) {
  const transfers = routeTransfers(lab)
  return (
    <section className="inspector" aria-label="Lab settings">
      <TextField label="Lab name" value={lab.name} onChange={(name) => onChange({ ...lab, name })} />
      <p className="hint">Select a station or a move on the line to change its times.</p>

      <h3>Cobot arms</h3>
      {lab.arms.length === 0 && <p className="hint">No arms yet. Every move is a fixed delay.</p>}
      <ul className="arm-list">
        {lab.arms.map((a) => {
          const uses = transfers.filter((t) => t.arm === a.id).length
          return (
            <li key={a.id}>
              <input
                aria-label={`Name of ${a.name}`}
                value={a.name}
                onChange={(e) => onChange(renameArm(lab, a.id, e.target.value))}
              />
              <span className="hint">{uses === 1 ? '1 move' : `${uses} moves`}</span>
              <button type="button" className="link danger" onClick={() => onChange(removeArm(lab, a.id))}>
                Remove
              </button>
            </li>
          )
        })}
      </ul>
      <button type="button" onClick={() => onChange(addArm(lab))}>
        Add arm
      </button>

      <h3>Stations</h3>
      <ol className="station-list">
        {lab.stations.map((s) => (
          <li key={s.id}>
            <button type="button" className="link" onClick={() => onSelect({ kind: 'station', id: s.id })}>
              {s.name}
            </button>
            <span className="hint">{fmtDuration(s.process_time.value)}</span>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => {
          const next = addStationAfter(lab, lab.stations.length - 1)
          onChange(next)
          onSelect({ kind: 'station', id: next.stations[next.stations.length - 1].id })
        }}
      >
        Add station at the end
      </button>
    </section>
  )
}
