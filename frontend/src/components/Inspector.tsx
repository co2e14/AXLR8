import {
  addDevice, addRoute, deviceUsage, insertStep, moveStep, removeDevice, removeRoute, removeStep, updateDevice,
  updateRoute, updateStep,
} from '../lib/workflowOps'
import { fmtCompact, fmtDuration, fmtPct } from '../lib/format'
import {
  unitsInPhase, type Device, type DeviceKind, type Kpis, type Route, type Scenario, type Step, type Timing,
  type Transport, type Workflow,
} from '../lib/types'
import { NumberField, TextField, TimeField } from './fields'
import { releaseText, stepName, type Selection } from './WorkflowMap'

interface Props {
  wf: Workflow
  phase: number
  kpis: Kpis | null
  selection: Selection
  onChange: (wf: Workflow) => void
  onSelect: (s: Selection) => void
}

const TIMING_LABEL: Record<Timing, string> = {
  fixed: 'Fixed (from the deck or measured)',
  project: 'Project-specific',
  assumed: 'Assumed, needs measuring',
}

const TRANSPORT_LABEL: Record<Transport, string> = {
  cobot: 'Cobot move',
  linked: 'Linked device (no move)',
  manual: 'Manual (person)',
}

const KIND_LABEL: Record<DeviceKind, string> = {
  process: 'Process device',
  storage: 'Storage',
  manual: 'Manual access point',
  waste: 'Waste',
}

export function Inspector(props: Props) {
  const { selection, wf } = props
  if (selection.kind === 'device') {
    const d = wf.devices.find((x) => x.id === selection.id)
    if (d) return <DevicePanel {...props} device={d} />
  }
  if (selection.kind === 'route') {
    const r = wf.routes.find((x) => x.id === selection.id)
    if (r) return <RoutePanel {...props} route={r} />
  }
  if (selection.kind === 'step') {
    const r = wf.routes.find((x) => x.id === selection.route)
    if (r && r.steps[selection.index]) return <StepPanel {...props} route={r} index={selection.index} />
  }
  return <Overview {...props} />
}

function Back({ onSelect, to, label }: { onSelect: Props['onSelect']; to: Selection; label: string }) {
  return (
    <button type="button" className="link" onClick={() => onSelect(to)}>
      {label}
    </button>
  )
}

// ---------------------------------------------------------------- overview

