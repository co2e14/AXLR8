import { useState } from 'react'
import { fmtDuration } from '../lib/format'
import type { ItemState } from '../lib/timeline'
import type { Workflow } from '../lib/types'
import { stepName } from './WorkflowMap'

const ROW_LIMIT = 300

function statusLabel(s: ItemState, joinStep: boolean): string {
  switch (s.status) {
    case 'pending': return 'Not released yet'
    case 'queued': return s.step < 0 ? 'Waiting to start' : joinStep ? 'Waiting for its partner or a free unit' : 'Queued'
    case 'waiting': return 'Finished here, waiting for a cobot'
    case 'moving': return s.cobot ? 'Moving (cobot)' : 'Moving'
    case 'processing': return 'Processing'
    case 'dwelling': return 'Incubating'
    case 'done': return 'Done'
  }
}

type Filter = 'active' | 'done' | 'all'

export function Items({ wf, states, t }: { wf: Workflow; states: ItemState[]; t: number }) {
  const [filter, setFilter] = useState<Filter>('active')
  const [routeFilter, setRouteFilter] = useState('')
  const devices = new Map(wf.devices.map((d) => [d.id, d]))
  const routes = new Map(wf.routes.map((r) => [r.id, r]))
  const rows = states.filter(
    (s) =>
      (routeFilter === '' || s.route === routeFilter) &&
      (filter === 'all' ? true : filter === 'done' ? s.status === 'done' : s.status !== 'done' && s.status !== 'pending'),
  )
  const where = (s: ItemState) => {
    const r = routes.get(s.route)
    const name = (i: number) => (i < 0 ? 'Start' : r?.steps[i] ? stepName(r.steps[i], devices) : `Step ${i + 1}`)
    const unit = s.unit !== null && s.device ? ` (unit ${s.unit})` : ''
    return s.status === 'moving' && s.to !== null ? `${name(s.step)} to ${name(s.to)}` : `${name(s.step)}${unit}`
  }

  return (
    <div className="samples">
      <div className="items-filters">
        <div className="segmented" role="radiogroup" aria-label="Which items to show">
          {(['active', 'done', 'all'] as Filter[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>
              {f === 'active' ? 'In the lab' : f === 'done' ? 'Finished' : 'All'}
            </button>
          ))}
        </div>
        <select aria-label="Route" value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}>
          <option value="">All routes</option>
          {wf.routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="hint">{filter === 'active' ? 'Nothing is in the lab at this moment.' : 'None yet.'}</p>
      ) : (
        <table className="sample-table">
          <thead>
            <tr>
              <th scope="col" className="num">Item</th>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Where</th>
              <th scope="col" className="num">Time on route</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_LIMIT).map((s) => {
              const step = routes.get(s.route)?.steps[s.step]
              return (
                <tr key={s.item}>
                  <td className="num">{s.item}</td>
                  <td>{routes.get(s.route)?.name ?? s.route}</td>
                  <td>
                    <span className={`dot st-bg-${s.status}`} aria-hidden="true" />
                    {statusLabel(s, !!step?.join)}
                  </td>
                  <td>{where(s)}</td>
                  <td className="num">{s.status === 'pending' ? '—' : fmtDuration(Math.max(0, t - s.released))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {rows.length > ROW_LIMIT && <p className="hint">Showing the first {ROW_LIMIT} of {rows.length}.</p>}
    </div>
  )
}
