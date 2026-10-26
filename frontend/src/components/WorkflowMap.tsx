import type { ItemState } from '../lib/timeline'
import { fmtCompact, fmtPct } from '../lib/format'
import { unitsInPhase, type Device, type Kpis, type Route, type Scenario, type Step, type Workflow } from '../lib/types'
import './WorkflowMap.css'

export type Selection =
  | { kind: 'overview' }
  | { kind: 'device'; id: string }
  | { kind: 'route'; id: string }
  | { kind: 'step'; route: string; index: number }

const BOX_W = 118
const BOX_H = 66
const BODY_H = 44
const GAP = 26
const PITCH = BOX_W + GAP
const TOP = 22
const LANE_H = TOP + BOX_H + 54
const R = 5

const x0 = (i: number) => 14 + i * PITCH
const LINE_Y = TOP + BODY_H / 2
const LOOP_Y = TOP + BOX_H + 36

/** Deck colour key: fixed (blue), project-specific (orange), manual access (green), optional (grey). */
export function boxClass(step: Step, device: Device | undefined): string {
  if (!step.enabled) return 'off'
  if (step.optional) return 'optional'
  if (device?.kind === 'manual') return 'manual'
  if (device?.kind === 'waste') return 'waste'
  const timing = step.timing ?? device?.timing
  return timing === 'project' ? 'project' : 'fixed'
}

export function stepName(step: Step, devices: Map<string, Device>): string {
  return step.label ?? step.devices.map((d) => devices.get(d)?.name ?? d).join(' / ')
}

export function releaseText(r: Route): string {
  if (r.count === 0) return 'Fed by another route'
  const n = `${r.count} ${r.count === 1 ? 'item' : 'items'}`
  const from = r.offset > 0 ? ` from ${fmtCompact(r.offset)}` : ''
  return r.interval > 0 ? `${n}, one every ${fmtCompact(r.interval)}${from}` : `${n} at once${from}`
}

interface Props {
  wf: Workflow
  phase: number
  scenario: Scenario
  states: ItemState[] | null
  kpis: Kpis | null
  selection: Selection
  onSelect: (s: Selection) => void
}

const activate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fn()
  }
}

