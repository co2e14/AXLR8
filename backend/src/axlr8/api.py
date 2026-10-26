"""HTTP API: run simulations and serve example lab configs."""

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, model_validator

from axlr8.engine import simulate
from axlr8.kpis import Kpis, compute_kpis
from axlr8.model import Event, LabConfig, RunSettings

EXAMPLES_DIR = Path(__file__).resolve().parents[3] / "examples"
_SAFE_NAME = re.compile(r"[A-Za-z0-9_-]+")
MAX_EVENTS = 100_000  # keeps a response around 10 MB


class SimulateRequest(BaseModel):
    lab: LabConfig
    run: RunSettings = RunSettings()

    @model_validator(mode="after")
    def _within_budget(self):
        hops = len(self.lab.stations) + 1
        estimate = self.run.num_samples * (2 + 3 * hops + 2 * len(self.lab.stations))
        if estimate > MAX_EVENTS:
            raise ValueError(
                f"run too large: about {estimate:,} events (limit {MAX_EVENTS:,}). "
                "Use fewer samples or fewer stations."
            )
        return self


class SimulateResponse(BaseModel):
    events: list[Event]
    kpis: Kpis


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
    events = simulate(req.lab, req.run)
    return SimulateResponse(events=events, kpis=compute_kpis(req.lab, events))


@app.get("/api/examples")
def list_examples() -> list[str]:
    return sorted(p.stem for p in EXAMPLES_DIR.glob("*.json"))


@app.get("/api/examples/{name}", response_model=LabConfig)
def get_example(name: str) -> LabConfig:
    path = EXAMPLES_DIR / f"{name}.json"
    if not _SAFE_NAME.fullmatch(name) or not path.is_file():
        raise HTTPException(status_code=404, detail=f"no example named '{name}'")
    return LabConfig.model_validate_json(path.read_text())
