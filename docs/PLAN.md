# AXLR8 — Automated Lab Throughput Simulator: Plan (DRAFT, awaiting approval)

## Goal
A web tool to model an automated laboratory (instruments, samples, cobot transfers),
tweak timings/capacities, and find bottlenecks. You can watch one sample go through
("GO"), release N samples and see where each one is, and get bottleneck statistics.

## Architecture

```
┌──────────────────────── Frontend (TypeScript) ───────────────────────┐
│ React + Vite + Tailwind                                              │
│  • Lab layout editor (React Flow: stations = nodes, moves = edges)   │
│  • Parameter panels (times, capacity, batch size, cobot speed…)      │
│  • Animated playback: samples moving between stations, timeline      │
│    scrubber, play/pause/speed, per-sample status table               │
│  • Results dashboard: utilisation, queue lengths, wait times,        │
│    throughput, bottleneck highlighted on the layout                  │
└───────────────▲──────────────────────────────────┬───────────────────┘
                │ REST (JSON) + WebSocket          │ lab config JSON
┌───────────────┴──────────── Backend (Python) ────▼───────────────────┐
│ FastAPI + Pydantic                                                   │
│  • Simulation engine: SimPy discrete-event simulation                │
│  • Produces (a) a full event log, (b) summary KPIs                   │
│  • Bottleneck analysis (utilisation, blocking, queue time per stage) │
│  • Lab configs saved/loaded as JSON files                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Simulation approach (recommended: run-then-replay)
The Python engine runs the whole simulation in milliseconds and returns a timestamped
event log (`sample 7 arrives at Centrifuge`, `cobot picks sample 7`, …). The browser
replays that log as an animation at whatever speed you choose and can scrub back and
forward. This is deterministic, fast, and makes "what stage is each sample at, at
time t" trivial.

Alternative considered: step the simulation live over a WebSocket in real time. More
"live" feeling but slower, harder to rewind, and more fragile. Not recommended unless
we later connect to real hardware.

## Domain model (first version)
- **Station** — name, number of parallel slots (capacity), process time
  (fixed or distribution: normal / triangular / uniform), batch size (e.g. a
  centrifuge that takes 4 at once), optional setup time, input buffer size.
- **Transport** — cobot arm(s) as a shared resource; move time per pair of
  locations (or distance ÷ speed + pick/place time). A busy arm makes samples wait,
  so the arm itself can be the bottleneck.
- **Workflow** — one fixed route: every sample visits the same stations in the
  same order. Each station and each transfer between stations has its own time,
  and those times can differ from sample to sample (see Timing).
- **Timing** — every station/transfer time is fixed by default, with an optional
  spread (normal / triangular / uniform) and a random seed so runs are repeatable.
- **Run settings** — number of samples, arrival pattern (all at once / every X
  min), random seed, number of replications.

## Outputs
- Per station: utilisation %, average/max queue, average wait, blocked time.
- Cobot: utilisation, number of moves, wait for arm.
- Overall: makespan, throughput (samples/hour), per-sample cycle time.
- **Bottleneck flag**: station/arm with the highest utilisation and longest wait,
  highlighted red on the layout.
- Scenario compare: save two configs and compare KPIs side by side.

## Repo layout
```
backend/   Python package (engine, API, tests)
frontend/  Vite + React + TypeScript app
docs/      plans and specs
examples/  sample lab configs
```

## Milestones
1. **Engine + API** — data model, SimPy engine, event log, KPIs, pytest
   (incl. sanity checks against queueing theory, e.g. Little's law).
2. **Frontend skeleton** — layout editor, parameter forms, run button, KPI tables.
3. **Animated playback** — GO for one sample, N-sample run, timeline, sample status list.
4. **Bottleneck analysis** — highlighting, charts (utilisation, queue over time),
   scenario comparison.
5. **Polish** — save/load configs, example labs, one-command start script.

## Tooling notes
- Python 3.11+ needed (system Python here is 3.9) — will use `uv` to manage it.
- Node 22 is present.
- GitHub: private repo created with the `gh` CLI (installed via Homebrew).