export function WorkflowMap({ wf, phase, scenario, states, kpis, selection, onSelect }: Props) {
  const devices = new Map(wf.devices.map((d) => [d.id, d]))
  const byRoute = new Map<string, ItemState[]>()
  for (const s of states ?? []) {
    const list = byRoute.get(s.route) ?? []
    list.push(s)
    byRoute.set(s.route, list)
  }
  const groups: [string, Route[]][] = []
  for (const r of wf.routes) {
    const g = groups.find(([name]) => name === r.group)
    if (g) g[1].push(r)
    else groups.push([r.group, [r]])
  }
  const bottleneck = kpis?.bottleneck?.kind === 'device' ? kpis.bottleneck.id : null
  const skipped = new Set(kpis?.skipped.map((s) => s.route) ?? [])
  const highlight = selection.kind === 'device' ? selection.id : null
  const width = Math.max(...wf.routes.map((r) => r.steps.length)) * PITCH + 4

  return (
    <div className="wf-map" role="group" aria-label="Workflow routes">
      {groups.map(([group, routes]) => (
        <section key={group} className={`wf-group g-${slug(group)}`} aria-label={group || 'Routes'}>
          <h3 className="wf-group-name">{group || 'Routes'}</h3>
          {routes.map((r) => (
            <Lane
              key={r.id}
              route={r}
              wf={wf}
              devices={devices}
              phase={phase}
              active={r.enabled && r.scenarios.includes(scenario) && !skipped.has(r.id)}
              notPossible={skipped.has(r.id)}
              items={byRoute.get(r.id) ?? []}
              showItems={states !== null}
              width={width}
              bottleneck={bottleneck}
              highlight={highlight}
              selection={selection}
              onSelect={onSelect}
              kpis={kpis}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '-')

interface LaneProps {
  notPossible: boolean
  route: Route
  wf: Workflow
  devices: Map<string, Device>
  phase: number
  active: boolean
  items: ItemState[]
  showItems: boolean
  width: number
  bottleneck: string | null
  highlight: string | null
  selection: Selection
  onSelect: (s: Selection) => void
  kpis: Kpis | null
}

function Lane({ notPossible, route, wf, devices, phase, active, items, showItems, width, bottleneck, highlight, selection, onSelect, kpis }: LaneProps) {
  const at = (step: number, status: string) => items.filter((s) => s.step === step && s.status === status)
  const atStart = items.filter((s) => s.step === -1 && s.status !== 'moving').length
  const pending = items.filter((s) => s.status === 'pending').length
  const done = items.filter((s) => s.status === 'done').length
  const inProgress = items.length - pending - done
  const stats = kpis?.routes.find((x) => x.id === route.id)
  const routeSelected = selection.kind === 'route' && selection.id === route.id
  const scenarioNote = active
    ? null
    : notPossible
      ? `Not possible with phase ${phase} equipment`
      : !route.enabled
        ? 'Switched off'
        : route.scenarios.includes('run') ? 'Run days only' : 'Shutdown days only'

  return (
    <div className={`wf-lane${active ? '' : ' inactive'}`}>
      <div className="wf-lane-head">
        <button
          type="button"
          className={`wf-lane-label${routeSelected ? ' selected' : ''}`}
          onClick={() => onSelect({ kind: 'route', id: route.id })}
        >
          {route.name}
        </button>
        <span className="lane-meta">
          {route.labware ? `${route.labware}, ` : ''}
          {scenarioNote ?? releaseText(route)}
        </span>
        {showItems && active && (
          <span className="lane-live">
            {atStart > 0 && `${atStart} at start, `}
            {inProgress} in progress, {done} done
          </span>
        )}
        {stats?.keeps_up === false && <span className="lane-warn">Falling behind its release rate</span>}
      </div>
      <svg
        className="wf-lane-svg"
        viewBox={`0 0 ${width} ${LANE_H}`}
        style={{ minWidth: width * 0.72, maxWidth: width }}
      >
        {route.steps.slice(1).map((s, i) => (
          <Connector key={i} from={i} transport={s.transport} />
        ))}
        {route.loop && <LoopMark loop={route.loop} />}
        {route.steps.map((s, i) => {
          const device = devices.get(s.devices[0])
          const cls = boxClass(s, device)
          const spec = s.time ?? device?.time
          const unitsNote = unitsText(s, s.devices.map((d) => devices.get(d)).filter(Boolean) as Device[], phase)
          const isBottleneck = active && !!bottleneck && s.enabled && s.devices.includes(bottleneck)
          const isHighlight = !!highlight && s.devices.includes(highlight)
          const selected = selection.kind === 'step' && selection.route === route.id && selection.index === i
          const assumed = (s.timing ?? device?.timing) === 'assumed' && !s.time
          const inTray = showItems ? [...at(i, 'processing'), ...at(i, 'dwelling'), ...at(i, 'waiting')] : []
          const queued = showItems ? at(i, 'queued') : []
          const x = x0(i)
          const devStats = isBottleneck ? kpis?.devices.find((d) => d.id === bottleneck) : undefined
          return (
            <g
              key={i}
              className={`wf-step ${cls}${isBottleneck ? ' bottleneck' : ''}${isHighlight ? ' highlight' : ''}${selected ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${route.name}, step ${i + 1}: ${stepName(s, devices)}`}
              onClick={() => onSelect({ kind: 'step', route: route.id, index: i })}
              onKeyDown={activate(() => onSelect({ kind: 'step', route: route.id, index: i }))}
            >
              <title>{stepTooltip(s, devices, assumed)}</title>
              {s.join && <rect className="join-ring" x={x - 4} y={TOP - 4} width={BOX_W + 8} height={BOX_H + 8} rx={10} />}
              <rect className="box" x={x} y={TOP} width={BOX_W} height={BOX_H} rx={7} />
              <rect className="tray" x={x + 3} y={TOP + BODY_H} width={BOX_W - 6} height={BOX_H - BODY_H - 3} rx={4} />
              <text className="step-name" x={x + 8} y={TOP + 17}>
                {clip(stepName(s, devices), 17)}
              </text>
              <text className="step-meta" x={x + 8} y={TOP + 34}>
                {spec ? fmtCompact(spec.value) : ''}
                {assumed ? '?' : ''}
              </text>
              {unitsNote && (
                <text className="step-meta" x={x + BOX_W - 8} y={TOP + 34} textAnchor="end">
                  {unitsNote}
                </text>
              )}
              {!s.enabled && (
                <text className="tray-note" x={x + 10} y={TOP + BOX_H - 8}>
                  Switched off
                </text>
              )}
              {inTray.slice(0, 7).map((it, k) => (
                <circle key={it.item} className={`token st-${it.status}`} cx={x + 12 + k * 14} cy={TOP + BODY_H + 9.5} r={R} />
              ))}
              {inTray.length > 7 && (
                <text className="tray-note" x={x + BOX_W - 8} y={TOP + BOX_H - 8} textAnchor="end">
                  +{inTray.length - 7}
                </text>
              )}
              {queued.slice(0, 7).map((it, k) => (
                <circle key={it.item} className="token st-queued" cx={x + 8 + k * 13} cy={TOP + BOX_H + 12} r={R} />
              ))}
              {queued.length > 7 && (
                <text className="queue-note" x={x + 8 + 7 * 13} y={TOP + BOX_H + 16}>
                  +{queued.length - 7}
                </text>
              )}
              {isBottleneck && (
                <text className="bottleneck-label" x={x} y={TOP - 8}>
                  Bottleneck{devStats?.utilisation != null ? `, busy ${fmtPct(devStats.utilisation)}` : ''}
                </text>
              )}
              {!isBottleneck && (s.join || s.sync) && (
                <text className="join-label" x={x} y={TOP - 8}>
                  {s.join
                    ? `Meets ${partnerName(wf, route.id, s.join, 'join')}`
                    : `Starts with ${partnerName(wf, route.id, s.sync!, 'sync')}`}
                </text>
              )}
              {s.dwell && (
                <text className="spawn-label" x={x} y={TOP + BOX_H + 30}>
                  Then {fmtCompact(s.dwell.value)} incubation
                </text>
              )}
              {s.spawn.length > 0 && (
                <text className="spawn-label" x={x + BOX_W} y={TOP + BOX_H + 30} textAnchor="end">
                  Starts {s.spawn.map((sp) => wf.routes.find((r) => r.id === sp.route)?.name ?? sp.route).join(', ')}
                </text>
              )}
            </g>
          )
        })}
        {showItems &&
          items
            .filter((it) => it.status === 'moving')
            .map((it) => {
              const p = movePoint(it.step, it.to ?? it.step + 1, it.progress)
              return <circle key={it.item} className="token st-moving" cx={p.x} cy={p.y} r={R} />
            })}
      </svg>
    </div>
  )
}

function Connector({ from, transport }: { from: number; transport: Step['transport'] }) {
  const xa = x0(from) + BOX_W
  const xb = x0(from + 1)
  if (transport === 'linked') {
    return (
      <g className="conn linked">
        <line x1={xa} x2={xb} y1={LINE_Y - 2} y2={LINE_Y - 2} />
        <line x1={xa} x2={xb} y1={LINE_Y + 2} y2={LINE_Y + 2} />
      </g>
    )
  }
  return (
    <g className={`conn ${transport}`}>
      <line x1={xa} x2={xb - 5} y1={LINE_Y} y2={LINE_Y} />
      <path d={`M ${xb - 7} ${LINE_Y - 4} L ${xb} ${LINE_Y} L ${xb - 7} ${LINE_Y + 4} Z`} />
    </g>
  )
}

function LoopMark({ loop }: { loop: NonNullable<Route['loop']> }) {
  const xa = x0(loop.start) + 10
  const xb = x0(loop.end) + BOX_W - 10
  return (
    <g className="loop-mark">
      <path d={`M ${xb} ${TOP + BOX_H + 22} L ${xb} ${LOOP_Y} L ${xa} ${LOOP_Y} L ${xa} ${TOP + BOX_H + 26}`} />
      <path className="head" d={`M ${xa - 4} ${TOP + BOX_H + 30} L ${xa} ${TOP + BOX_H + 23} L ${xa + 4} ${TOP + BOX_H + 30} Z`} />
      <text x={(xa + xb) / 2} y={LOOP_Y + 13} textAnchor="middle">
        Repeats {loop.times} times
      </text>
    </g>
  )
}

/** Position of an item moving from step `from` to step `to` (-1 = start). Backward moves follow the loop line. */
function movePoint(from: number, to: number, p: number) {
  const fx = from < 0 ? 2 : x0(from) + BOX_W
  const tx = x0(to)
  if (to > from) return { x: fx + (tx - fx) * p, y: LINE_Y }
  const ax = x0(from) + BOX_W / 2
  const bx = x0(to) + BOX_W / 2
  return { x: ax + (bx - ax) * p, y: LOOP_Y }
}

function unitsText(step: Step, devices: Device[], phase: number): string {
  if (step.units && step.units.length) return `unit ${step.units.join('/')}`
  const counts = devices.map((d) => unitsInPhase(d, phase))
  if (counts.some((c) => c === null)) return ''
  const n = counts.reduce((sum, c) => sum + (c?.length ?? 0), 0)
  return n === 0 ? 'none yet' : n === 1 ? '' : `${n} units`
}

function partnerName(wf: Workflow, routeId: string, key: string, kind: 'join' | 'sync'): string {
  const other = wf.routes.find((r) => r.id !== routeId && r.steps.some((s) => s[kind] === key))
  return other?.name ?? 'partner'
}

function stepTooltip(step: Step, devices: Map<string, Device>, assumed: boolean): string {
  const lines = [stepName(step, devices)]
  if (assumed) lines.push('Time is an assumed value; set the measured time on the device.')
  for (const d of step.devices) {
    const note = devices.get(d)?.note
    if (note) lines.push(note)
  }
  return lines.join('\n')
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
