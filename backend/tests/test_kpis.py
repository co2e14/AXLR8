import pytest

from axlr8.kpis import compute_kpis
from axlr8.model import RunSettings, TimeSpec
from conftest import dev, route, run, step, wf


def kpis(w, **kw):
    return compute_kpis(w, RunSettings(**kw), run(w, **kw))


def by_id(rows, rid):
    return next(r for r in rows if r.id == rid)


def test_device_queue_statistics():
    k = kpis(wf([dev("p", 10)], [route("r", [step("p")], count=3)]))
    assert k.makespan == 30
    p = by_id(k.devices, "p")
    assert (p.units, p.uses) == (1, 3)
    assert p.utilisation == pytest.approx(1.0)
    assert (p.avg_wait, p.max_wait, p.max_queue) == (10, 20, 2)
    r = by_id(k.routes, "r")
    assert (r.released, r.completed, r.avg_cycle_time) == (3, 3, 20)
    assert r.throughput_per_hour == pytest.approx(360)


def test_join_counts_one_device_run():
    w = wf([dev("echo", 7)], [route("a", [step("echo", join="k")]), route("b", [step("echo", join="k")])])
    e = by_id(kpis(w).devices, "echo")
    assert e.uses == 1 and e.utilisation == pytest.approx(1.0)


def test_utilisation_is_shared_over_units():
    k = kpis(wf([dev("p", 10, units=2)], [route("r", [step("p")], count=2)]))
    assert by_id(k.devices, "p").utilisation == pytest.approx(1.0)
    k = kpis(wf([dev("p", 10, units=2)], [route("r", [step("p")], count=1)]))
    assert by_id(k.devices, "p").utilisation == pytest.approx(0.5)


def test_unlimited_devices_are_never_the_bottleneck():
    k = kpis(wf([dev("map", 50, units=None), dev("p", 1)], [route("r", [step("map"), step("p")])]))
    assert by_id(k.devices, "map").utilisation is None
    assert k.bottleneck.id == "p"


def test_cobot_statistics_and_cobot_bottleneck():
    w = wf([dev("a", 1)], [route("r", [step("a")], count=2)], move=10)
    k = kpis(w, cobots=1)
    assert k.cobots.count == 1 and k.cobots.moves == 2
    assert k.cobots.avg_wait == pytest.approx(5)
    assert k.cobots.utilisation == pytest.approx(20 / 21)
    assert k.bottleneck.kind == "cobot"


def test_device_blocked_while_waiting_for_a_cobot():
    # each item finishes on `a` while the only cobot is busy moving the other one
    w = wf([dev("a", 1), dev("b", 0)], [route("r", [step("a"), step("b")], count=2)], move=5)
    k = kpis(w, cobots=1)
    a = by_id(k.devices, "a")
    assert a.blocked_fraction * k.makespan == pytest.approx(8)  # 6-10 s and 11-15 s


def test_dwell_does_not_count_as_busy():
    w = wf([dev("a", 10)], [route("r", [step("a", dwell=TimeSpec(value=90))])])
    k = kpis(w)
    assert k.makespan == 100
    a = by_id(k.devices, "a")
    assert a.utilisation == pytest.approx(0.1) and a.blocked_fraction == 0


def test_keeps_up_with_release_rate():
    ok = kpis(wf([dev("p", 600)], [route("r", [step("p")], count=8, interval=900)]))
    late = kpis(wf([dev("p", 1200)], [route("r", [step("p")], count=8, interval=900)]))
    assert by_id(ok.routes, "r").keeps_up is True
    assert by_id(late.routes, "r").keeps_up is False


def test_stuck_items_are_reported():
    w = wf([dev("echo", 7)], [route("a", [step("echo", join="k")], count=2), route("b", [step("echo", join="k")])])
    k = kpis(w)
    assert [(s.route, s.step) for s in k.stuck] == [("a", 0)]
    assert by_id(k.routes, "a").completed == 1


def test_bottleneck_ranking_is_sorted():
    w = wf([dev("slow", 30), dev("fast", 5)], [route("r", [step("fast"), step("slow")], count=4)])
    k = kpis(w)
    assert [b.id for b in k.ranking[:2]] == ["slow", "fast"]
    assert k.bottleneck.id == "slow"
