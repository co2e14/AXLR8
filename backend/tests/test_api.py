import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from axlr8.api import app

client = TestClient(app)
AXL = json.loads((Path(__file__).resolve().parents[2] / "examples" / "axl_workflow.json").read_text())


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


@pytest.mark.parametrize("scenario", ["run", "shutdown"])
def test_axl_workflow_runs_to_completion(scenario):
    r = client.post("/api/simulate", json={"workflow": AXL, "run": {"scenario": scenario, "seed": 1}})
    assert r.status_code == 200
    k = r.json()["kpis"]
    assert k["stuck"] == []
    assert k["completed"] == k["released"] > 0
    assert k["bottleneck"] is not None


def test_daily_schedule_soaking_keeps_up_with_15_minute_release():
    k = client.post("/api/simulate", json={"workflow": AXL, "run": {"seed": 1}}).json()["kpis"]
    soaks = [r for r in k["routes"] if r["id"].startswith("soak_")]
    assert len(soaks) == 2 and all(r["keeps_up"] for r in soaks)


def test_missing_devices_for_phase_is_422_with_reason():
    r = client.post("/api/simulate", json={"workflow": AXL, "run": {"phase": 2}})
    assert r.status_code == 422
    assert "XL200" in r.text and "phase 2" in r.text


def test_go_releases_one_item_per_route():
    k = client.post("/api/simulate", json={"workflow": AXL, "run": {"single": True, "seed": 1}}).json()["kpis"]
    by = {r["id"]: r["released"] for r in k["routes"]}
    assert by["crystal_plates"] == 1 and by["soak_1"] == 1
    assert k["stuck"] == []  # loops run once, so looping partners do not wait for joins that never come


def test_invalid_workflow_is_422():
    bad = {**AXL, "routes": [{"id": "r", "name": "r", "steps": [{"devices": ["nope"]}]}]}
    r = client.post("/api/simulate", json={"workflow": bad})
    assert r.status_code == 422 and "unknown device" in r.text


def test_nan_is_422_not_500():
    body = '{"workflow": {"devices": [{"id": "a", "name": "A", "time": {"value": NaN}}], "routes": []}}'
    r = client.post("/api/simulate", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_examples():
    assert client.get("/api/examples").json() == ["axl_workflow"]
    assert client.get("/api/examples/axl_workflow").json()["name"] == "AXL workflow"
    assert client.get("/api/examples/..%2Fx").status_code == 404
