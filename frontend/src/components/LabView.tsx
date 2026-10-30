// The physical view: the 3D lab replaying the run, what goes wrong physically (arms clashing on the
// rail, moves the arms cannot make in time), and the editor for where each station stands.
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { autoPlacements, DEFAULT_PARAMS, overlaps, resolveLayout, toLayout, type ResolvedLayout } from '../lib/lab'
import { incubatorLevels, replay as replayRun, type Replay } from '../lib/physical'
import { fmtClock, fmtDuration, fmtPct } from '../lib/format'
import { optimise } from '../lib/api'
import type { Layout, OptimiseResult, RunSettings, SimResult, Workflow } from '../lib/types'
import type { Palette } from './Lab3D'
import { NumberField } from './fields'
import './LabView.css'

const Lab3D = lazy(() => import('./Lab3D'))
const OPTIMISE_SECONDS = 15

const GROUP_VARS: Record<string, string> = {
  'Crystallisation setup': '--grp-crystal',
  Soaking: '--grp-soak',
  'Seed stock generation': '--grp-seed',
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--bench', '#e8edf1'),
    floor: v('--panel-2', '#f4f7f9'),
    rule: v('--rule', '#cfd8df'),
    ink: v('--ink', '#13202b'),
    bench: v('--rule', '#cfd8df'),
    rail: v('--rule-strong', '#93a2ae'),
    arm: v('--panel', '#ffffff'),
    clash: v('--st-waiting', '#d1433b'),
    fixed: v('--deck-fixed', '#1d6f8c'),
    project: v('--deck-project', '#ec8a3e'),
    manual: v('--deck-manual', '#5ccf73'),
    waste: v('--deck-waste', '#fff35c'),
    groups: Object.fromEntries(Object.entries(GROUP_VARS).map(([g, name]) => [g, v(name, '#7d878e')])),
    fallback: v('--deck-optional', '#7d878e'),
  }
}

function usePalette() {
  const [palette, setPalette] = useState(readPalette)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setPalette(readPalette())
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return palette
}

interface Props {
  wf: Workflow
  phase: number
  run: RunSettings // the settings the optimiser scores layouts with
  result: SimResult | null // null when there is no run yet, or it is out of date
  t: number
  onSeek: (t: number) => void
  onChange: (wf: Workflow) => void
}

interface Optimising {
  busy: boolean
  result?: OptimiseResult
  undo?: Layout // the layout before the optimiser changed it
  error?: string
}

export function LabView({ wf, phase, run, result, t, onSeek, onChange }: Props) {
  const palette = usePalette()
  const [labels, setLabels] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const layout = useMemo(() => resolveLayout(wf), [wf])
  const rep = useMemo(() => replayRun(result?.events ?? [], layout, result?.rail ?? null), [result, layout])
  const levels = useMemo(() => incubatorLevels(wf, result?.events ?? []), [wf, result])
  const overlay = useRef<HTMLDivElement>(null)

  const save = (next: Partial<Layout>) => onChange({ ...wf, layout: { ...toLayout(layout), ...next } })
  const [opt, setOpt] = useState<Optimising>({ busy: false })
  const runOptimise = async () => {
    setOpt({ busy: true })
    const current = toLayout(layout)
    try {
      const widths = Object.fromEntries(layout.stations.map((s) => [s.key, s.fp.w]))
      const res = await optimise({ ...wf, layout: current }, run, widths, OPTIMISE_SECONDS)
      if (res.improved) onChange({ ...wf, layout: res.layout })
      setOpt({ busy: false, result: res, undo: res.improved ? current : undefined })
    } catch (e) {
      setOpt({ busy: false, error: (e as Error).message })
    }
  }
  const undo = () => {
    if (opt.undo) onChange({ ...wf, layout: opt.undo })
    setOpt({ busy: false })
  }

  return (
    <div className="lab-view">
      <div className="lab-canvas">
        <Suspense fallback={<p className="hint pad">Loading the 3D view…</p>}>
          <Lab3D
            wf={wf}
            layout={layout}
            replay={rep}
            t={result ? t : 0}
            phase={phase}
            palette={palette}
            labels={labels}
            selected={selected}
            onSelect={setSelected}
            levels={levels}
            overlay={overlay}
          />
        </Suspense>
        <div className="lab-overlay" ref={overlay} />
        <label className="lab-toggle">
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Names
        </label>
      </div>
      <p className="hint">
        Drag to turn, scroll to zoom, right-drag to pan. Faded stations are not bought in this phase. Click a station to move it.
      </p>

      <div className="lab-panels">
        <Findings result={result} rep={rep} layout={layout} t={t} onSeek={onSeek} />
        <LayoutEditor
          layout={layout}
          selected={selected}
          onSelect={setSelected}
          onSave={save}
          optimiser={<OptimisePanel opt={opt} run={run} onOptimise={runOptimise} onUndo={undo} />}
        />
      </div>
    </div>
  )
}

