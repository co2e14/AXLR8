import pytest

from axlr8.engine import WorkflowError
from axlr8.model import Layout, Placement, RunSettings
from axlr8.optimise import OptimiseRequest, optimise
from conftest import dev, route, step, wf


def far_apart():
    # a -> b -> c, but b is placed at the far end: every plate drives the rail twice
    w = wf([dev("a", 5), dev("b", 5), dev("c", 5), dev("d", 5), dev("e", 5)], [route("r", [step("a"), step("b"), step("c")], count=6)], move=1)
    places = [Placement(station=k, x=x, side=1) for k, x in [("a:1", 1), ("c:1", 2), ("d:1", 3), ("e:1", 4), ("b:1", 12)]]
    return w.model_copy(update={"layout": Layout(placements=places, rail_speed=0.5, handoff_time=1)})


def test_optimise_moves_stations_that_work_together_next_to_each_other():
    w = far_apart()
    r = optimise(OptimiseRequest(workflow=w, run=RunSettings(cobots=2, seed=1), widths={p.station: 0.5 for p in w.layout.placements}, budget_s=1))
    assert r.improved and r.after.cost < r.before.cost and r.after.makespan < r.before.makespan
    x = {p.station: p.x for p in r.layout.placements}
    assert abs(x["a:1"] - x["b:1"]) < 2 and abs(x["b:1"] - x["c:1"]) < 2
    # packed without overlaps, keeping the rail settings
    for side in (1, -1):
        xs = sorted(p.x for p in r.layout.placements if p.side == side)
        assert all(b - a >= 0.5 + 0.15 - 1e-9 for a, b in zip(xs, xs[1:]))
    assert r.layout.rail_speed == 0.5


def test_optimise_needs_a_width_for_every_station():
    w = far_apart()
    with pytest.raises(WorkflowError, match="width"):
        optimise(OptimiseRequest(workflow=w, run=RunSettings(cobots=1), widths={"a:1": 0.5}, budget_s=1))
