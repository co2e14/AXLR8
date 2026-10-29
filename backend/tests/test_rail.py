import json
from pathlib import Path

import pytest

from axlr8.engine import WorkflowError, simulate_with_rail
from axlr8.kpis import compute_kpis
from axlr8.model import Layout, Placement, RunSettings, Workflow
from axlr8.rail import Rail, sample
from conftest import dev, done, route, step, wf

DECK = Path(__file__).resolve().parents[2] / "examples" / "axl_workflow.json"


def stations(w: Workflow) -> list[str]:
    out = []
    for d in w.devices:
        out += [d.id] if d.unit_phases is None else [f"{d.id}:{u}" for u in range(1, len(d.unit_phases) + 1)]
    return out


def laid_out(w: Workflow, xs: dict[str, float] | None = None, **params) -> Workflow:
    """Places every station 1 m apart along the front of the rail, unless given."""
    keys = stations(w)
    xs = xs or {k: 1.0 + i for i, k in enumerate(keys)}
    places = [Placement(station=k, x=xs[k], side=1) for k in keys]
    return w.model_copy(update={"layout": Layout(placements=places, **params)})


def no_passing(tracks, sep: float) -> float:
    """Smallest gap between neighbouring arms over the whole run (motion is linear between keys)."""
    smallest = float("inf")
    for a in range(len(tracks) - 1):
        times = sorted({k[0] for k in tracks[a]} | {k[0] for k in tracks[a + 1]})
        for t in times:
            smallest = min(smallest, sample(tracks[a + 1], t)[1] - sample(tracks[a], t)[1])
    return smallest


def test_one_arm_drives_carries_and_places():
    w = laid_out(wf([dev("a", 10), dev("b", 5)], [route("r", [step("a"), step("b")])], move=0), rail_speed=1, handoff_time=2, return_home=False)
    events, rail = simulate_with_rail(w, RunSettings(cobots=1))
    assert rail is not None and len(rail.homes) == 1
    second = rail.moves[1]
    assert (second.source, second.target) == ("a:1", "b:1")
    assert second.need == pytest.approx(2 + 1 + 2)  # pick, 1 m at 1 m/s, place
    starts = [e for e in events if e.kind == "move_start"]
    assert all(e.arm == 0 for e in starts)
    # The move lasts as long as the arm needs when that is longer than the model's move time.
    assert done(events) == [pytest.approx(rail.moves[0].end + 10 + second.need + 5)]


def test_without_a_layout_the_pool_model_is_unchanged():
    w = wf([dev("a", 10), dev("b", 5)], [route("r", [step("a"), step("b")])], move=2)
    events, rail = simulate_with_rail(w, RunSettings(cobots=1))
    assert rail is None
    assert done(events) == [19]


def test_layout_must_place_every_station():
    w = wf([dev("a", 10), dev("b", 5)], [route("r", [step("a"), step("b")])])
    w = w.model_copy(update={"layout": Layout(placements=[Placement(station="a:1", x=1)])})
    with pytest.raises(WorkflowError, match="b:1"):
        simulate_with_rail(w, RunSettings(cobots=1))


def test_a_busy_arm_blocks_a_move_that_would_pass_it():
    rail = Rail.build(Layout(min_separation=1, rail_speed=1, handoff_time=0), 2, [0.0, 10.0])
    # Arm 1 (right) is busy around x 4..6; arm 0 cannot get to 8 past it.
    rail.assign(1, 0, 5, 1, 6, 1, 100)
    assert rail.choose(0, 8, 8) is None
    assert rail.choose(0, 2, 3) == 0  # this side of it is fine
    rail.release(1, 100)
    assert rail.choose(100, 8, 8) is not None


def test_idle_arms_stand_aside():
    rail = Rail.build(Layout(min_separation=1, rail_speed=1, handoff_time=0, return_home=False), 3, [0.0, 10.0])
    left = rail.homes[0]
    plan = rail.assign(0, 0, 9, 1, 9, 1, 0)  # arm 0 goes to the far right
    assert rail.pos(0, plan.end) == pytest.approx(9)
    assert rail.pos(1, plan.end) == pytest.approx(10)
    assert rail.pos(2, plan.end) == pytest.approx(11)  # the rail runs on past the last station
    assert no_passing(rail.tracks, 1) >= 1 - 1e-6
    assert left < 9


@pytest.mark.parametrize("cobots", [2, 3, 4])
def test_deck_run_day_arms_never_pass(cobots):
    deck = Workflow.model_validate(json.loads(DECK.read_text()))
    w = laid_out(deck, xs={k: 0.6 + 0.45 * i for i, k in enumerate(stations(deck))})
    run = RunSettings(scenario="run", phase=4, cobots=cobots, seed=1)
    events, rail = simulate_with_rail(w, run)
    assert rail is not None
    sep = w.layout.min_separation
    assert no_passing(rail.tracks, sep) >= sep - 1e-6
    moves = [e for e in events if e.kind == "move_start" and e.cobot]
    assert len(rail.moves) == len(moves)
    # Each arm makes one move at a time.
    for arm in range(cobots):
        mine = sorted((m.start, m.end) for m in rail.moves if m.arm == arm)
        assert all(a[1] <= b[0] + 1e-9 for a, b in zip(mine, mine[1:]))
    # A plate is carried to the unit it is then processed on.
    processed = {(e.item, e.t) for e in events if e.kind == "process_start"}
    assert processed
    k = compute_kpis(w, run, events)
    assert k.completed > 0
