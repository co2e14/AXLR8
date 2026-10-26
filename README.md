# AXLR8

Throughput and bottleneck simulator for the AXL automated crystallography lab.
Python (SimPy/FastAPI) backend, TypeScript (React) frontend.

* [docs/AXL_WORKFLOW.md](docs/AXL_WORKFLOW.md): how the AXL deck (`axlworkflow.pptx`) is modelled, with every assumption
* [docs/PLAN.md](docs/PLAN.md): original design

## Quick start

Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
./dev.sh        # starts the API on :8000 and opens the app on http://localhost:5173
```

The app opens with the AXL workflow from the deck: crystallisation setup, two soaking workflows with
their compound plates, harvesting outputs and seed-stock generation, laid out as lanes in the deck's colour key.

- **GO** sends one item down every active route and animates it.
- **Run the day schedule** releases items as configured per route (by default the deck's daily schedule:
  16 crystal plates; soak workflows every 15 min, offset by 7 min 30 s) and replays the day.
- **Day type** switches between *Run day* (soaking active) and *Shutdown day* (seed stock generation).
- **Equipment** picks the purchase phase (slide 3); only units bought by that phase exist.
- **Cobots** overrides the number of cobot arms on the rail.
- Click a box to edit that step, a route name to edit the route, or a device in the side panel to change
  its time, how its time is classed (fixed, project-specific, assumed) and its units per phase.
- Boxes marked **?** use an assumed time that is not in the deck. Replace them with measured values.
- *Bottlenecks* ranks devices and cobots by how busy they were; *Routes* shows whether each route keeps up
  with its release rate; *Items* shows where everything is at the current moment; *Compare runs* keeps a baseline.
- *Save to file* / *Open file* exchange workflows as JSON. *Reset to deck* reloads the AXL workflow.

## Backend

```bash
cd backend
uv sync
uv run pytest                                        # tests
uv run uvicorn axlr8.api:app --reload --port 8000    # API (docs at /docs)
uv run python scripts/build_axl_example.py           # regenerate examples/axl_workflow.json
```

`POST /api/simulate` takes `{"workflow": <Workflow>, "run": {"scenario", "phase", "cobots", "single", "seed"}}`
and returns the full event log plus KPIs. All times are in seconds.

## Frontend

```bash
cd frontend
npm install
npm run dev     # proxies /api to http://127.0.0.1:8000
npm test        # unit tests (vitest)
npm run build
```
