import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from axlr8.api import app

client = TestClient(app)
EXAMPLE = json.loads((Path(__file__).resolve().parents[2] / "examples" / "simple_lab.json").read_text())


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_simulate_example_returns_events_and_kpis():
    r = client.post("/api/simulate", json={"lab": EXAMPLE, "run": {"num_samples": 12, "seed": 1}})
    assert r.status_code == 200
    body = r.json()
    assert body["kpis"]["num_samples"] == 12
    assert sum(1 for e in body["events"] if e["kind"] == "completed") == 12
    assert body["kpis"]["bottleneck"] is not None


def test_invalid_transfer_is_422_with_message():
    bad = {**EXAMPLE, "transfers": [{"from_id": "input", "to_id": "nowhere", "time": {"value": 1}}]}
    r = client.post("/api/simulate", json={"lab": bad})
    assert r.status_code == 422
    assert "consecutive" in r.text


def test_too_many_samples_is_422():
    r = client.post("/api/simulate", json={"lab": EXAMPLE, "run": {"num_samples": 2001}})
    assert r.status_code == 422


def test_examples_listing_and_fetch():
    assert "simple_lab" in client.get("/api/examples").json()
    r = client.get("/api/examples/simple_lab")
    assert r.status_code == 200 and r.json()["name"] == "Sample prep line"


@pytest.mark.parametrize("name", ["missing", "..%2Fbackend%2Fpyproject", "a.b"])
def test_unknown_or_unsafe_example_is_404(name):
    assert client.get(f"/api/examples/{name}").status_code == 404
