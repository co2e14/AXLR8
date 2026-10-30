import pytest

from axlr8.engine import WorkflowError, simulate
from axlr8.kpis import compute_kpis
from axlr8.model import Loop, RunSettings, Spawn, TimeSpec
from conftest import dev, done, route, run, starts, step, wf


def test_single_item_walks_its_route_with_cobot_moves():
    w = wf([dev("a", 10), dev("b", 5)], [route("r", [step("a"), step("b")])], move=2)
    events = run(w)
    assert [(e.kind, e.step) for e in events] == [
        ("released", -1),
        ("move_ready", -1), ("move_start", -1), ("move_end", 0),
        ("process_start", 0), ("process_end", 0),
        ("move_ready", 0), ("move_start", 0), ("move_end", 1),
        ("process_start", 1), ("process_end", 1),
        ("completed", 1),
    ]
    assert done(events) == [19]


def test_routes_compete_for_a_shared_device():
    w = wf([dev("p", 10)], [route("r1", [step("p")]), route("r2", [step("p")])])
    assert done(run(w)) == [10, 20]


def test_more_units_run_in_parallel():
    w = wf([dev("p", 10, units=2)], [route("r1", [step("p")]), route("r2", [step("p")])])
    assert done(run(w)) == [10, 10]


def test_unit_restriction_pins_steps_to_units():
    same = wf([dev("p", 10, units=2)], [route("r1", [step("p", units=[1])]), route("r2", [step("p", units=[1])])])
    split = wf([dev("p", 10, units=2)], [route("r1", [step("p", units=[1])]), route("r2", [step("p", units=[2])])])
    assert done(run(same)) == [10, 20]
    assert done(run(split)) == [10, 10]
    assert {u for _, _, u in starts(run(split), "p")} == {1, 2}


def test_restricted_unit_missing_in_phase_falls_back_to_available_units():
    w = wf([dev("p", 10, phases=[1, 4])], [route("r", [step("p", units=[2])])])
    events = run(w, phase=1)
    assert starts(events, "p")[0][2] == 1


def test_alternative_devices_share_the_load():
    w = wf([dev("m1", 10), dev("m2", 10)], [route("r", [step("m1", "m2")], count=2)])
    events = run(w)
    assert done(events) == [10, 10]
    assert {e.device for e in events if e.kind == "process_start"} == {"m1", "m2"}


def test_join_runs_both_items_together_on_one_device_unit():
    w = wf(
        [dev("a", 1), dev("echo", 7)],
        [route("crystal", [step("a"), step("echo", join="soak")]), route("compound", [step("echo", join="soak")])],
    )
    events = run(w)
    s = starts(events, "echo")
    assert [t for t, _, _ in s] == [1, 1] and len({u for _, _, u in s}) == 1
    assert done(events) == [8, 8]


def test_looping_partner_serves_several_joins():
    w = wf(
        [dev("peel", 1), dev("echo", 7)],
        [
            route("crystal", [step("echo", join="soak")], count=3, interval=100),
            route("compound", [step("peel"), step("echo", join="soak")], loop=Loop(start=0, end=1, times=3)),
        ],
    )
    events = run(w)
    assert done(events, "crystal") == [8, 107, 207]  # first join waits for the compound peel (0-1 s)
    assert done(events, "compound") == [207]


def test_unmatched_join_leaves_items_unfinished_without_crashing():
    w = wf([dev("echo", 7)], [route("crystal", [step("echo", join="k")], count=2), route("compound", [step("echo", join="k")])])
    events = run(w)
    assert len(done(events)) == 2  # one pair; the second crystal plate never meets a partner


def test_join_without_active_partner_route_is_an_error():
    w = wf([dev("echo", 7)], [route("crystal", [step("echo", join="k")]), route("compound", [step("echo", join="k")], enabled=False)])
    with pytest.raises(WorkflowError, match="meeting point 'k'"):
        run(w)


def test_dwell_frees_the_device():
    w = wf([dev("a", 10), dev("b", 5)], [route("r", [step("a", dwell=TimeSpec(value=50)), step("b")], count=2)])
    events = run(w)
    assert [t for t, _, _ in starts(events, "a")] == [0, 10]
    assert done(events) == [65, 75]


def test_spawn_starts_items_on_another_route():
    w = wf(
        [dev("x", 10), dev("v", 3)],
        [route("plates", [step("x", spawn=[Spawn(route="pins", count=2)])]), route("pins", [step("v")], count=0)],
    )
    events = run(w)
    assert done(events, "pins") == [13, 16]


def test_disabled_and_unavailable_optional_steps_are_skipped():
    w = wf(
        [dev("a", 1), dev("b", 5), dev("late", 9, phases=[4])],
        [route("r", [step("a"), step("b", optional=True, enabled=False), step("late", optional=True)])],
    )
    events = run(w, phase=2)
    assert {e.device for e in events if e.kind == "process_start"} == {"a"}


def test_required_step_without_units_in_phase_is_an_error():
    w = wf([dev("xl200", 300, phases=[3])], [route("crystal", [step("xl200")])])
    with pytest.raises(WorkflowError, match="XL200.*phase 2"):
        run(w, phase=2)


def test_scenario_selects_routes():
    w = wf([dev("a", 1)], [route("soak", [step("a")], scenarios=["run"]), route("seed", [step("a")], scenarios=["shutdown"])])
    assert {e.route for e in run(w, scenario="shutdown")} == {"seed"}


