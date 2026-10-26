import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getExample, listExamples, simulate } from './lib/api'
import { buildTimelines, stateAt } from './lib/timeline'
import { asLabConfig } from './lib/storage'
import type { LabConfig, RunSettings, SimResult } from './lib/types'
import { LineSchematic, type Selection } from './components/LineSchematic'
import { Inspector } from './components/Inspector'
import { PlaybackBar, usePlayback } from './components/Playback'
import { Results } from './components/Results'
import { Samples } from './components/Samples'
import { Compare, type Baseline } from './components/Compare'
import { NumberField } from './components/fields'
import './App.css'

const LAB_KEY = 'axlr8.lab'
const RUN_KEY = 'axlr8.run'

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
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

type Tab = 'results' | 'samples' | 'compare'

export default function App() {
  const [lab, setLab] = useState<LabConfig | null>(() => asLabConfig(load<unknown>(LAB_KEY)))
  const [run, setRun] = useState<RunSettings>(
    () => load<RunSettings>(RUN_KEY) ?? { num_samples: 12, arrival_interval: 30, seed: 1 },
  )
  const [examples, setExamples] = useState<string[]>([])
  const [result, setResult] = useState<SimResult | null>(null)
  const [resultLab, setResultLab] = useState<string>('')
  const [selection, setSelection] = useState<Selection>({ kind: 'lab' })
  const [tab, setTab] = useState<Tab>('results')
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const sidePanel = useRef<HTMLElement>(null)
  const firstSelection = useRef(true)

  const makespan = result?.kpis.makespan ?? 0
  const pb = usePlayback(makespan)

  useEffect(() => {
    listExamples().then(setExamples).catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    if (lab === null) {
      getExample('simple_lab').then(setLab).catch((e: Error) => setError(e.message))
    }
  }, [lab])

  useEffect(() => {
    if (lab) save(LAB_KEY, lab)
  }, [lab])
  useEffect(() => save(RUN_KEY, run), [run])

  const timelines = useMemo(() => (result ? buildTimelines(result.events) : null), [result])
  const states = useMemo(() => (timelines ? stateAt(timelines, pb.t) : null), [timelines, pb.t])
  const stale = result !== null && lab !== null && JSON.stringify(lab) !== resultLab
  const { setPlaying } = pb

  // A run only describes the lab it was made from; stop replaying it once the lab changes.
  useEffect(() => {
    if (stale) setPlaying(false)
  }, [stale, setPlaying])

  // On narrow screens the settings panel sits below the line: bring it into view on selection.
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false
      return
    }
    if (window.matchMedia('(max-width: 960px)').matches) {
      sidePanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selection])

  const execute = useCallback(
    async (settings: RunSettings) => {
      if (!lab) return
      setBusy(true)
      setError(null)
      try {
        const res = await simulate(lab, settings)
        setResult(res)
        setResultLab(JSON.stringify(lab))
        pb.start(res.kpis.makespan)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [lab, pb],
  )

  const exportLab = () => {
    if (!lab) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(lab, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${lab.name.replace(/[^\w-]+/g, '_') || 'lab'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importLab = async (file: File) => {
    try {
      const parsed = asLabConfig(JSON.parse(await file.text()))
      if (!parsed) throw new Error('it has no stations, or a station is missing its id, name or time')
      setLab(parsed)
      setSelection({ kind: 'lab' })
      setResult(null)
    } catch (e) {
      setError(`Could not open ${file.name}: ${(e as Error).message}. Choose a lab file exported from AXLR8.`)
    }
  }

  const keepBaseline = () => {
    if (!result || !lab) return
    setBaseline({ label: `${lab.name}, ${result.kpis.num_samples} samples`, kpis: result.kpis })
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">AXLR8</h1>
        <span className="lab-name">{lab?.name ?? 'Loading lab…'}</span>
        <div className="topbar-actions">
          {examples.length > 0 && (
            <select
              aria-label="Open an example lab"
              value=""
              onChange={(e) => {
                const name = e.target.value
                if (!name) return
                getExample(name)
                  .then((l) => {
                    setLab(l)
                    setResult(null)
                    setSelection({ kind: 'lab' })
                  })
                  .catch((err: Error) => setError(err.message))
              }}
            >
              <option value="">Open example…</option>
              {examples.map((n) => (
                <option key={n} value={n}>
                  {n.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="quiet" onClick={() => fileInput.current?.click()}>
            Open file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importLab(f)
              e.target.value = ''
            }}
          />
          <button type="button" className="quiet" onClick={exportLab} disabled={!lab}>
            Save to file
          </button>
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          <pre>{error}</pre>
          <button type="button" className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="line-panel" aria-label="Lab line">
          <div className="runbar">
            <button type="button" className="go" disabled={!lab || busy} onClick={() => execute({ ...run, num_samples: 1 })}>
              GO
              <span className="go-sub">one sample</span>
            </button>
            <div className="run-settings">
              <NumberField label="Samples" integer min={1} max={2000} value={run.num_samples} onChange={(num_samples) => setRun({ ...run, num_samples })} />
              <NumberField label="Release one every" unit="s" min={0} value={run.arrival_interval} onChange={(arrival_interval) => setRun({ ...run, arrival_interval })} />
              <NumberField label="Random seed" integer min={0} value={run.seed ?? 0} onChange={(seed) => setRun({ ...run, seed })} />
            </div>
            <button type="button" className="primary" disabled={!lab || busy} onClick={() => execute(run)}>
              {busy ? 'Running…' : `Run ${run.num_samples} ${run.num_samples === 1 ? 'sample' : 'samples'}`}
            </button>
          </div>

          {lab ? (
            <LineSchematic lab={lab} states={stale ? null : states} kpis={stale ? null : (result?.kpis ?? null)} selection={selection} onSelect={setSelection} />
          ) : (
            <p className="hint pad">Loading the example lab…</p>
          )}

          {result && !stale && <PlaybackBar pb={pb} makespan={makespan} />}
          {stale && <p className="stale">You have changed the lab since the last run. Run again to see the effect; the results below are from the previous version.</p>}
          <StatusLegend />

          <div className="tabs" role="tablist" aria-label="Run details">
            {(['results', 'samples', 'compare'] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === 'results' ? 'Bottlenecks' : t === 'samples' ? 'Samples' : 'Compare runs'}
              </button>
            ))}
          </div>
          <div className="tab-body" role="tabpanel">
            {!result && tab !== 'compare' && (
              <p className="hint">Press GO to send one sample through, or run a batch of samples to find the bottleneck.</p>
            )}
            {result && lab && tab === 'results' && <Results lab={lab} kpis={result.kpis} events={result.events} t={pb.t} />}
            {result && lab && states && timelines && tab === 'samples' && (
              <Samples lab={lab} states={states} timelines={timelines} t={pb.t} />
            )}
            {tab === 'compare' && <Compare baseline={baseline} current={result?.kpis ?? null} onKeep={keepBaseline} />}
          </div>
        </section>

        <aside className="side-panel" ref={sidePanel}>
          {lab && <Inspector lab={lab} kpis={stale ? null : (result?.kpis ?? null)} selection={selection} onChange={setLab} onSelect={setSelection} />}
        </aside>
      </main>
    </div>
  )
}

function StatusLegend() {
  const items: [string, string][] = [
    ['queued', 'Queued'],
    ['processing', 'Processing'],
    ['moving', 'Moving'],
    ['waiting', 'Held or waiting for arm'],
  ]
  return (
    <ul className="legend status-legend" aria-label="Sample colours">
      {items.map(([k, v]) => (
        <li key={k}>
          <span className={`dot st-bg-${k}`} aria-hidden="true" />
          {v}
        </li>
      ))}
    </ul>
  )
}
