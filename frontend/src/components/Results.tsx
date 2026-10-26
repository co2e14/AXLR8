import { useMemo } from 'react'
import { fmtDuration, fmtPct } from '../lib/format'
import { queueSeries } from '../lib/timeline'
import type { Kpis, LabConfig, SimEvent } from '../lib/types'

interface Props {
  lab: LabConfig
  kpis: Kpis
  events: SimEvent[]
  t: number
}

export function Results({ lab, kpis, events, t }: Props) {
  const series = useMemo(
    () => Object.fromEntries(kpis.stations.map((s) => [s.id, queueSeries(events, s.id)])),
    [kpis, events],
  )
  const b = kpis.bottleneck
  const bName = b && (b.kind === 'station' ? kpis.stations : kpis.arms).find((x) => x.id === b.id)?.name

  return (
    <div className="results">
      <div className="headline">
        <Figure value={kpis.throughput_per_hour === null ? 'n/a' : kpis.throughput_per_hour.toFixed(1)} label="samples per hour" />
        <Figure value={fmtDuration(kpis.makespan)} label={`to finish ${kpis.num_samples} ${kpis.num_samples === 1 ? 'sample' : 'samples'}`} />
        <Figure value={fmtDuration(kpis.avg_cycle_time)} label="average time per sample" />
        <p className="verdict">
          {b && bName ? (
            <>
              <strong>{bName}</strong> limits the line. It is busy {fmtPct(b.utilisation)} of the time
              {b.kind === 'arm' ? ', moving samples.' : '.'} Speeding it up or adding capacity there will raise throughput first.
            </>
          ) : (
            'Nothing is busy yet. Give stations or moves a time above zero.'
          )}
        </p>
      </div>

      <table className="util-table">
        <caption className="sr-only">Utilisation of each station and arm</caption>
        <thead>
          <tr>
            <th scope="col">Station or arm</th>
            <th scope="col" className="bar-col">Time spent</th>
            <th scope="col" className="num">Avg wait</th>
            <th scope="col" className="num">Longest queue</th>
            <th scope="col">Queue over time</th>
          </tr>
        </thead>
        <tbody>
          {kpis.stations.map((s) => (
            <tr key={s.id} className={b?.kind === 'station' && b.id === s.id ? 'is-bottleneck' : undefined}>
              <th scope="row">{s.name}</th>
              <td className="bar-col">
                <UtilBar parts={[
                  { cls: 'processing', value: s.utilisation, label: 'processing' },
                  { cls: 'waiting', value: s.blocked_fraction, label: 'holding finished samples' },
                ]} />
              </td>
              <td className="num">{fmtDuration(s.avg_wait)}</td>
              <td className="num">{s.max_queue}</td>
              <td>
                <Sparkline points={series[s.id] ?? []} end={kpis.makespan} t={t} />
              </td>
            </tr>
          ))}
          {kpis.arms.map((a) => (
            <tr key={a.id} className={b?.kind === 'arm' && b.id === a.id ? 'is-bottleneck' : undefined}>
              <th scope="row">{a.name}</th>
              <td className="bar-col">
                <UtilBar parts={[{ cls: 'moving', value: a.utilisation, label: 'moving samples' }]} />
              </td>
              <td className="num">{fmtDuration(a.avg_wait)}</td>
              <td className="num">
                <span className="hint">{a.moves} moves</span>
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="legend" aria-label="Legend">
        <li><span className="swatch processing" />Processing</li>
        <li><span className="swatch waiting" />Holding finished samples (next step full)</li>
        <li><span className="swatch moving" />Arm moving samples</li>
        <li><span className="swatch idle" />Idle</li>
      </ul>
      {lab.stations.length !== kpis.stations.length && (
        <p className="hint">The line has changed since this run. Run again to update these results.</p>
      )}
    </div>
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
            <div key={p.cls} className={`util-seg ${p.cls}`} style={{ width: `${p.value * 100}%` }} title={`${fmtPct(p.value)} ${p.label}`} />
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
