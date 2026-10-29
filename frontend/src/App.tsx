import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getExample, simulate } from './lib/api'
import { buildTimelines, stateAt } from './lib/timeline'
import { asWorkflow, WF_KEY } from './lib/storage'
import { DAY_LABEL, PHASES, routeScenario, type DayType, type RunSettings, type SimResult, type Workflow } from './lib/types'
import { WorkflowMap, stepName, type Selection } from './components/WorkflowMap'
import { Inspector } from './components/Inspector'
import { PlaybackBar, usePlayback } from './components/Playback'
import { Bottlenecks, DaysTable, RoutesTable } from './components/Results'
import { Items } from './components/Items'
import { Compare, type Baseline } from './components/Compare'
import { NumberField } from './components/fields'
import { LabView } from './components/LabView'
import { DataView } from './components/DataView'
import { resolveLayout, toLayout } from './lib/lab'
import './App.css'

const RUN_KEY = 'axlr8.run.v2'
const DEFAULT_RUN: RunSettings = {
  scenario: 'run', day_length: 24 * 3600, days: 1, time_variation: 0, runs: 1, phase: 4, cobots: null, single: false, seed: 1,
}

function load(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: nothing to persist */
  }
}

type View = 'map' | 'lab' | 'data'
const VIEW_LABEL: Record<View, string> = { map: 'Workflow map', lab: '3D lab', data: 'Lab data' }

/** Days actually simulated: a follow-on day is always two. */
const daysOf = (run: RunSettings) => (run.scenario === 'follow_on' ? 2 : run.days)

const runKey = (wf: Workflow | null, run: RunSettings) =>
  JSON.stringify([
    wf, run.scenario, daysOf(run) > 1 ? run.day_length : null, daysOf(run), run.time_variation, run.runs, run.phase, run.cobots, run.seed,
  ])

type Tab = 'bottlenecks' | 'days' | 'routes' | 'items' | 'compare'
const TAB_LABEL: Record<Tab, string> = {
  bottlenecks: 'Bottlenecks',
  days: 'Days',
  routes: 'Routes',
  items: 'Items',
  compare: 'Compare runs',
}

