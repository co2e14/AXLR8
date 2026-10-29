"""HTTP API: run simulations and serve example lab configs."""

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from axlr8.engine import WorkflowError, simulate_with_rail
from axlr8.kpis import Kpis, compute_kpis
from axlr8.model import Event, RailResult, RunSettings, Workflow
from axlr8.optimise import OptimiseRequest, OptimiseResult, optimise
from axlr8.ranges import Ranges, repeat
from axlr8 import labdb

EXAMPLES_DIR = Path(__file__).resolve().parents[3] / "examples"
_SAFE_NAME = re.compile(r"[A-Za-z0-9_-]+")


class SimulateRequest(BaseModel):
    workflow: Workflow
    run: RunSettings = RunSettings()


class SimulateResponse(BaseModel):
    events: list[Event]
    kpis: Kpis
    rail: RailResult | None = None  # arm motion on the rail, when the workflow has a layout and cobots
    ranges: Ranges | None = None  # when run.runs > 1: the results over that many seeds


app = FastAPI(title="AXLR8")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    # Drop echoed input: it may hold NaN/inf, which JSON cannot encode.
    detail = [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/simulate", response_model=SimulateResponse)
def run_simulation(req: SimulateRequest) -> SimulateResponse:
    try:
        events, rail = simulate_with_rail(req.workflow, req.run)
        kpis = compute_kpis(req.workflow, req.run, events)
        ranges = repeat(req.workflow, req.run, kpis) if req.run.runs > 1 else None
    except WorkflowError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return SimulateResponse(events=events, kpis=kpis, rail=rail, ranges=ranges)


@app.post("/api/optimise", response_model=OptimiseResult)
def run_optimise(req: OptimiseRequest) -> OptimiseResult:
    """Searches for the station arrangement that lets the day finish soonest (see optimise.py).
    Scores one day per layout: repeats and extra days would leave time for only a few layouts."""
    req = req.model_copy(update={"run": req.run.model_copy(update={"runs": 1, "days": 1})})
    try:
        return optimise(req)
    except WorkflowError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


class LabDbBuild(BaseModel):
    workflow: Workflow
    run: RunSettings = RunSettings()


def _labdb(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except labdb.Unavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"no table or column named {e.args[0]!r}") from e


@app.post("/api/labdb/build", response_model=labdb.DbStatus)
def build_labdb(req: LabDbBuild) -> labdb.DbStatus:
    """Rebuilds the mock lab metadata database from one simulated day of this workflow."""
    # One run of at most two days: the mock data (tens of thousands of images a day) grows fast.
    run = req.run.model_copy(update={"runs": 1, "days": min(req.run.days, 2)})
    req = req.model_copy(update={"run": run})
    days = f", {run.days} days" if run.days > 1 else ""
    phase = f"phase {run.phase}, {run.scenario.replace('_', '-')} day{days}, seed {run.seed}"
    try:
        return _labdb(labdb.rebuild, req.workflow, req.run, f"{req.workflow.name}: {phase}")
    except WorkflowError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.get("/api/labdb", response_model=labdb.DbStatus)
def labdb_status() -> labdb.DbStatus:
    return _labdb(labdb.status)


@app.get("/api/labdb/{name}", response_model=labdb.Rows)
def labdb_rows(name: str, limit: int = 50, offset: int = 0, column: str | None = None, value: str | None = None) -> labdb.Rows:
    return _labdb(labdb.rows, name, limit=limit, offset=offset, column=column, value=value)


@app.get("/api/examples")
def list_examples() -> list[str]:
    return sorted(p.stem for p in EXAMPLES_DIR.glob("*.json"))


@app.get("/api/examples/{name}", response_model=Workflow)
def get_example(name: str) -> Workflow:
    path = EXAMPLES_DIR / f"{name}.json"
    if not _SAFE_NAME.fullmatch(name) or not path.is_file():
        raise HTTPException(status_code=404, detail=f"no example named '{name}'")
    return Workflow.model_validate_json(path.read_text())