function Overview({ wf, phase, kpis, onChange, onSelect }: Props) {
  const util = (id: string) => kpis?.devices.find((d) => d.id === id)?.utilisation
  return (
    <section className="inspector" aria-label="Workflow settings">
      <TextField label="Workflow name" value={wf.name} onChange={(name) => onChange({ ...wf, name })} />
      <p className="hint">Select a box on the map to edit that step, a route name to edit the route, or a device below.</p>

      <h3>Cobots</h3>
      <TimeField label="Cobot move time (pick, travel, place)" spec={wf.move_time} onChange={(move_time) => onChange({ ...wf, move_time })} />
      <div className="field-row three">
        {[2, 3, 4].map((p) => (
          <NumberField
            key={p}
            label={`Phase ${p} cobots`}
            integer
            min={0}
            max={20}
            value={wf.cobots_by_phase[String(p)] ?? 0}
            onChange={(n) => onChange({ ...wf, cobots_by_phase: { ...wf.cobots_by_phase, [String(p)]: n } })}
          />
        ))}
      </div>

      <h3>Devices</h3>
      <table className="mini-table">
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col" className="num">Units</th>
            <th scope="col" className="num">Time</th>
            {kpis && <th scope="col" className="num">Busy</th>}
          </tr>
        </thead>
        <tbody>
          {wf.devices.map((d) => {
            const units = unitsInPhase(d, phase)
            const u = util(d.id)
            return (
              <tr key={d.id}>
                <th scope="row">
                  <button type="button" className="link" onClick={() => onSelect({ kind: 'device', id: d.id })}>
                    {d.name}
                  </button>
                </th>
                <td className={`num${units?.length === 0 ? ' muted' : ''}`}>{units === null ? 'any' : units.length}</td>
                <td className="num">
                  {fmtCompact(d.time.value)}
                  {d.timing === 'assumed' && <span title="Assumed value"> ?</span>}
                </td>
                {kpis && <td className="num">{u == null ? '' : fmtPct(u)}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="hint">A ? marks an assumed time that is not in the deck.</p>
      <button type="button" onClick={() => {
        const next = addDevice(wf)
        onChange(next)
        onSelect({ kind: 'device', id: next.devices[next.devices.length - 1].id })
      }}>
        Add device
      </button>

      <h3>Routes</h3>
      <ul className="route-list">
        {wf.routes.map((r) => (
          <li key={r.id}>
            <input
              type="checkbox"
              aria-label={`Run ${r.name}`}
              checked={r.enabled}
              onChange={(e) => onChange(updateRoute(wf, r.id, { enabled: e.target.checked }))}
            />
            <button type="button" className="link" onClick={() => onSelect({ kind: 'route', id: r.id })}>
              {r.name}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => {
        const next = addRoute(wf)
        onChange(next)
        onSelect({ kind: 'route', id: next.routes[next.routes.length - 1].id })
      }}>
        Add route
      </button>
    </section>
  )
}

// ---------------------------------------------------------------- device

function DevicePanel({ wf, phase, kpis, onChange, onSelect, device: d }: Props & { device: Device }) {
  const set = (patch: Partial<Device>) => onChange(updateDevice(wf, d.id, patch))
  const used = deviceUsage(wf, d.id)
  const stats = kpis?.devices.find((x) => x.id === d.id)
  const phases = d.unit_phases
  return (
    <section className="inspector" aria-label="Device settings">
      <Back onSelect={onSelect} to={{ kind: 'overview' }} label="Back to overview" />
      <h2>{d.name}</h2>
      {d.note && <p className="hint">{d.note}</p>}
      <TextField label="Name" value={d.name} onChange={(name) => set({ name })} />
      <label className="field">
        <span className="field-label">Type</span>
        <select value={d.kind} onChange={(e) => set({ kind: e.target.value as DeviceKind })}>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <TimeField label="Time per use" spec={d.time} onChange={(time) => set({ time })} />
      <label className="field">
        <span className="field-label">Where the time comes from</span>
        <select value={d.timing} onChange={(e) => set({ timing: e.target.value as Timing })}>
          {Object.entries(TIMING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>

      <h3>Units</h3>
      <label className="check">
        <input type="checkbox" checked={phases === null} onChange={(e) => set({ unit_phases: e.target.checked ? null : [1] })} />
        Unlimited (manual access point, waste, LN2)
      </label>
      {phases !== null && (
        <>
          <ol className="unit-list">
            {phases.map((p, i) => (
              <li key={i}>
                <label>
                  Arrives in
                  <select
                    value={p}
                    onChange={(e) => set({ unit_phases: phases.map((x, j) => (j === i ? Number(e.target.value) : x)) })}
                  >
                    {[1, 2, 3, 4].map((n) => <option key={n} value={n}>Phase {n}</option>)}
                  </select>
                </label>
                {p > phase && <span className="hint">not in phase {phase}</span>}
                <button type="button" className="link danger" onClick={() => set({ unit_phases: phases.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => set({ unit_phases: [...phases, phase] })}>Add unit</button>
        </>
      )}

      {stats && (
        <dl className="stat-list">
          <dt>Busy</dt>
          <dd>{stats.utilisation == null ? 'unlimited' : fmtPct(stats.utilisation)}</dd>
          <dt>Holding finished items</dt>
          <dd>{fmtPct(stats.blocked_fraction)}</dd>
          <dt>Uses</dt>
          <dd>{stats.uses}</dd>
          <dt>Average wait for it</dt>
          <dd>{fmtDuration(stats.avg_wait)}</dd>
          <dt>Longest queue</dt>
          <dd>{stats.max_queue}</dd>
          {Object.entries(stats.unit_utilisation).map(([u, v]) => (
            <FragmentRow key={u} label={`Unit ${u} busy`} value={fmtPct(v)} />
          ))}
        </dl>
      )}

      <h3>Used in</h3>
      {used.length === 0 ? (
        <p className="hint">No route uses this device.</p>
      ) : (
        <ul className="route-list">
          {used.map((id) => (
            <li key={id}>
              <button type="button" className="link" onClick={() => onSelect({ kind: 'route', id })}>
                {wf.routes.find((r) => r.id === id)?.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="danger"
        disabled={used.length > 0}
        title={used.length > 0 ? 'Remove it from every route first' : undefined}
        onClick={() => {
          onChange(removeDevice(wf, d.id))
          onSelect({ kind: 'overview' })
        }}
      >
        Remove device
      </button>
    </section>
  )
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

// ---------------------------------------------------------------- route

function RoutePanel({ wf, kpis, onChange, onSelect, route: r }: Props & { route: Route }) {
  const set = (patch: Partial<Route>) => onChange(updateRoute(wf, r.id, patch))
  const devices = new Map(wf.devices.map((d) => [d.id, d]))
  const stats = kpis?.routes.find((x) => x.id === r.id)
  const toggleScenario = (s: Scenario, on: boolean) =>
    set({ scenarios: on ? [...new Set([...r.scenarios, s])] : r.scenarios.filter((x) => x !== s) })
  return (
    <section className="inspector" aria-label="Route settings">
      <Back onSelect={onSelect} to={{ kind: 'overview' }} label="Back to overview" />
      <h2>{r.name}</h2>
      <p className="hint">{releaseText(r)}</p>
      <TextField label="Name" value={r.name} onChange={(name) => set({ name })} />
      <div className="field-row">
        <TextField label="Group" value={r.group} onChange={(group) => set({ group })} />
        <TextField label="Labware" value={r.labware} onChange={(labware) => set({ labware })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Run this route
      </label>
      <fieldset className="plain">
        <legend>Active on</legend>
        <label className="check">
          <input type="checkbox" checked={r.scenarios.includes('run')} onChange={(e) => toggleScenario('run', e.target.checked)} />
          Run days
        </label>
        <label className="check">
          <input type="checkbox" checked={r.scenarios.includes('shutdown')} onChange={(e) => toggleScenario('shutdown', e.target.checked)} />
          Shutdown days
        </label>
      </fieldset>

      <h3>Releases</h3>
      <div className="field-row three">
        <NumberField label="Items" integer min={0} max={500} value={r.count} onChange={(count) => set({ count })} />
        <NumberField label="Every" unit="s" min={0} value={r.interval} onChange={(interval) => set({ interval })} />
        <NumberField label="First at" unit="s" min={0} value={r.offset} onChange={(offset) => set({ offset })} />
      </div>
      <p className="hint">0 items means the route is only fed by another route (for example pins from the X-ACT).</p>

      <h3>Steps</h3>
      <ol className="step-list">
        {r.steps.map((s, i) => (
          <li key={i} className={s.enabled ? undefined : 'muted'}>
            <button type="button" className="link" onClick={() => onSelect({ kind: 'step', route: r.id, index: i })}>
              {stepName(s, devices)}
            </button>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => onChange(insertStep(wf, r.id, r.steps.length - 1))}>Add step at the end</button>

      <h3>Repeat</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={r.loop !== null}
          onChange={(e) => set({ loop: e.target.checked ? { start: 0, end: r.steps.length - 1, times: 2 } : null })}
        />
        Repeat a block of steps (batch mode, reused plates)
      </label>
      {r.loop && (
        <div className="field-row three">
          <label className="field">
            <span className="field-label">From</span>
            <select value={r.loop.start} onChange={(e) => set({ loop: { ...r.loop!, start: Number(e.target.value), end: Math.max(r.loop!.end, Number(e.target.value)) } })}>
              {r.steps.map((s, i) => <option key={i} value={i}>{i + 1}. {stepName(s, devices)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <select value={r.loop.end} onChange={(e) => set({ loop: { ...r.loop!, end: Number(e.target.value), start: Math.min(r.loop!.start, Number(e.target.value)) } })}>
              {r.steps.map((s, i) => <option key={i} value={i}>{i + 1}. {stepName(s, devices)}</option>)}
            </select>
          </label>
          <NumberField label="Times" integer min={1} max={200} value={r.loop.times} onChange={(times) => set({ loop: { ...r.loop!, times } })} />
        </div>
      )}

      {stats && (
        <dl className="stat-list">
          <dt>Finished</dt>
          <dd>{stats.completed} of {stats.released}</dd>
          <dt>Average time on the route</dt>
          <dd>{stats.avg_cycle_time == null ? '—' : fmtDuration(stats.avg_cycle_time)}</dd>
          {stats.keeps_up !== null && (
            <FragmentRow label="Keeps up with releases" value={stats.keeps_up ? 'Yes' : 'No, items wait longer and longer'} />
          )}
        </dl>
      )}

      <button
        type="button"
        className="danger"
        disabled={wf.routes.length === 1}
        onClick={() => {
          onChange(removeRoute(wf, r.id))
          onSelect({ kind: 'overview' })
        }}
      >
        Remove route
      </button>
    </section>
  )
}

// ---------------------------------------------------------------- step

function StepPanel({ wf, phase, onChange, onSelect, route: r, index }: Props & { route: Route; index: number }) {
  const s = r.steps[index]
  const devices = new Map(wf.devices.map((d) => [d.id, d]))
  const set = (patch: Partial<Step>) => onChange(updateStep(wf, r.id, index, patch))
  const first = devices.get(s.devices[0])
  const allUnits = s.devices.length === 1 && first?.unit_phases ? first.unit_phases.map((_, i) => i + 1) : null
  const available = first ? unitsInPhase(first, phase) : null
  const partner = s.join ? wf.routes.find((x) => x.id !== r.id && x.steps.some((y) => y.join === s.join)) : undefined
  const syncPartner = s.sync ? wf.routes.find((x) => x.id !== r.id && x.steps.some((y) => y.sync === s.sync)) : undefined
  const select = (i: number) => onSelect({ kind: 'step', route: r.id, index: i })

  return (
    <section className="inspector" aria-label="Step settings">
      <Back onSelect={onSelect} to={{ kind: 'route', id: r.id }} label={`Back to ${r.name}`} />
      <h2>{stepName(s, devices)}</h2>
      <p className="hint">Step {index + 1} of {r.steps.length} in {r.name}</p>

      <fieldset className="plain">
        <legend>Device</legend>
        <ul className="device-chips">
          {s.devices.map((id) => (
            <li key={id}>
              <button type="button" className="link" onClick={() => onSelect({ kind: 'device', id })}>
                {devices.get(id)?.name ?? id}
              </button>
              {s.devices.length > 1 && (
                <button type="button" className="link danger" aria-label={`Remove ${devices.get(id)?.name}`} onClick={() => set({ devices: s.devices.filter((x) => x !== id), units: null })}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <label className="field">
          <span className="field-label">{s.devices.length === 1 ? 'Change device, or add an alternative' : 'Add an alternative'}</span>
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value
              if (!id) return
              if (id.startsWith('replace:')) set({ devices: [id.slice(8)], units: null })
              else set({ devices: [...s.devices, id], units: null })
            }}
          >
            <option value="">Choose…</option>
            {s.devices.length === 1 && (
              <optgroup label="Replace with">
                {wf.devices.filter((d) => d.id !== s.devices[0]).map((d) => <option key={d.id} value={`replace:${d.id}`}>{d.name}</option>)}
              </optgroup>
            )}
            <optgroup label="Also allow">
              {wf.devices.filter((d) => !s.devices.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </optgroup>
          </select>
        </label>
        {allUnits && allUnits.length > 1 && (
          <div className="unit-pins">
            <span className="field-label">Only use units (none ticked = any free unit)</span>
            {allUnits.map((u) => (
              <label key={u} className="check inline">
                <input
                  type="checkbox"
                  checked={s.units?.includes(u) ?? false}
                  onChange={(e) => {
                    const next = e.target.checked ? [...(s.units ?? []), u].sort((a, b) => a - b) : (s.units ?? []).filter((x) => x !== u)
                    set({ units: next.length ? next : null })
                  }}
                />
                {u}
                {available && !available.includes(u) ? ' (later phase)' : ''}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <TextField label="Label on the map (optional)" value={s.label ?? ''} onChange={(label) => set({ label: label || null })} />

      <label className="field">
        <span className="field-label">How the item gets here</span>
        <select value={s.transport} onChange={(e) => set({ transport: e.target.value as Transport })}>
          {Object.entries(TRANSPORT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={s.time !== null}
          onChange={(e) => set({ time: e.target.checked ? { ...(first?.time ?? { value: 60, kind: 'fixed', spread: 0 }) } : null })}
        />
        Use a different time from the device ({first ? fmtCompact(first.time.value) : '—'})
      </label>
      {s.time && <TimeField label="Time for this step" spec={s.time} onChange={(time) => set({ time })} />}
      <label className="field">
        <span className="field-label">Where this step's time comes from</span>
        <select value={s.timing ?? ''} onChange={(e) => set({ timing: (e.target.value || null) as Timing | null })}>
          <option value="">Same as the device</option>
          {Object.entries(TIMING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={s.dwell !== null}
          onChange={(e) => set({ dwell: e.target.checked ? { value: 3600, kind: 'fixed', spread: 0 } : null })}
        />
        Wait afterwards without holding the device (incubation)
      </label>
      {s.dwell && <TimeField label="Waiting time" spec={s.dwell} onChange={(dwell) => set({ dwell })} />}

      <label className="check">
        <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Step is switched on
      </label>
      <label className="check">
        <input type="checkbox" checked={s.optional} onChange={(e) => set({ optional: e.target.checked })} />
        Optional (skipped when its device is not bought yet)
      </label>

      <h3>Meets another route</h3>
      <TextField label="Meeting point name" value={s.join ?? ''} onChange={(join) => set({ join: join || null })} />
      <p className="hint">
        {s.join
          ? partner
            ? `Waits here for an item from ${partner.name}; both are processed together.`
            : 'No other route uses this meeting point yet. Give a step in the partner route the same name.'
          : 'Give two steps in different routes the same name to make items meet there (for example the Echo soak).'}
      </p>

      <h3>Starts together with another route</h3>
      <TextField label="Start point name" value={s.sync ?? ''} onChange={(sync) => set({ sync: sync || null })} />
      <p className="hint">
        {s.sync
          ? syncPartner
            ? `Waits here until an item from ${syncPartner.name} arrives at its matching step, then each carries on separately.`
            : 'No other route uses this start point yet.'
          : 'Use this to keep paired items in step, for example a compound plate that only leaves storage when its crystal plate does.'}
      </p>

      <h3>Starts other items</h3>
      {s.spawn.map((sp, k) => (
        <div key={k} className="field-row spawn-row">
          <label className="field">
            <span className="field-label">Route</span>
            <select value={sp.route} onChange={(e) => set({ spawn: s.spawn.map((x, j) => (j === k ? { ...x, route: e.target.value } : x)) })}>
              {wf.routes.filter((x) => x.id !== r.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <NumberField label="How many" integer min={1} max={100} value={sp.count} onChange={(count) => set({ spawn: s.spawn.map((x, j) => (j === k ? { ...x, count } : x)) })} />
          <button type="button" className="link danger" onClick={() => set({ spawn: s.spawn.filter((_, j) => j !== k) })}>Remove</button>
        </div>
      ))}
      <button
        type="button"
        disabled={wf.routes.length < 2}
        onClick={() => set({ spawn: [...s.spawn, { route: wf.routes.find((x) => x.id !== r.id)!.id, count: 1 }] })}
      >
        Start items on another route
      </button>

      <div className="button-row">
        <button type="button" disabled={index === 0} onClick={() => { onChange(moveStep(wf, r.id, index, -1)); select(index - 1) }}>Move earlier</button>
        <button type="button" disabled={index === r.steps.length - 1} onClick={() => { onChange(moveStep(wf, r.id, index, 1)); select(index + 1) }}>Move later</button>
      </div>
      <div className="button-row">
        <button type="button" onClick={() => { onChange(insertStep(wf, r.id, index)); select(index + 1) }}>Add step after</button>
        <button
          type="button"
          className="danger"
          disabled={r.steps.length === 1}
          onClick={() => { onChange(removeStep(wf, r.id, index)); onSelect({ kind: 'route', id: r.id }) }}
        >
          Remove step
        </button>
      </div>
    </section>
  )
}
