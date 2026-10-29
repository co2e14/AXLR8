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


def _soaks(imaging: dict) -> tuple[list[dict], dict]:
    w = {**AXL, "imaging": {**AXL["imaging"], **imaging}}
    k = client.post("/api/simulate", json={"workflow": w, "run": {"seed": 1}}).json()["kpis"]
    return [r for r in k["routes"] if r["id"].startswith("soak_")], k


def test_daily_schedule_soaking_keeps_up_with_15_minute_release_when_imaging_is_quick():
    soaks, _ = _soaks({"seconds_per_well": 2})
    assert len(soaks) == 2 and all(r["keeps_up"] for r in soaks)


def test_at_8_s_per_well_the_spectroq_is_the_bottleneck_but_soaks_keep_up_ahead_of_growth_images():
    soaks, k = _soaks({})
    assert k["bottleneck"]["id"] == "spectroq"
    assert all(r["keeps_up"] for r in soaks)  # soak images go first
    assert max(i["avg_delay"] for i in k["incubators"]) > 3600  # growth images wait instead
    stored = [i for i in k["incubators"] if i["stored_today"] > 0]
    assert stored and all(i["imager"] for i in stored)  # crystal plates go where they can be imaged
    assert sum(i["stored_today"] for i in k["incubators"]) == 16
    # 16 grown plates are taken out for soaking from the plates inside at the start
    assert sum(i["taken_out"] for i in k["incubators"]) == 16
    assert sum(i["stored_end"] for i in k["incubators"]) == sum(i["stored_start"] for i in k["incubators"]) + 16 - 16


@pytest.mark.parametrize("phase", [2, 3, 4])
def test_every_phase_runs_what_its_equipment_allows(phase):
    r = client.post("/api/simulate", json={"workflow": AXL, "run": {"phase": phase, "seed": 1}})
    assert r.status_code == 200
    k = r.json()["kpis"]
    assert k["stuck"] == [] and k["completed"] > 0
    skipped = {s["route"]: s["reason"] for s in k["skipped"]}
    if phase == 2:
        assert "crystal_plates" in skipped and "XL200" in skipped["crystal_plates"]
    if phase == 4:
        assert skipped == {}


def test_phase_3_warns_that_workflow_2_shares_unit_1():
    k = client.post("/api/simulate", json={"workflow": AXL, "run": {"phase": 3, "seed": 1}}).json()["kpis"]
    assert any("Soak workflow 2" in w and "unit 2" in w for w in k["warnings"])


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


def test_mock_database_covers_every_table_with_data_from_one_run():
    from axlr8.mockdata import build
    from axlr8.model import RunSettings, Workflow

    sql = build(Workflow.model_validate(AXL), RunSettings(seed=1))
    for table in ["plate", "droplet", "operation", "cobot_move", "drop_image", "drop_score", "crystal", "echo_transfer", "harvest", "pin"]:
        assert f"copy {table} (" in sql
    assert sql.rstrip().endswith("commit;")
