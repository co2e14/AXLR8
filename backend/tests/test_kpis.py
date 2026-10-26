import pytest

from axlr8.engine import simulate
from axlr8.kpis import compute_kpis
from axlr8.model import INPUT, OUTPUT, RunSettings, TimeSpec
from conftest import lab, station, transfer


def kpis_for(cfg, n=1, interval=0.0, seed=None):
    events = simulate(cfg, RunSettings(num_samples=n, arrival_interval=interval, seed=seed))
    return compute_kpis(cfg, events), events


def test_single_station_queue_statistics():
    k, _ = kpis_for(lab([station("s1", 10)]), n=3)
    assert k.num_samples == 3
    assert k.makespan == 30
    assert k.throughput_per_hour == pytest.approx(360)
    assert (k.avg_cycle_time, k.min_cycle_time, k.max_cycle_time) == (20, 10, 30)
    s = k.stations[0]
    assert s.utilisation == pytest.approx(1.0)
    assert (s.avg_wait, s.max_wait) == (10, 20)
    assert s.avg_queue == pytest.approx(1.0)
    assert s.max_queue == 2
    assert s.batches == 3


def test_slowest_station_is_the_bottleneck():
    k, _ = kpis_for(lab([station("s1", 10), station("s2", 30)]), n=5)
    assert k.bottleneck.id == "s2" and k.bottleneck.kind == "station"
    assert k.bottleneck.utilisation == pytest.approx(150 / 160)


def test_slow_arm_is_the_bottleneck():
    cfg = lab(
        [station("s1", 1)],
        [transfer(INPUT, "s1", 20, arm="a"), transfer("s1", OUTPUT, 20, arm="a")],
        arms=["a"],
    )
    k, _ = kpis_for(cfg, n=4)
    assert k.bottleneck.kind == "arm" and k.bottleneck.id == "a"


def test_blocked_time_is_reported_on_upstream_station():
    k, _ = kpis_for(lab([station("s1", 1), station("s2", 10, buffer_size=1)]), n=3)
    assert k.stations[0].blocked_fraction == pytest.approx(8 / 31)


def test_arm_statistics():
    cfg = lab(
        [station("s1", 0)],
        [transfer(INPUT, "s1", 5, arm="a"), transfer("s1", OUTPUT, 5, arm="a")],
        arms=["a"],
    )
    k, _ = kpis_for(cfg, n=2)
    a = k.arms[0]
    assert a.moves == 4
    assert a.utilisation == pytest.approx(1.0)
    assert a.avg_wait == pytest.approx(3.75)


def test_littles_law_holds_for_station_queues():
    noisy = TimeSpec(value=10, kind="triangular", spread=6)
    cfg = lab([station("s1", 0).model_copy(update={"process_time": noisy}), station("s2", 8, capacity=2)])
    k, events = kpis_for(cfg, n=50, interval=4, seed=7)
    for s in k.stations:
        total_wait = s.avg_wait * 50
        assert s.avg_queue * k.makespan == pytest.approx(total_wait)


def test_all_zero_times_do_not_divide_by_zero():
    k, _ = kpis_for(lab([station("s1", 0)]), n=3)
    assert k.makespan == 0
    assert k.throughput_per_hour is None
    assert k.stations[0].utilisation == 0
    assert k.bottleneck is None


def test_no_arms_gives_empty_arm_list():
    k, _ = kpis_for(lab([station("s1", 1)]))
    assert k.arms == []
