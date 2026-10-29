import { useMemo } from 'react'
import { fmtDuration, fmtPct } from '../lib/format'
import { queueSeries } from '../lib/timeline'
import type { Kpis, Ranges, SimEvent, Spread, Workflow } from '../lib/types'
import type { Selection } from './WorkflowMap'

interface Props {
  wf: Workflow
  kpis: Kpis
  events: SimEvent[]
  t: number
  onSelect: (s: Selection) => void
  ranges?: Ranges | null // when the run was repeated over several seeds
}

/** "low–high", the middle 80% of the runs; null when every run gave the same value. */
function span(s: Spread | null | undefined, fmt: (v: number) => string): string | null {
  if (!s || s.max - s.min < 1e-9) return null
  const lo = fmt(s.low)
  const hi = fmt(s.high)
  if (lo !== hi) return `${lo}–${hi}`
  const [a, b] = [fmt(s.min), fmt(s.max)]
  return a === b ? null : `${a}–${b}`
}

export function Bottlenecks({ kpis, events, t, onSelect, ranges }: Props) {
  const rows = kpis.devices
    .filter((d) => d.utilisation !== null && d.uses > 0)
    .sort((a, b) => (b.utilisation ?? 0) - (a.utilisation ?? 0))
  const series = useMemo(() => Object.fromEntries(rows.map((d) => [d.id, queueSeries(events, d.id)])), [rows, events])
  const b = kpis.bottleneck
  const top = kpis.ranking.slice(0, 3)

  return (
    <div className="results">
      <div className="headline">
        <Figure value={fmtDuration(kpis.makespan)} label="until the last item finished" range={span(ranges?.makespan, fmtDuration)} />
        <Figure value={`${kpis.completed} of ${kpis.released}`} label="items finished" range={span(ranges?.completed, (v) => v.toFixed(0))} />
        {kpis.carried_over > 0 && (
          <Figure value={`${kpis.carried_completed} of ${kpis.carried_over}`} label="carried over from day 1, finished" />
        )}
        <Figure
          value={kpis.cobots.utilisation == null ? 'manual' : fmtPct(kpis.cobots.utilisation)}
          label={kpis.cobots.count ? `busy, ${kpis.cobots.count} ${kpis.cobots.count === 1 ? 'cobot' : 'cobots'}` : 'moves (no cobots)'}
          range={span(ranges?.cobot_utilisation, fmtPct)}
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

      {ranges && <RangeNote ranges={ranges} kpis={kpis} />}

      <table className="util-table">
        <caption className="sr-only">How busy each device was</caption>
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col" className="num">Units</th>
            <th scope="col" className="bar-col">Time spent</th>
            {ranges && <th scope="col" className="num">Range</th>}
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
              {ranges && <td className="num range">{span(ranges.devices[d.id], fmtPct) ?? '—'}</td>}
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
      {kpis.incubators.length > 0 && <Incubators kpis={kpis} />}
    </div>
  )
}