def test_one_cobot_serialises_moves_and_holds_the_device_until_pickup():
    w = wf([dev("a", 10), dev("b", 0)], [route("r", [step("a"), step("b")], count=2)], move=5)
    events = run(w, cobots=1)
    item1_leaves_a = next(e.t for e in events if e.kind == "move_start" and e.step == 0 and e.item == 1)
    item2_starts_a = next(t for t, i, _ in starts(events, "a") if i == 2)
    assert item2_starts_a == item1_leaves_a
    moves = sorted((e.t, e.kind) for e in events if e.kind in ("move_start", "move_end"))
    assert all(a[1] != b[1] for a, b in zip(moves, moves[1:]))  # never two moves at once


def test_no_cobots_means_unlimited_manual_moves():
    w = wf([dev("a", 0)], [route("r", [step("a")], count=3)], move=5)
    assert done(run(w, cobots=0)) == [5, 5, 5]


def test_releases_follow_count_interval_and_offset():
    w = wf([dev("a", 1, units=None)], [route("r", [step("a")], count=3, interval=900, offset=450)])
    assert [e.t for e in run(w) if e.kind == "released"] == [450, 1350, 2250]


def test_single_mode_releases_one_item_per_route():
    w = wf([dev("a", 1, units=None)], [route("r1", [step("a")], count=5), route("r2", [step("a")], count=5)])
    assert len(done(run(w, single=True))) == 2


def test_same_seed_reproducible():
    noisy = TimeSpec(value=10, kind="normal", spread=3)
    w = wf([dev("a", 0).model_copy(update={"time": noisy})], [route("r", [step("a")], count=10)])
    assert run(w, seed=4) == run(w, seed=4)
    assert run(w, seed=4) != run(w, seed=5)


# ---- review fixes ----
from axlr8.engine import plan_run  # noqa: E402
from axlr8.model import RunSettings  # noqa: E402


def test_routes_needing_unbought_devices_are_skipped_not_fatal():
    w = wf(
        [dev("a", 1), dev("xl200", 300, phases=[3])],
        [route("soak", [step("a")]), route("crystal", [step("xl200")])],
    )
    events = run(w, phase=2)
    assert {e.route for e in events} == {"soak"}
    plan = plan_run(w, RunSettings(phase=2))
    assert [(r, "XL200" in why) for r, why in plan.skipped] == [("crystal", True)]


def test_skipping_a_route_also_skips_its_join_partner():
    w = wf(
        [dev("a", 1), dev("late", 1, phases=[4]), dev("echo", 7)],
        [
            route("crystal", [step("late"), step("echo", join="k")]),
            route("compound", [step("echo", join="k")]),
            route("other", [step("a")]),
        ],
    )
    plan = plan_run(w, RunSettings(phase=2))
    assert sorted(r for r, _ in plan.skipped) == ["compound", "crystal"]
    assert {e.route for e in run(w, phase=2)} == {"other"}


def test_nothing_runnable_is_an_error():
    w = wf([dev("xl200", 300, phases=[3])], [route("crystal", [step("xl200")])])
    with pytest.raises(WorkflowError, match="XL200.*phase 2"):
        run(w, phase=2)


def test_pinned_unit_fallback_is_reported():
    w = wf([dev("echo", 7, phases=[2, 4])], [route("soak_2", [step("echo", units=[2])])])
    plan = plan_run(w, RunSettings(phase=3))
    assert any("unit 2" in m and "ECHO" in m for m in plan.warnings)


def test_event_limit_stops_the_run_early(monkeypatch):
    import axlr8.engine as engine

    monkeypatch.setattr(engine, "MAX_EVENTS", 50)
    w = wf([dev("a", 1, units=None)], [route("r", [step("a")], count=500)])
    with pytest.raises(WorkflowError, match="too large"):
        run(w)


def test_sync_makes_two_routes_start_a_step_together_on_their_own_devices():
    w = wf(
        [dev("spectroq", 25), dev("dc2sa", 25)],
        [
            route("crystal", [step("spectroq", sync="start")], count=2, interval=900, offset=100),
            route("compound", [step("dc2sa", sync="start")], loop=Loop(start=0, end=0, times=2)),
        ],
    )
    events = run(w)
    starts_at = lambda d: [t for t, _, _ in starts(events, d)]
    assert starts_at("spectroq") == [100, 1000]
    assert starts_at("dc2sa") == [100, 1000]  # waits in storage for its crystal plate


def test_follow_on_day_starts_with_the_previous_days_unfinished_work():
    # One 100 s device, two items a day: day 1's second item is still processing when day 2 starts at 150 s.
    w = wf([dev("a", 100)], [route("r", [step("a")], count=2, scenarios=["run"])])
    events = run(w, scenario="follow_on", day_length=150)
    carried = {e.item for e in events if e.carried}
    assert len(carried) == 2  # both day-1 items keep their events, at negative times
    unfinished = {e.item for e in events if e.kind == "completed" and e.t >= 0} & carried
    assert len(unfinished) == 1  # one of them was still processing when day 2 started
    assert done(events) == [-50, 50, 150, 250]  # day 1 at -50 and 200 - 150; then day 2's two queue behind it


def test_follow_on_kpis_cover_day_two_only():
    w = wf([dev("a", 100)], [route("r", [step("a")], count=2, scenarios=["run"])])
    r = RunSettings(scenario="follow_on", day_length=150)
    k = compute_kpis(w, r, simulate(w, r))
    assert (k.released, k.completed, k.carried_over, k.carried_completed) == (2, 2, 1, 1)
    assert k.makespan == 250
    assert k.devices[0].utilisation == pytest.approx(1.0)  # busy from 0 to 250
    assert k.devices[0].uses == 2  # the carried item's run started on day 1


def test_follow_on_runs_the_run_day_routes():
    w = wf([dev("a", 1)], [route("soak", [step("a")], scenarios=["run"]), route("seed", [step("a")], scenarios=["shutdown"])])
    assert {e.route for e in run(w, scenario="follow_on")} == {"soak"}
