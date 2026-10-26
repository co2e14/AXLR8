"""HTTP API: run simulations and serve example lab configs."""

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from axlr8.engine import simulate
from axlr8.kpis import Kpis, compute_kpis
from axlr8.model import Event, LabConfig, RunSettings

EXAMPLES_DIR = Path(__file__).resolve().parents[3] / "examples"
_SAFE_NAME = re.compile(r"[A-Za-z0-9_-]+")


class SimulateRequest(BaseModel):
    lab: LabConfig
    run: RunSettings = RunSettings()


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
