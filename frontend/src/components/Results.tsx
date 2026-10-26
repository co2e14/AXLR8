import { useMemo } from 'react'
import { fmtDuration, fmtPct } from '../lib/format'
import { queueSeries } from '../lib/timeline'
import type { Kpis, SimEvent, Workflow } from '../lib/types'
import type { Selection } from './WorkflowMap'

interface Props {
  wf: Workflow
  kpis: Kpis
  events: SimEvent[]
  t: number
  onSelect: (s: Selection) => void
}

export function Bottlenecks({ kpis, events, t, onSelect }: Props) {
  const rows = kpis.devices
    .filter((d) => d.utilisation !== null && d.uses > 0)
    .sort((a, b) => (b.utilisation ?? 0) - (a.utilisation ?? 0))
  const series = useMemo(() => Object.fromEntries(rows.map((d) => [d.id, queueSeries(events, d.id)])), [rows, events])
  const b = kpis.bottleneck
  const top = kpis.ranking.slice(0, 3)

  return (
    <div className="results">
      <div className="headline">
        <Figure value={fmtDuration(kpis.makespan)} label="until the last item finished" />
        <Figure value={`${kpis.completed} of ${kpis.released}`} label="items finished" />
        <Figure
          value={kpis.cobots.utilisation == null ? 'manual' : fmtPct(kpis.cobots.utilisation)}
          label={kpis.cobots.count ? `busy, ${kpis.cobots.count} ${kpis.cobots.count === 1 ? 'cobot' : 'cobots'}` : 'moves (no cobots)'}
        />
        <p className="verdict">
          {b ? (
            <>
              <strong>{b.name}</strong> is the busiest resource at {fmtPct(b.utilisation)}.
              {top.length > 1 && <> Next: {top.slice(1).map((x) => `${x.name} ${fmtPct(x.utilisation)}`).join(', ')}.</>}
            </>
          ) : (
            'Nothing was busy. Check that routes are switched on for this scenario.'
          )}
        </p>
      </div>

      <table className="util-table">
        <caption className="sr-only">How busy each device was</caption>
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col" className="num">Units</th>
            <th scope="col" className="bar-col">Time spent</th>
            <th scope="col" className="num">Uses</th>
            <th scope="col" className="num">Avg wait</th>
            <th scope="col" className="num">Longest queue</th>
            <th scope="col">Queue over time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className={b?.kind === 'device' && b.id === d.id ? 'is-bottleneck' : undefined}>
              <th scope="row">
                <button type="button" className="link plain" onClick={() => onSelect({ kind: 'device', id: d.id })}>
                  {d.name}
                </button>
              </th>
              <td className="num">{d.units}</td>
              <td className="bar-col">
                <UtilBar parts={[
                  { cls: 'processing', value: d.utilisation ?? 0, label: 'processing' },
                  { cls: 'waiting', value: d.blocked_fraction, label: 'holding finished items for a cobot' },
                ]} />
              </td>
              <td className="num">{d.uses}</td>
              <td className="num">{fmtDuration(d.avg_wait)}</td>
              <td className="num">{d.max_queue}</td>
              <td><Sparkline points={series[d.id] ?? []} end={kpis.makespan} t={t} /></td>
            </tr>
          ))}
          {kpis.cobots.count > 0 && (
            <tr className={b?.kind === 'cobot' ? 'is-bottleneck' : undefined}>
              <th scope="row">Cobots</th>
              <td className="num">{kpis.cobots.count}</td>
              <td className="bar-col">
                <UtilBar parts={[{ cls: 'moving', value: kpis.cobots.utilisation ?? 0, label: 'moving items' }]} />
              </td>
              <td className="num">{kpis.cobots.moves}</td>
              <td className="num">{fmtDuration(kpis.cobots.avg_wait)}</td>
              <td />
              <td />
            </tr>
          )}
        </tbody>
      </table>
      <ul className="legend" aria-label="Legend">
        <li><span className="swatch processing" />Processing</li>
        <li><span className="swatch waiting" />Holding finished items until a cobot is free</li>
        <li><span className="swatch moving" />Cobots moving items</li>
        <li><span className="swatch idle" />Idle</li>
      </ul>
    </div>
  )
}

export function RoutesTable({ wf, kpis, onSelect }: Props) {
  return (
    <table className="routes-table">
      <thead>
        <tr>
          <th scope="col">Route</th>
          <th scope="col" className="num">Finished</th>
          <th scope="col" className="num">Avg time on route</th>
          <th scope="col" className="num">Shortest</th>
          <th scope="col" className="num">Longest</th>
          <th scope="col" className="num">Per hour</th>
          <th scope="col">Keeps up with releases</th>
        </tr>
      </thead>
      <tbody>
        {kpis.routes.map((r) => {
          const route = wf.routes.find((x) => x.id === r.id)
          return (
            <tr key={r.id}>
              <th scope="row">
                <button type="button" className="link plain" onClick={() => onSelect({ kind: 'route', id: r.id })}>
                  {r.name}
                </button>
              </th>
              <td className="num">{r.completed} of {r.released}</td>
              <td className="num">{r.avg_cycle_time == null ? '—' : fmtDuration(r.avg_cycle_time)}</td>
              <td className="num">{r.min_cycle_time == null ? '—' : fmtDuration(r.min_cycle_time)}</td>
              <td className="num">{r.max_cycle_time == null ? '—' : fmtDuration(r.max_cycle_time)}</td>
              <td className="num">{r.throughput_per_hour == null ? '—' : r.throughput_per_hour.toFixed(1)}</td>
              <td className={r.keeps_up === false ? 'worse' : r.keeps_up ? 'better' : ''}>
                {r.completed < r.released
                  ? 'Some items never finished'
                  : r.keeps_up === null
                  ? <span className="hint">{route && route.interval > 0 ? 'Too few items to tell' : 'Released all at once'}</span>
                  : r.keeps_up
                    ? `Yes, every ${fmtDuration(route?.interval ?? 0)}`
                    : 'No, waits grow over the day'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="figure">
      <span className="figure-value">{value}</span>
      <span className="figure-label">{label}</span>
    </div>
  )
}

function UtilBar({ parts }: { parts: { cls: string; value: number; label: string }[] }) {
  const text = parts.map((p) => `${fmtPct(p.value)} ${p.label}`).join(', ')
  return (
    <div className="util">
      <div className="util-track" role="img" aria-label={text} title={text}>
        {parts.map((p) =>
          p.value > 0.0005 ? (
            <div key={p.cls} className={`util-seg ${p.cls}`} style={{ width: `${Math.min(1, p.value) * 100}%` }} />
          ) : null,
        )}
      </div>
      <span className="util-value">{fmtPct(parts[0].value)}</span>
    </div>
  )
}

function Sparkline({ points, end, t }: { points: [number, number][]; end: number; t: number }) {
  const W = 140
  const H = 28
  const peak = Math.max(1, ...points.map((p) => p[1]))
  if (end <= 0 || points.length === 0) return <span className="hint">No queue</span>
  const x = (time: number) => (time / end) * W
  const y = (n: number) => H - 2 - (n / peak) * (H - 4)
  let d = `M 0 ${y(0)}`
  let prevN = 0
  for (const [time, n] of points) {
    d += ` L ${x(time)} ${y(prevN)} L ${x(time)} ${y(n)}`
    prevN = n
  }
  d += ` L ${W} ${y(prevN)}`
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Queue peaks at ${peak}`}>
      <title>{`Queue peaks at ${peak}`}</title>
      <path d={d} />
      <line className="now" x1={x(t)} x2={x(t)} y1={0} y2={H} />
    </svg>
  )
}
