import { routeTransfers } from '../lib/labOps'
import type { SampleState } from '../lib/timeline'
import { INPUT, OUTPUT, type Kpis, type LabConfig, type Transfer } from '../lib/types'
import { fmtCompact, fmtPct } from '../lib/format'
import './LineSchematic.css'

export type Selection =
  | { kind: 'lab' }
  | { kind: 'station'; id: string }
  | { kind: 'transfer'; from: string; to: string }

const COL = 196 // distance between location centres
const BW = 144 // station block width
const EW = 84 // input/output box width
const TOP = 84
const BH = 124
const MID = TOP + 56 // transfer line height
const ARC_Y = 18 // control-point height for arm arcs
const ARC_INSET = 34 // arm arcs start and end this far inside the block tops
const WELL = 15
const H = 290
const TOKEN_R = 5.5

const centre = (i: number) => COL / 2 + i * COL

/** Keyboard activation for SVG elements acting as buttons (Enter or Space). */
const activate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fn()
  }
}
const halfWidth = (loc: string) => (loc === INPUT || loc === OUTPUT ? EW / 2 : BW / 2)

interface Props {
  lab: LabConfig
  states: SampleState[] | null
  kpis: Kpis | null
  selection: Selection
  onSelect: (s: Selection) => void
}

function transferGeometry(t: Transfer, i: number) {
  if (t.arm) {
    // Arm moves arch over the line from the top of one block to the top of the next.
    const endY = (loc: string) => (loc === INPUT || loc === OUTPUT ? TOP + 24 : TOP)
    const x1 = centre(i) + halfWidth(t.from_id) - ARC_INSET
    const x2 = centre(i + 1) - halfWidth(t.to_id) + ARC_INSET
    const y1 = endY(t.from_id)
    const y2 = endY(t.to_id)
    const c1 = { x: x1 + 18, y: ARC_Y }
    const c2 = { x: x2 - 18, y: ARC_Y }
    return {
      d: `M ${x1} ${y1} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${x2} ${y2}`,
      at: (p: number) => {
        const q = 1 - p
        return {
          x: q ** 3 * x1 + 3 * q * q * p * c1.x + 3 * q * p * p * c2.x + p ** 3 * x2,
          y: q ** 3 * y1 + 3 * q * q * p * c1.y + 3 * q * p * p * c2.y + p ** 3 * y2,
        }
      },
      labelY: 30,
    }
  }
  const x1 = centre(i) + halfWidth(t.from_id)
  const x2 = centre(i + 1) - halfWidth(t.to_id)
  return {
    d: `M ${x1} ${MID} L ${x2} ${MID}`,
    at: (p: number) => ({ x: x1 + (x2 - x1) * p, y: MID }),
    labelY: MID - 10,
  }
}

function Token({ x, y, status }: { x: number; y: number; status: string }) {
  return <circle className={`token st-${status}`} cx={x} cy={y} r={TOKEN_R} />
}

