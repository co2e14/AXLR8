import { useState } from 'react'
import { fmtDuration } from '../lib/format'
import type { SampleState, Timelines } from '../lib/timeline'
import { INPUT, OUTPUT, type LabConfig } from '../lib/types'

const ROW_LIMIT = 300

export function statusLabel(s: SampleState): string {
  switch (s.status) {
    case 'pending': return 'Not started'
    case 'queued': return s.at === INPUT ? 'Waiting to start' : 'Queued'
    case 'waiting': return s.reason === 'arm' ? 'Waiting for arm' : 'Held, next step full'
    case 'moving': return 'Moving'
    case 'processing': return 'Processing'
    case 'done': return 'Done'
  }
}

type Filter = 'all' | 'active' | 'done'

export function Samples({ lab, states, timelines, t }: { lab: LabConfig; states: SampleState[]; timelines: Timelines; t: number }) {
  const [filter, setFilter] = useState<Filter>('active')
  const name = (id: string) =>
    id === INPUT ? 'Start' : id === OUTPUT ? 'Done' : (lab.stations.find((s) => s.id === id)?.name ?? id)
  const rows = states.filter((s) =>
    filter === 'all' ? true : filter === 'done' ? s.status === 'done' : s.status !== 'done' && s.status !== 'pending',
  )
  const where = (s: SampleState) => (s.status === 'moving' && s.to ? `${name(s.at)} to ${name(s.to)}` : name(s.at))
  const timeIn = (s: SampleState) => {
    const segs = timelines.get(s.sample) ?? []
    if (s.status === 'pending' || segs.length === 0) return '—'
    const end = s.status === 'done' ? segs[segs.length - 1].start : t
    return fmtDuration(end - segs[0].start)
  }

  return (
    <div className="samples">
      <div className="segmented" role="radiogroup" aria-label="Which samples to show">
        {(['active', 'done', 'all'] as Filter[]).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>
            {f === 'active' ? 'In the lab' : f === 'done' ? 'Finished' : 'All'}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="hint">{filter === 'active' ? 'No samples are in the lab at this moment.' : 'None yet.'}</p>
      ) : (
        <table className="sample-table">
          <thead>
            <tr>
              <th scope="col" className="num">Sample</th>
              <th scope="col">Status</th>
              <th scope="col">Where</th>
              <th scope="col" className="num">Time in lab</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_LIMIT).map((s) => (
              <tr key={s.sample}>
                <td className="num">{s.sample}</td>
                <td>
                  <span className={`dot st-bg-${s.status}`} aria-hidden="true" />
                  {statusLabel(s)}
                </td>
                <td>{where(s)}</td>
                <td className="num">{timeIn(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > ROW_LIMIT && <p className="hint">Showing the first {ROW_LIMIT} of {rows.length}.</p>}
    </div>
  )
}
