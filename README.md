# AXLR8

Automated lab throughput and bottleneck simulator: Python (SimPy/FastAPI) backend, TypeScript (React) frontend.

See [docs/PLAN.md](docs/PLAN.md) for the design.

## Quick start

Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
./dev.sh        # starts the API on :8000 and opens the app on http://localhost:5173
```

In the app:

- **GO** sends one sample down the line and animates it.
- **Run N samples** releases N samples (all at once, or one every X seconds) and replays the run;
  drag the timeline to see where every sample is at any moment (*Samples* tab).
- Click a station or a move on the line to change its time, variation, parallel slots, batch size,
  waiting space, or which cobot arm does the move.
- *Bottlenecks* shows how busy each station and arm is; the busiest one is outlined in red.
- *Compare runs* keeps one run as a baseline so you can see what a change did.
- Labs are saved in the browser automatically; *Save to file* / *Open file* exchange them as JSON.

## Backend

Requires [uv](https://docs.astral.sh/uv/).

```bash
cd backend
uv sync
uv run pytest                                   # tests
uv run uvicorn axlr8.api:app --reload --port 8000   # API on http://localhost:8000 (docs at /docs)
```

All times are in seconds. `POST /api/simulate` takes `{"lab": <LabConfig>, "run": {"num_samples", "arrival_interval", "seed"}}`
and returns the full event log plus KPIs. Example labs live in `examples/`.

## Frontend

```bash
cd frontend
npm install
npm run dev     # proxies /api to http://127.0.0.1:8000
npm test        # unit tests (vitest)
npm run build
```
