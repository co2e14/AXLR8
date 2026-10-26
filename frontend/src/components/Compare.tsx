import { fmtDuration, fmtPct } from '../lib/format'
import type { Kpis } from '../lib/types'

export interface Baseline {
  label: string
  kpis: Kpis
}

interface Row {
  label: string
  before: number | null
  after: number | null
  fmt: (v: number) => string
  higherIsBetter: boolean
}

export function Compare({ baseline, current, onKeep }: { baseline: Baseline | null; current: Kpis | null; onKeep: () => void }) {
  if (!current) return <p className="hint">Run a simulation first, then keep it as a baseline to compare changes against.</p>
  if (!baseline)
    return (
      <div className="compare-empty">
        <p>Keep this run as a baseline, change some settings, run again, and the two will be compared here.</p>
        <button type="button" onClick={onKeep}>Keep as baseline</button>
      </div>
    )

  const rows: Row[] = [
    { label: 'Samples per hour', before: baseline.kpis.throughput_per_hour, after: current.throughput_per_hour, fmt: (v) => v.toFixed(1), higherIsBetter: true },
    { label: 'Time to finish', before: baseline.kpis.makespan, after: current.makespan, fmt: fmtDuration, higherIsBetter: false },
    { label: 'Average time per sample', before: baseline.kpis.avg_cycle_time, after: current.avg_cycle_time, fmt: fmtDuration, higherIsBetter: false },
  ]
  for (const s of current.stations) {
    const old = baseline.kpis.stations.find((x) => x.id === s.id)
    rows.push({ label: `${s.name} busy`, before: old?.utilisation ?? null, after: s.utilisation, fmt: fmtPct, higherIsBetter: true })
  }
  const name = (k: Kpis) => {
    const b = k.bottleneck
    if (!b) return 'None'
    return (b.kind === 'station' ? k.stations : k.arms).find((x) => x.id === b.id)?.name ?? b.id
  }

  return (
    <div className="compare">
      <table className="compare-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="num">Baseline</th>
            <th scope="col" className="num">This run</th>
            <th scope="col" className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const delta = r.before !== null && r.after !== null && r.before !== 0 ? (r.after - r.before) / r.before : null
            const better = delta !== null && Math.abs(delta) > 0.005 && (delta > 0) === r.higherIsBetter
            const worse = delta !== null && Math.abs(delta) > 0.005 && !better
            return (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td className="num">{r.before === null ? '—' : r.fmt(r.before)}</td>
                <td className="num">{r.after === null ? '—' : r.fmt(r.after)}</td>
                <td className={`num ${better ? 'better' : worse ? 'worse' : ''}`}>
                  {delta === null ? '—' : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`}
                  {better && <span className="sr-only"> (better)</span>}
                  {worse && <span className="sr-only"> (worse)</span>}
                </td>
              </tr>
            )
          })}
          <tr>
            <th scope="row">Bottleneck</th>
            <td className="num">{name(baseline.kpis)}</td>
            <td className="num">{name(current)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <div className="button-row">
        <button type="button" onClick={onKeep}>Keep this run as the baseline</button>
        <span className="hint">Baseline: {baseline.label}</span>
      </div>
    </div>
  )
}