function Incubators({ kpis }: { kpis: Kpis }) {
  return (
    <table className="util-table">
      <caption>
        Incubators. Imaging covers until 24 h after the last day starts, including stored plates imaged again after the
        last item finished; the busy figures above stop at the last item.
      </caption>
      <thead>
        <tr>
          <th scope="col">Unit</th>
          <th scope="col" className="num">Plates inside (start → end)</th>
          <th scope="col" className="num">In / out</th>
          <th scope="col" className="bar-col">Time imaging</th>
          <th scope="col" className="num">Plates imaged</th>
          <th scope="col" className="num">Growth images</th>
          <th scope="col" className="num">Avg late</th>
          <th scope="col" className="num">Most late</th>
        </tr>
      </thead>
      <tbody>
        {kpis.incubators.map((u) => (
          <tr key={`${u.id}:${u.unit}`} className={u.imaging_share > 0.9 ? 'is-bottleneck' : undefined}>
            <th scope="row">{u.name} {u.unit}{u.imager ? '' : ' (no imager)'}</th>
            <td className="num">
              {u.stored_start} → {u.stored_end}{u.capacity != null ? ` of ${u.capacity}` : ''}
            </td>
            <td className="num">+{u.stored_today} / −{u.taken_out}</td>
            <td className="bar-col">
              {u.imager ? (
                <UtilBar parts={[{ cls: 'processing', value: Math.min(1, u.imaging_share), label: 'imaging' }]} />
              ) : (
                <span className="hint">—</span>
              )}
            </td>
            <td className="num">{u.images}</td>
            <td className="num">{u.scheduled}</td>
            <td className="num">{u.scheduled ? fmtDuration(u.avg_delay) : '—'}</td>
            <td className="num">{u.scheduled ? fmtDuration(u.max_delay) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RangeNote({ ranges, kpis }: { ranges: Ranges; kpis: Kpis }) {
  const names = new Map([...kpis.devices.map((d) => [d.id, d.name] as const), ['cobots', 'Cobots'] as const])
  const busiest = Object.entries(ranges.bottleneck).sort((a, b) => b[1] - a[1])
  const same = ranges.makespan.max - ranges.makespan.min < 1e-9 && Object.values(ranges.devices).every((s) => s.max - s.min < 1e-9)
  const growth = span(ranges.growth_delay, fmtDuration)
  return (
    <p className="range-note" role="status">
      {same ? (
        <>
          All {ranges.runs} runs gave the same results: every time is fixed. Set a time variation, or give device and step
          times a spread, to see how much the results could vary.
        </>
      ) : (
        <>
          Figures are for seed {ranges.seeds[0]}; ranges cover the middle 80% of {ranges.runs} runs (seeds {ranges.seeds[0]}–
          {ranges.seeds[ranges.seeds.length - 1]}). Busiest:{' '}
          {busiest.map(([id, n]) => `${names.get(id) ?? id} in ${n} of ${ranges.runs}`).join(', ')}.
          {growth && <> Growth images are {growth} late on average.</>}
        </>
      )}
    </p>
  )
}

export function DaysTable({ kpis }: { kpis: Kpis }) {
  return (
    <table className="routes-table">
      <caption className="sr-only">Each day of the run</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col" className="num">Items finished</th>
          <th scope="col" className="num">Day's work done after</th>
          <th scope="col" className="num">Plates in incubators</th>
          <th scope="col" className="num">Soaks: grown / from stock</th>
          <th scope="col" className="num">Plates imaged</th>
          <th scope="col" className="num">Imaging</th>
          <th scope="col" className="num">Growth images late</th>
          <th scope="col" className="num">Cobot moves</th>
        </tr>
      </thead>
      <tbody>
        {kpis.days.map((d) => (
          <tr key={d.day}>
            <th scope="row">Day {d.day}</th>
            <td className={`num${d.completed < d.released ? ' worse' : ''}`}>{d.completed} of {d.released}</td>
            <td className="num">{d.last_finish == null ? '—' : fmtDuration(d.last_finish)}</td>
            <td className="num">{d.stored_end}</td>
            <td className="num">{d.soaks_grown} / {d.soaks_stock}</td>
            <td className="num">{d.images}</td>
            <td className="num">{d.imaging_hours.toFixed(1)} h</td>
            <td className="num">{d.growth_delay ? fmtDuration(d.growth_delay) : '—'}</td>
            <td className="num">{d.cobot_moves}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={9} className="hint">
            Soaks take the plate that has been growing ready longest; until plates set up in the run have grown, they use
            plates that were inside at the start. The last day runs on until its last item finishes.
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

export function RoutesTable({ wf, kpis, onSelect, ranges }: Props) {
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
              <td className="num">
                {r.avg_cycle_time == null ? '—' : fmtDuration(r.avg_cycle_time)}
                {span(ranges?.routes[r.id]?.avg_cycle, fmtDuration) && <span className="range"> ({span(ranges?.routes[r.id]?.avg_cycle, fmtDuration)})</span>}
              </td>
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
                {ranges && ranges.routes[r.id] && r.keeps_up !== null && (
                  <span className="range"> (kept up in {ranges.routes[r.id].keeps_up} of {ranges.runs} runs)</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Figure({ value, label, range }: { value: string; label: string; range?: string | null }) {
  return (
    <div className="figure">
      <span className="figure-value">{value}</span>
      <span className="figure-label">{label}</span>
      {range && <span className="figure-range">{range} across runs</span>}
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