export default function App() {
  const [wf, setWf] = useState<Workflow | null>(() => asWorkflow(load(WF_KEY)))
  const [run, setRun] = useState<RunSettings>(() => ({ ...DEFAULT_RUN, ...((load(RUN_KEY) as RunSettings | null) ?? {}), single: false }))
  const [result, setResult] = useState<SimResult | null>(null)
  const [resultKey, setResultKey] = useState('')
  const [selection, setSelection] = useState<Selection>({ kind: 'overview' })
  const [tab, setTab] = useState<Tab>('bottlenecks')
  const [view, setView] = useState<View>('map')
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const sidePanel = useRef<HTMLElement>(null)
  const firstSelection = useRef(true)

  const makespan = result?.kpis.makespan ?? 0
  const pb = usePlayback(makespan)
  const { setPlaying } = pb

  useEffect(() => {
    if (wf === null) getExample('axl_workflow').then(setWf).catch((e: Error) => setError(e.message))
  }, [wf])
  useEffect(() => {
    if (wf) save(WF_KEY, wf)
  }, [wf])
  useEffect(() => save(RUN_KEY, run), [run])

  const settingsKey = runKey(wf, run)
  const stale = result !== null && settingsKey !== resultKey
  useEffect(() => {
    if (stale) setPlaying(false)
  }, [stale, setPlaying])

  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false
      return
    }
    if (window.matchMedia('(max-width: 1100px)').matches) {
      sidePanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selection])

  // Items from the day before a follow-on day that finished before it are left out of the map and item list.
  const timelines = useMemo(() => {
    if (!result) return null
    const doneBefore = new Set(result.events.filter((e) => e.kind === 'completed' && e.t < 0 && !e.device).map((e) => e.item))
    return buildTimelines(doneBefore.size ? result.events.filter((e) => !doneBefore.has(e.item)) : result.events)
  }, [result])
  const states = useMemo(() => (timelines ? stateAt(timelines, pb.t) : null), [timelines, pb.t])

  const execute = useCallback(
    async (single: boolean) => {
      if (!wf) return
      setBusy(true)
      setError(null)
      try {
        // The engine drives the arms along the rail, so it needs every station placed.
        const res = await simulate({ ...wf, layout: toLayout(resolveLayout(wf)) }, { ...run, single })
        setResult(res)
        setResultKey(runKey(wf, run))
        pb.start()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [wf, run, pb],
  )

  const exportWf = () => {
    if (!wf) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${wf.name.replace(/[^\w-]+/g, '_') || 'workflow'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importWf = async (file: File) => {
    try {
      const parsed = asWorkflow(JSON.parse(await file.text()))
      if (!parsed) throw new Error('it is not an AXLR8 workflow (it needs devices and routes)')
      setWf(parsed)
      setSelection({ kind: 'overview' })
      setResult(null)
    } catch (e) {
      setError(`Could not open ${file.name}: ${(e as Error).message}.`)
    }
  }

  const resetToDeck = () => {
    getExample('axl_workflow')
      .then((w) => {
        setWf(w)
        setResult(null)
        setSelection({ kind: 'overview' })
      })
      .catch((e: Error) => setError(e.message))
  }

  const keepBaseline = () => {
    if (!result || !wf) return
    const phase = PHASES.find((p) => p.value === run.phase)?.label.split(' (')[0] ?? `Phase ${run.phase}`
    setBaseline({ label: `${DAY_LABEL[run.scenario]}, ${phase}`, kpis: result.kpis })
  }

  const defaultCobots = wf?.cobots_by_phase[String(run.phase)] ?? 0
  const stuck = !stale ? (result?.kpis.stuck ?? []) : []
  const devices = new Map(wf?.devices.map((d) => [d.id, d]) ?? [])

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">AXLR8</h1>
        <span className="lab-name">{wf?.name ?? 'Loading workflow…'}</span>
        <div className="topbar-actions">
          <button type="button" className="quiet" onClick={resetToDeck}>Reset to deck</button>
          <button type="button" className="quiet" onClick={() => fileInput.current?.click()}>Open file</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importWf(f)
              e.target.value = ''
            }}
          />
          <button type="button" className="quiet" onClick={exportWf} disabled={!wf}>Save to file</button>
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          <pre>{error}</pre>
          <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <main className="workspace">
        <section className="line-panel" aria-label="Workflow">
          <div className="runbar">
            <button type="button" className="go" disabled={!wf || busy} onClick={() => execute(true)}>
              GO
              <span className="go-sub">one of each</span>
            </button>
            <div className="run-settings">
              <div className="field">
                <span className="field-label" id="scenario-label">Day type</span>
                <div className="segmented" role="radiogroup" aria-labelledby="scenario-label">
                  {(['run', 'follow_on', 'shutdown'] as DayType[]).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={run.scenario === s} onClick={() => setRun({ ...run, scenario: s })}>
                      {DAY_LABEL[s]}
                    </button>
                  ))}
                </div>
              </div>
              {run.scenario !== 'follow_on' && (
                <NumberField label="Days" integer min={1} max={30} value={run.days} onChange={(days) => setRun({ ...run, days })} />
              )}
              {daysOf(run) > 1 && (
                <NumberField
                  label={run.scenario === 'follow_on' ? 'Day 2 starts after' : 'Each day starts after'}
                  unit="h"
                  min={0.5}
                  max={168}
                  step={0.5}
                  value={run.day_length / 3600}
                  onChange={(h) => setRun({ ...run, day_length: h * 3600 })}
                />
              )}
              <label className="field">
                <span className="field-label">Equipment</span>
                <select value={run.phase} onChange={(e) => setRun({ ...run, phase: Number(e.target.value) })}>
                  {PHASES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Cobots</span>
                <select
                  value={run.cobots === null ? '' : String(run.cobots)}
                  onChange={(e) => setRun({ ...run, cobots: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  <option value="">Phase default ({defaultCobots})</option>
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? 'None (manual moves)' : n}</option>)}
                </select>
              </label>
              <NumberField label="Random seed" integer min={0} value={run.seed ?? 0} onChange={(seed) => setRun({ ...run, seed })} />
              <NumberField
                label="Runs (seeds)"
                integer
                min={1}
                max={50}
                value={run.runs}
                onChange={(runs) => setRun({ ...run, runs, time_variation: runs > 1 && run.runs === 1 && run.time_variation === 0 ? 0.1 : run.time_variation })}
              />
              <NumberField
                label="Time variation"
                unit="± %"
                min={0}
                max={50}
                value={Math.round(run.time_variation * 100)}
                onChange={(p) => setRun({ ...run, time_variation: p / 100 })}
              />
            </div>
            <button type="button" className="primary" disabled={!wf || busy} onClick={() => execute(false)}>
              {busy ? 'Running…' : `Run ${DAY_LABEL[run.scenario].toLowerCase().replace(' ', '-')} schedule`}
            </button>
          </div>

          {result && !stale && wf && (result.kpis.skipped.length > 0 || result.kpis.warnings.length > 0) && (
            <div className="notice" role="status">
              {result.kpis.skipped.length > 0 && (
                <p>
                  <strong>Not possible with this equipment:</strong>{' '}
                  {result.kpis.skipped
                    .map((sk) => `${wf.routes.find((r) => r.id === sk.route)?.name ?? sk.route} (${sk.reason})`)
                    .join('; ')}
                  .
                </p>
              )}
              {result.kpis.warnings.map((w) => (
                <p key={w}>{w}.</p>
              ))}
            </div>
          )}

          {stuck.length > 0 && wf && (
            <div className="stuck" role="status">
              <strong>{stuck.length} {stuck.length === 1 ? 'item never finished' : 'items never finished'}.</strong>{' '}
              {stuck.slice(0, 3).map((s) => {
                const r = wf.routes.find((x) => x.id === s.route)
                const st = r?.steps[s.step]
                return `${r?.name ?? s.route} item ${s.item} is still at ${st ? stepName(st, devices) : 'the start'}`
              }).join('; ')}
              {stuck.length > 3 ? '; …' : '.'} Usually a meeting point has more items on one side than the other: check
              the item counts and repeats of the routes that meet.
            </div>
          )}

          <div className="segmented view-switch" role="radiogroup" aria-label="View">
            {(['map', 'lab', 'data'] as View[]).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>

          {wf && view === 'data' ? (
            <DataView wf={{ ...wf, layout: toLayout(resolveLayout(wf)) }} run={run} />
          ) : wf && view === 'lab' ? (
            <LabView
              wf={wf}
              phase={run.phase}
              run={run}
              result={stale ? null : result}
              t={pb.t}
              onSeek={(t) => {
                pb.setPlaying(false)
                pb.setT(t)
              }}
              onChange={setWf}
            />
          ) : wf ? (
            <WorkflowMap
              wf={wf}
              phase={run.phase}
              scenario={routeScenario(run.scenario)}
              states={stale ? null : states}
              kpis={stale ? null : (result?.kpis ?? null)}
              selection={selection}
              onSelect={setSelection}
            />
          ) : (
            <p className="hint pad">Loading the AXL workflow…</p>
          )}

          {result && !stale && <PlaybackBar pb={pb} makespan={makespan} />}
          {stale && <p className="stale">Settings have changed since the last run. Run again to see the effect; the tables below are from the previous run.</p>}
          {view === 'map' && <MapLegend />}

          <div className="tabs" role="tablist" aria-label="Run details">
            {(Object.keys(TAB_LABEL) as Tab[]).filter((t) => t !== 'days' || (result?.kpis.days.length ?? 0) > 0).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="tab-body" role="tabpanel">
            {!result && tab !== 'compare' && (
              <p className="hint">
                Press GO to send one item down every route, or run the full day schedule to find the bottleneck.
              </p>
            )}
            {result && wf && tab === 'bottlenecks' && (
              <Bottlenecks wf={wf} kpis={result.kpis} events={result.events} t={pb.t} onSelect={setSelection} ranges={result.ranges ?? null} />
            )}
            {result && wf && tab === 'days' && <DaysTable kpis={result.kpis} />}
            {result && wf && tab === 'routes' && (
              <RoutesTable wf={wf} kpis={result.kpis} events={result.events} t={pb.t} onSelect={setSelection} ranges={result.ranges ?? null} />
            )}
            {result && wf && states && tab === 'items' && <Items wf={wf} states={states} t={pb.t} />}
            {tab === 'compare' && <Compare baseline={baseline} current={result?.kpis ?? null} onKeep={keepBaseline} />}
          </div>
        </section>

        <aside className="side-panel" ref={sidePanel}>
          {wf && (
            <Inspector
              wf={wf}
              phase={run.phase}
              kpis={stale ? null : (result?.kpis ?? null)}
              selection={selection}
              onChange={setWf}
              onSelect={setSelection}
            />
          )}
        </aside>
      </main>
    </div>
  )
}

function MapLegend() {
  const boxes: [string, string][] = [
    ['fixed', 'Fixed timing'],
    ['project', 'Project-specific timing'],
    ['manual', 'Manual access point'],
    ['optional', 'Optional step'],
    ['join', 'Meeting point (convergence)'],
  ]
  const items: [string, string][] = [
    ['queued', 'Queued'],
    ['processing', 'Processing'],
    ['moving', 'Moving'],
    ['waiting', 'Waiting for a cobot'],
    ['dwelling', 'Incubating'],
  ]
  return (
    <div className="map-legend">
      <ul className="legend" aria-label="Box colours">
        {boxes.map(([k, v]) => (
          <li key={k}><span className={`box-swatch ${k}`} aria-hidden="true" />{v}</li>
        ))}
        <li><span className="hint">? = assumed time, not in the deck</span></li>
      </ul>
      <ul className="legend" aria-label="Item colours">
        {items.map(([k, v]) => (
          <li key={k}><span className={`dot st-bg-${k}`} aria-hidden="true" />{v}</li>
        ))}
      </ul>
    </div>
  )
}
