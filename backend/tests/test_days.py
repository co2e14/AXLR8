import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from axlr8.api import app
from axlr8.engine import simulate
from axlr8.kpis import compute_kpis
from axlr8.model import Growth, Imaging, RunSettings
from conftest import dev, done, route, step, wf

AXL = json.loads((Path(__file__).resolve().parents[2] / "examples" / "axl_workflow.json").read_text())
client = TestClient(app)


def grow_and_soak(stock=0, growth_hours=10.0, schedule=(1, 20)):
    inc = dev("inc", 10, units=1, capacity=[50], imager_units=[1], stored_at_start=[stock])
    grow = route("grow", [step("inc", image=True, store=True)], count=1)
    soak = route("soak", [step("inc"), step("b")], count=1, offset=60)
    return wf(
        [inc, dev("b", 5)], [grow, soak],
        imaging=Imaging(wells_per_plate=1, seconds_per_well=5, schedule_hours=list(schedule)),
        growth=Growth(mean_hours=growth_hours, sd_hours=0, min_hours=growth_hours, max_hours=growth_hours),
    )


def test_a_soak_waits_for_a_plate_to_grow_then_takes_it():
    events = simulate(grow_and_soak(), RunSettings())
    stored = next(e for e in events if e.kind == "completed" and e.route == "grow")
    first = next(e for e in events if e.kind == "process_start" and e.route == "soak")
    assert first.takes == stored.item
    assert first.t >= stored.t - 15 + 10 * 3600 - 1e-6  # grown for 10 h after it went in


def test_a_soak_takes_a_plate_from_the_start_of_the_day_when_none_has_grown():
    events = simulate(grow_and_soak(stock=1), RunSettings())
    first = next(e for e in events if e.kind == "process_start" and e.route == "soak")
    assert first.takes is None and first.t < 3600


def test_a_plate_taken_out_is_not_imaged_again():
    events = simulate(grow_and_soak(growth_hours=5), RunSettings())
    taken = next(e for e in events if e.kind == "process_start" and e.route == "soak")
    images = [e.t for e in events if e.kind == "image_start"]
    assert images and all(t < taken.t for t in images)  # the 1 h image, not the 20 h one


def test_multi_day_runs_report_each_day():
    w = grow_and_soak(stock=0, growth_hours=30)
    run = RunSettings(days=3)
    k = compute_kpis(w, run, simulate(w, run))
    assert [d.day for d in k.days] == [1, 2, 3]
    assert [d.released for d in k.days] == [2, 2, 2]
    # a plate a day goes in; each soak waits 30 h for the day's plate to grow and takes it the next day.
    # The last day runs on until the last item finishes, so day 3's soak (taking day 3's plate) counts there.
    assert [d.stored_end for d in k.days] == [1, 1, 0]
    assert sum(d.soaks_grown for d in k.days) == 3


def test_phase_counts_only_bought_units_at_the_start():
    run = RunSettings(phase=2, days=2)
    from axlr8.model import Workflow
    w = Workflow.model_validate(AXL)
    k = compute_kpis(w, run, simulate(w, run))
    # Only the STX-500 (100 plates inside at the start) exists in phase 2; the other two units' 290 must not count.
    assert k.days[0].stored_end <= 100


@pytest.mark.parametrize("variation,spreads", [(0.0, False), (0.2, True)])
def test_ranges_over_seeds(variation, spreads):
    r = client.post("/api/simulate", json={"workflow": AXL, "run": {"seed": 1, "runs": 5, "time_variation": variation}})
    assert r.status_code == 200
    rg = r.json()["ranges"]
    assert rg["runs"] == 5 and rg["seeds"] == [1, 2, 3, 4, 5]
    assert (rg["makespan"]["max"] > rg["makespan"]["min"]) == spreads


def test_too_many_simulated_days_is_refused():
    r = client.post("/api/simulate", json={"workflow": AXL, "run": {"runs": 50, "days": 30}})
    assert r.status_code == 422 and "too many runs" in r.json()["detail"]
