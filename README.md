# AXLR8

Automated lab throughput and bottleneck simulator: Python (SimPy/FastAPI) backend, TypeScript (React) frontend.

See [docs/PLAN.md](docs/PLAN.md) for the design.

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