function Findings({ result, rep, layout, t, onSeek }: { result: SimResult | null; rep: Replay; layout: ResolvedLayout; t: number; onSeek: (t: number) => void }) {
  const [all, setAll] = useState(false)
  if (!result) return <section className="lab-findings"><h3>Rail</h3><p className="hint">Run the schedule to replay it on the rail.</p></section>
  const arms = rep.homes.length
  if (arms === 0) {
    return (
      <section className="lab-findings">
        <h3>Rail</h3>
        <p className="hint">This run has no cobots, so every move is by hand. Choose a phase or cobot count with arms to see them on the rail.</p>
      </section>
    )
  }
  const names = new Map(layout.stations.map((st) => [st.key, st.name]))
  const name = (k: string) => names.get(k) ?? k
  const makespan = result.kpis.makespan
  const waited = rep.blocked.reduce((sum, m) => sum + m.blocked, 0)
  const worst = [...rep.blocked].sort((a, b) => b.blocked - a.blocked)
  const shown = all ? worst : worst.slice(0, 8)
  const perArm = rep.homes.map((_, i) => {
    const mine = rep.moves.filter((m) => m.arm === i)
    // Moves carried over from the day before count from time 0.
    return { moves: mine.length, busy: makespan > 0 ? mine.reduce((sum, m) => sum + m.end - Math.max(0, m.start), 0) / makespan : 0 }
  })
  return (
    <section className="lab-findings">
      <h3>Rail</h3>
      <p>
        {arms} {arms === 1 ? 'arm' : 'arms'} on one {(rep.end - rep.start).toFixed(1)} m rail (it runs on past the end stations so
        the other arms can park), {rep.moves.length} cobot moves. The arms keep their order and stay {layout.min_separation} m apart, so
        they never pass each other: a move waits until its stretch of rail is clear, and idle arms stand aside.
      </p>
      <table className="lab-table">
        <thead>
          <tr><th>Arm</th><th>Moves</th><th>Busy</th></tr>
        </thead>
        <tbody>
          {perArm.map((a, i) => (
            <tr key={i}><td>Arm {i + 1}</td><td>{a.moves}</td><td>{fmtPct(a.busy)}</td></tr>
          ))}
        </tbody>
      </table>

      <h3>Held up by the rail</h3>
      {rep.blocked.length === 0 ? (
        <p>No move had to wait for another arm to get out of the way.</p>
      ) : (
        <>
          <p>
            <strong>
              {rep.blocked.length} {rep.blocked.length === 1 ? 'move' : 'moves'} waited {fmtDuration(waited)} in all
            </strong>{' '}
            with an arm free, because a busy arm was in the way. A free pool of cobots would not wait here; moving stations
            that work together closer to each other usually helps.
          </p>
          <table className="lab-table">
            <thead>
              <tr><th>Time</th><th>From</th><th>To</th><th>Waited</th><th>Arm</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((m, i) => (
                <tr key={i} className={m.start - m.blocked <= t && t <= m.end ? 'now' : undefined}>
                  <td>{fmtClock(m.start - m.blocked)}</td>
                  <td>{name(m.source)}</td>
                  <td>{name(m.target)}</td>
                  <td>{fmtDuration(m.blocked)}</td>
                  <td>{m.arm + 1}</td>
                  <td><button type="button" className="link" onClick={() => onSeek(m.start - m.blocked)}>Show</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rep.blocked.length > 8 && (
            <button type="button" className="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rep.blocked.length}`}</button>
          )}
        </>
      )}

      <h3>Move times</h3>
      {rep.stretched.length === 0 ? (
        <p>Every cobot move fits in the model's move time at {layout.rail_speed} m/s with {layout.handoff_time} s per pick or place.</p>
      ) : (
        <p>
          <strong>{rep.stretched.length} {rep.stretched.length === 1 ? 'move took' : 'moves took'} longer than the model's move time</strong>{' '}
          because of the distance driven at {layout.rail_speed} m/s with {layout.handoff_time} s per pick or place
          (longest {fmtDuration(Math.max(...rep.stretched.map((m) => m.need)))}).
        </p>
      )}

      {rep.clashes.length > 0 && (
        <p className="lab-warn" role="status">
          Check failed: arms came closer than {layout.min_separation} m {rep.clashes.length} times (first at {fmtClock(rep.clashes[0].start)}).
          This is a bug in the rail model; please report it.
        </p>
      )}
    </section>
  )
}

function OptimisePanel({ opt, run, onOptimise, onUndo }: { opt: Optimising; run: RunSettings; onOptimise: () => void; onUndo: () => void }) {
  const r = opt.result
  const arms = run.cobots === null ? 'the phase default number of' : String(run.cobots)
  return (
    <div className="lab-optimise">
      <button type="button" className="primary" disabled={opt.busy} onClick={onOptimise}>
        {opt.busy ? `Optimising… (up to ${OPTIMISE_SECONDS} s)` : 'Optimise'}
      </button>
      <p className="hint">
        Tries arrangements of the stations, each scored by simulating the day with the current day type, equipment
        and {arms} cobots: the time until the work finishes, plus the arms' moving time and the time moves wait for
        another arm on the rail. Stations are packed side by side, so none overlap. Each layout is scored on one day and
        one seed, whatever Days and Runs are set to, so there is time to try hundreds of layouts.
      </p>
      {opt.error && <p className="lab-warn" role="alert">{opt.error}</p>}
      {r && (
        <div role="status">
          <p>
            {r.improved ? 'Applied a better layout' : 'No better layout found'} after trying {r.evaluations} layouts in {r.seconds.toFixed(0)} s.
            {r.improved && ' Run the schedule again to replay it.'}
          </p>
          {r.improved && (
            <>
              <table className="lab-table">
                <thead>
                  <tr><th /><th>Before</th><th>After</th></tr>
                </thead>
                <tbody>
                  <tr><td>Work finishes after</td><td>{fmtDuration(r.before.makespan)}</td><td>{fmtDuration(r.after.makespan)}</td></tr>
                  <tr><td>Arms moving (all arms)</td><td>{fmtDuration(r.before.move_time)}</td><td>{fmtDuration(r.after.move_time)}</td></tr>
                  <tr><td>Waiting for the rail</td><td>{fmtDuration(r.before.blocked)} ({r.before.blocked_moves} moves)</td><td>{fmtDuration(r.after.blocked)} ({r.after.blocked_moves} moves)</td></tr>
                </tbody>
              </table>
              {opt.undo && <button type="button" className="quiet" onClick={onUndo}>Undo</button>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function LayoutEditor({ layout, selected, onSelect, onSave, optimiser }: {
  optimiser: ReactNode
  layout: ResolvedLayout
  selected: string | null
  onSelect: (s: string | null) => void
  onSave: (next: Partial<Layout>) => void
}) {
  const clash = overlaps(layout)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) list.current?.querySelector(`[data-station="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])
  const setPlacement = (station: string, change: { x?: number; side?: -1 | 1 }) =>
    onSave({ placements: layout.placements.map((p) => (p.station === station ? { ...p, ...change } : p)) })
  return (
    <section className="lab-layout">
      <h3>Layout</h3>
      <div className="lab-params">
        <NumberField label="Rail speed" unit="m/s" step={0.1} min={0.05} value={layout.rail_speed} onChange={(rail_speed) => onSave({ rail_speed })} />
        <NumberField label="Pick or place" unit="s" value={layout.handoff_time} onChange={(handoff_time) => onSave({ handoff_time })} />
        <NumberField label="Closest two arms may be" unit="m" step={0.05} min={0.1} value={layout.min_separation} onChange={(min_separation) => onSave({ min_separation })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={layout.return_home} onChange={(e) => onSave({ return_home: e.target.checked })} />
        Idle arms go back to their home position
      </label>
      <div className="button-row">
        <button type="button" className="quiet" onClick={() => onSave({ placements: autoPlacements(layout.stations) })}>Arrange automatically</button>
        <button type="button" className="quiet" onClick={() => onSave({ ...DEFAULT_PARAMS })}>Default arm settings</button>
      </div>
      {optimiser}
      {clash.length > 0 && (
        <p className="lab-warn" role="status">
          Overlapping stations: {clash.map(([a, b]) => `${a.name} and ${b.name}`).join('; ')}.
        </p>
      )}
      <div className="lab-stations" ref={list}>
        <table className="lab-table">
          <thead>
            <tr><th>Station</th><th>Along rail (m)</th><th>Side</th></tr>
          </thead>
          <tbody>
            {layout.stations.map((s) => {
              const p = layout.at.get(s.key)!
              return (
                <tr key={s.key} data-station={s.key} className={selected === s.key ? 'now' : undefined} onClick={() => onSelect(s.key)}>
                  <td>{s.name}</td>
                  <td>
                    <input
                      type="number"
                      aria-label={`${s.name} position along the rail`}
                      step={0.05}
                      min={0}
                      defaultValue={p.x}
                      key={p.x}
                      onBlur={(e) => {
                        const x = Number(e.target.value)
                        if (Number.isFinite(x) && x >= 0 && x !== p.x) setPlacement(s.key, { x })
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                  </td>
                  <td>
                    <select aria-label={`${s.name} side of the rail`} value={p.side} onChange={(e) => setPlacement(s.key, { side: Number(e.target.value) as -1 | 1 })}>
                      <option value={1}>Front</option>
                      <option value={-1}>Back</option>
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
