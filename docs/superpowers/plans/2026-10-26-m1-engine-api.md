# M1 — Simulation Engine + API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested Python package that simulates samples flowing through a lab line and serves results over HTTP.

**Architecture:** SimPy discrete-event simulation (`engine.py`) emits a flat, time-ordered event log; `kpis.py` derives all statistics purely from that log; FastAPI (`api.py`) exposes `POST /api/simulate`. Config is Pydantic (`model.py`), validated up front so the engine can assume a sound lab.

**Tech Stack:** Python 3.12 (via uv), simpy, fastapi, pydantic v2, uvicorn, pytest, httpx.

**Spec:** `docs/PLAN.md`

## Global Constraints
- All times are in **seconds** (floats). Frontend converts for display.
- Python `>=3.11`; run everything via `uv run` inside `backend/`.
- Location ids `input` and `output` are reserved; route = `input → stations… → output`.
- `num_samples` is 1–2000 (keeps the event log < ~10 MB).
- Same `seed` ⇒ byte-identical event log.

## Review Focus
1. Sample count not divisible by batch size → final partial batch must still run (no hang).
2. `buffer_size < batch_size` → would deadlock; must be rejected at validation with a clear message.
3. All-zero times → makespan 0; KPIs must not divide by zero (throughput `None`, utilisation 0).
4. Random spread larger than the mean → sampled time clamped at 0, never negative.
5. Transfers naming unknown stations/arms, non-adjacent steps, or duplicates → HTTP 422 with message.

## Domain semantics (engine contract)
- A sample, at each hop `here → there`: (1) reserves a buffer place at `there` if it has a finite buffer (it keeps holding its slot at `here` meanwhile = **blocking**); (2) waits for the arm if the transfer uses one; (3) moves — its slot at `here` is freed at move start; (4) joins `there`'s queue.
- A station starts a batch when a slot is free and the queue holds `batch_size` samples **or** every remaining sample has already arrived. A slot is freed only when every sample of the batch has been picked up.
- A buffer place is held from reservation until processing starts.
- Missing transfer between consecutive locations = instantaneous, no arm.

## Event log (`Event`)
`t, sample (1-based), kind, at, to?, arm?, batch?` with kinds:
`released` (at=input) · `dest_reserved` (at=here,to=there) · `move_start` (at=here,to=there,arm) · `move_end` (at=there,arm) · `process_start` / `process_end` (at=station,batch) · `completed` (at=output).

---

### Task 1: Scaffold + config model
**Files:** `backend/pyproject.toml`, `backend/src/axlr8/{__init__,model}.py`, `backend/tests/test_model.py`
**Produces:** `TimeSpec(value, kind="fixed"|"normal"|"uniform"|"triangular", spread=0)`, `Station(id,name,process_time,capacity=1,batch_size=1,buffer_size=None)`, `Arm(id,name)`, `Transfer(from_id,to_id,time,arm=None)`, `LabConfig(name,stations,arms,transfers)` with `.locations()`, `.transfer_for(a,b)`, `RunSettings(num_samples=1,arrival_interval=0,seed=None)`, `Event`, constants `INPUT`, `OUTPUT`.
- [ ] Tests: valid lab parses; locations order; missing transfer defaults to zero/no arm; rejects duplicate station ids, reserved ids, unknown arm, non-adjacent transfer, duplicate transfer, buffer<batch, num_samples 0 and 2001.
- [ ] Implement, run `uv run pytest tests/test_model.py`, commit.

### Task 2: Time sampling
**Files:** `backend/src/axlr8/timing.py`, `backend/tests/test_timing.py`
**Produces:** `sample_time(spec: TimeSpec, rng: random.Random) -> float`
- [ ] Tests: fixed returns value; spread 0 returns value for any kind; uniform/triangular stay within ±spread; normal mean ≈ value over 5000 draws; spread ≫ value never negative.
- [ ] Implement, test, commit.

### Task 3: Engine
**Files:** `backend/src/axlr8/engine.py`, `backend/tests/test_engine.py`
**Produces:** `simulate(lab: LabConfig, run: RunSettings) -> list[Event]`
- [ ] Tests (zero transfer times unless stated):
  - 1 sample, station 10 s, transfers 2 s in / 3 s out → completed at 15; kinds in contract order.
  - 3 samples at once, 10 s, cap 1 → completions 10, 20, 30. Cap 2, 4 samples → 10, 10, 20, 20.
  - interval 5, 3 samples, 1 s station → 1, 6, 11.
  - Shared arm (5 s both hops, station 0 s), 2 samples → completions 15, 20.
  - Batch 4, 10 samples, 10 s → 4×10, 4×20, 2×30 (partial batch).
  - Batch 2, interval 5, 3 samples, 10 s → 15, 15, 25.
  - Blocking: s1 1 s, s2 10 s buffer 1, 3 samples → sample 3 leaves s1 at 11; completions 11, 21, 31.
  - Same seed ⇒ identical log; different seed differs; event times non-decreasing.
- [ ] Implement, test, commit.

### Task 4: KPIs
**Files:** `backend/src/axlr8/kpis.py`, `backend/tests/test_kpis.py`
**Produces:** `compute_kpis(lab, events) -> Kpis` with `StationStats(id,name,utilisation,blocked_fraction,avg_wait,max_wait,avg_queue,max_queue,batches)`, `ArmStats(id,name,utilisation,moves,avg_wait)`, `Bottleneck(id,kind,utilisation)`, `Kpis(num_samples,makespan,throughput_per_hour,avg/min/max_cycle_time,stations,arms,bottleneck)`.
- [ ] Tests: 3 samples × 10 s → makespan 30, 360/h, util 1.0, avg_wait 10, max_wait 20, avg_queue 1.0, max_queue 2, cycles 10/20/30; stations 10 s & 30 s × 5 → bottleneck s2, util 150/160; slow arm → bottleneck kind arm; blocking scenario → s1 blocked 8/31; shared-arm scenario → arm util 1.0, moves 4, avg_wait 3.75; Little's law (avg_queue·makespan = Σwaits) on random run; all-zero lab → makespan 0, throughput None, bottleneck None.
- [ ] Implement, test, commit.

### Task 5: HTTP API + example lab
**Files:** `backend/src/axlr8/api.py`, `backend/tests/test_api.py`, `examples/simple_lab.json`, `README.md`
**Produces:** `GET /api/health`, `POST /api/simulate {lab, run} → {events, kpis}`, `GET /api/examples → [names]`, `GET /api/examples/{name} → LabConfig`. CORS for Vite dev server (`localhost:5173`).
- [ ] Tests: health ok; simulate example returns events + kpis; bad transfer → 422; 2001 samples → 422; examples list contains `simple_lab`; `../x` and unknown → 404.
- [ ] Implement, test, document run commands in README, commit.