export function LineSchematic({ lab, states, kpis, selection, onSelect }: Props) {
  const locs = [INPUT, ...lab.stations.map((s) => s.id), OUTPUT]
  const transfers = routeTransfers(lab)
  const geo = transfers.map(transferGeometry)
  const placeName = (id: string) =>
    id === INPUT ? 'Start' : id === OUTPUT ? 'Done' : (lab.stations.find((s) => s.id === id)?.name ?? id)
  const armName = Object.fromEntries(lab.arms.map((a) => [a.id, a.name]))
  const width = locs.length * COL

  const byLoc = new Map<string, SampleState[]>()
  const moving: SampleState[] = []
  for (const s of states ?? []) {
    if (s.status === 'moving') moving.push(s)
    else {
      const list = byLoc.get(s.at) ?? []
      list.push(s)
      byLoc.set(s.at, list)
    }
  }
  const count = (loc: string, status: string) => (byLoc.get(loc) ?? []).filter((s) => s.status === status).length
  const busyArms = new Set(moving.map((s) => s.arm).filter(Boolean))
  const bottleneck = kpis?.bottleneck

  return (
    <div className="schematic-scroll">
      <svg
        className="schematic"
        style={{ minWidth: width * 0.72 }}
        viewBox={`0 0 ${width} ${H}`}
        role="group"
        aria-label={`Lab line: ${lab.stations.map((s) => s.name).join(', ')}`}
      >
        {transfers.map((t, i) => {
          const g = geo[i]
          const selected =
            selection.kind === 'transfer' && selection.from === t.from_id && selection.to === t.to_id
          const isBottleneck = bottleneck?.kind === 'arm' && bottleneck.id === t.arm
          const mx = (centre(i) + centre(i + 1)) / 2
          return (
            <g
              key={`${t.from_id}-${t.to_id}`}
              className={`transfer${t.arm ? ' arm' : ''}${selected ? ' selected' : ''}${
                t.arm && busyArms.has(t.arm) ? ' busy' : ''
              }${isBottleneck ? ' bottleneck' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={`Move from ${placeName(t.from_id)} to ${placeName(t.to_id)}`}
              onClick={() => onSelect({ kind: 'transfer', from: t.from_id, to: t.to_id })}
              onKeyDown={activate(() => onSelect({ kind: 'transfer', from: t.from_id, to: t.to_id }))}
            >
              <path className="hit" d={g.d} />
              <path className="line" d={g.d} />
              {t.arm && (
                <text className="transfer-label strong" x={mx} y={g.labelY - 13} textAnchor="middle">
                  {armName[t.arm] ?? t.arm}
                </text>
              )}
              <text className="transfer-label" x={mx} y={g.labelY} textAnchor="middle">
                {fmtCompact(t.time.value)}
                {t.time.kind !== 'fixed' && t.time.spread > 0 ? ` ±${Math.round(t.time.spread)} s` : ''}
              </text>
            </g>
          )
        })}

        <EndBox x={centre(0)} label="Start" sub={states ? `${count(INPUT, 'pending') + count(INPUT, 'queued') + count(INPUT, 'waiting')} to go` : 'Samples in'} />
        <EndBox
          x={centre(locs.length - 1)}
          label="Done"
          sub={states ? `${count(OUTPUT, 'done')} finished` : 'Samples out'}
        />

        {lab.stations.map((st, i) => {
          const cx = centre(i + 1)
          const x = cx - BW / 2
          const here = byLoc.get(st.id) ?? []
          const processing = here.filter((s) => s.status === 'processing')
          const queued = here.filter((s) => s.status === 'queued')
          const waiting = here.filter((s) => s.status === 'waiting')
          const wells = st.capacity * st.batch_size
          const cols = 6
          const shownWells = Math.min(wells, 24)
          const isBottleneck = bottleneck?.kind === 'station' && bottleneck.id === st.id
          const selected = selection.kind === 'station' && selection.id === st.id
          const stats = kpis?.stations.find((s) => s.id === st.id)
          return (
            <g
              key={st.id}
              className={`station${selected ? ' selected' : ''}${isBottleneck ? ' bottleneck' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={`Station ${st.name}`}
              onClick={() => onSelect({ kind: 'station', id: st.id })}
              onKeyDown={activate(() => onSelect({ kind: 'station', id: st.id }))}
            >
              <rect className="block" x={x} y={TOP} width={BW} height={BH} rx={6} />
              <text className="station-name" x={x + 12} y={TOP + 22}>
                {st.name.length > 18 ? `${st.name.slice(0, 17)}…` : st.name}
              </text>
              <text className="station-meta" x={x + 12} y={TOP + 39}>
                {fmtCompact(st.process_time.value)}
                {st.process_time.kind !== 'fixed' && st.process_time.spread > 0
                  ? ` ±${Math.round(st.process_time.spread)} s`
                  : ''}
                {st.batch_size > 1 ? `, batches of ${st.batch_size}` : ''}
              </text>
              {Array.from({ length: shownWells }, (_, w) => {
                const wx = x + 18 + (w % cols) * WELL
                const wy = TOP + 60 + Math.floor(w / cols) * WELL
                const s = processing[w]
                return s ? (
                  <Token key={w} x={wx} y={wy} status="processing" />
                ) : (
                  <circle key={w} className="well" cx={wx} cy={wy} r={TOKEN_R} />
                )
              })}
              {wells > 24 && (
                <text className="station-meta" x={x + 18} y={TOP + BH - 6}>
                  {wells} places
                </text>
              )}
              {waiting.slice(0, 4).map((s, k) => (
                <Token key={s.sample} x={x + BW - 16} y={TOP + 60 + k * WELL} status="waiting" />
              ))}
              {queued.slice(0, 9).map((s, k) => (
                <Token key={s.sample} x={x + 8 + k * 14} y={TOP + BH + 18} status="queued" />
              ))}
              {isBottleneck && stats && (
                <text className="bottleneck-label" x={x + 12} y={TOP + BH - 10}>
                  Bottleneck, busy {fmtPct(stats.utilisation)}
                </text>
              )}
              {states && (
                <text className="counts" x={x} y={TOP + BH + 44}>
                  <tspan className="c-queued">{queued.length} queued</tspan>
                  <tspan dx={8} className="c-processing">{processing.length} running</tspan>
                  <tspan dx={8} className="c-waiting">{waiting.length} held</tspan>
                </text>
              )}
              {st.buffer_size !== null && (
                <text className="station-meta" x={x + BW} y={TOP + BH + 22} textAnchor="end">
                  max {st.buffer_size}
                </text>
              )}
            </g>
          )
        })}

        {moving.map((s) => {
          const i = locs.indexOf(s.at)
          if (i < 0 || i >= geo.length) return null
          const p = geo[i].at(s.progress)
          return <Token key={s.sample} x={p.x} y={p.y} status="moving" />
        })}
      </svg>
    </div>
  )
}

function EndBox({ x, label, sub }: { x: number; label: string; sub: string }) {
  return (
    <g className="endbox">
      <rect x={x - EW / 2} y={TOP + 24} width={EW} height={BH - 48} rx={BH / 2} />
      <text className="station-name" x={x} y={MID - 2} textAnchor="middle">
        {label}
      </text>
      <text className="station-meta" x={x} y={MID + 15} textAnchor="middle">
        {sub}
      </text>
    </g>
  )
}
