import pytest

from axlr8.engine import simulate
from axlr8.model import INPUT, OUTPUT, RunSettings, TimeSpec
from conftest import lab, station, transfer


def completions(events):
    return sorted(e.t for e in events if e.kind == "completed")


def run(cfg, n=1, interval=0.0, seed=None):
    return simulate(cfg, RunSettings(num_samples=n, arrival_interval=interval, seed=seed))


def test_single_sample_walks_the_route_in_contract_order():
    cfg = lab([station("s1", 10)], [transfer(INPUT, "s1", 2), transfer("s1", OUTPUT, 3)])
    events = run(cfg)
    assert [(e.kind, e.at) for e in events] == [
        ("released", INPUT),
        ("dest_reserved", INPUT),
        ("move_start", INPUT),
        ("move_end", "s1"),
        ("process_start", "s1"),
        ("process_end", "s1"),
        ("dest_reserved", "s1"),
        ("move_start", "s1"),
        ("move_end", OUTPUT),
        ("completed", OUTPUT),
    ]
    assert completions(events) == [15]
    assert {e.sample for e in events} == {1}


def test_single_slot_serialises_samples():
    assert completions(run(lab([station("s1", 10)]), n=3)) == [10, 20, 30]


def test_capacity_runs_samples_in_parallel():
    assert completions(run(lab([station("s1", 10, capacity=2)]), n=4)) == [10, 10, 20, 20]


def test_arrival_interval_staggers_release():
    assert completions(run(lab([station("s1", 1)]), n=3, interval=5)) == [1, 6, 11]


def test_shared_arm_makes_samples_wait():
    cfg = lab(
        [station("s1", 0)],
        [transfer(INPUT, "s1", 5, arm="cobot"), transfer("s1", OUTPUT, 5, arm="cobot")],
        arms=["cobot"],
    )
    assert completions(run(cfg, n=2)) == [15, 20]


def test_partial_final_batch_still_runs():
    events = run(lab([station("s1", 10, batch_size=4)]), n=10)
    assert completions(events) == [10] * 4 + [20] * 4 + [30] * 2
    assert {e.batch for e in events if e.kind == "process_start"} == {1, 2, 3}


def test_batch_waits_to_fill_then_runs_remainder():
    events = run(lab([station("s1", 10, batch_size=2)]), n=3, interval=5)
    assert completions(events) == [15, 15, 25]


def test_full_buffer_blocks_upstream_station():
    cfg = lab([station("s1", 1), station("s2", 10, buffer_size=1)])
    events = run(cfg, n=3)
    leave = [e.t for e in events if e.kind == "move_start" and e.at == "s1" and e.sample == 3]
    assert leave == [11]
    assert completions(events) == [11, 21, 31]


def test_same_seed_is_reproducible_and_different_seed_differs():
    noisy = TimeSpec(value=10, kind="normal", spread=3)
    cfg = lab([station("s1", 0).model_copy(update={"process_time": noisy})])
    a = run(cfg, n=20, seed=42)
    assert a == run(cfg, n=20, seed=42)
    assert a != run(cfg, n=20, seed=43)


def test_event_times_never_decrease():
    cfg = lab(
        [station("s1", 3, capacity=2), station("s2", 7, batch_size=3, buffer_size=3)],
        [transfer("s1", "s2", 2, arm="a")],
        arms=["a"],
    )
    times = [e.t for e in run(cfg, n=25, interval=1)]
    assert times == sorted(times)


def test_changing_one_station_does_not_reshuffle_randomness_elsewhere():
    noisy = TimeSpec(value=10, kind="normal", spread=3)
    a = station("a", 0).model_copy(update={"process_time": noisy})
    b = station("b", 0).model_copy(update={"process_time": noisy})
    before = run(lab([a, b]), n=10, seed=5)
    after = run(lab([a.model_copy(update={"process_time": TimeSpec(value=4)}), b]), n=10, seed=5)
    durations = lambda evs: [e.t for e in evs if e.kind == "process_end" and e.at == "b"]
    starts = lambda evs: [e.t for e in evs if e.kind == "process_start" and e.at == "b"]
    gaps = lambda evs: [x - y for x, y in zip(durations(evs), starts(evs))]
    assert gaps(after) == pytest.approx(gaps(before))
