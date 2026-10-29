import pytest
from pydantic import ValidationError

from axlr8.model import Loop, RunSettings
from conftest import dev, route, step, wf


def test_loop_is_unrolled_in_sequence():
    r = route("r", [step("a"), step("b"), step("c"), step("d")], loop=Loop(start=1, end=2, times=3))
    assert r.sequence() == [0, 1, 2, 1, 2, 1, 2, 3]


def test_units_follow_purchase_phase():
    d = dev("x", 1, phases=[1, 3, 4])
    assert d.units_in_phase(2) == [1]
    assert d.units_in_phase(4) == [1, 2, 3]
    assert dev("m", 0, units=None).units_in_phase(1) is None


@pytest.mark.parametrize(
    "build, message",
    [
        (lambda: wf([dev("a", 1), dev("a", 2)], [route("r", [step("a")])]), "device ids must be unique"),
        (lambda: wf([dev("a", 1)], [route("r", [step("a")]), route("r", [step("a")])]), "route ids must be unique"),
        (lambda: wf([dev("a", 1)], [route("r", [step("zz")])]), "unknown device 'zz'"),
        (lambda: wf([dev("a", 1)], [route("r", [step("a", spawn=[{"route": "nope"}])])]), "unknown route 'nope'"),
        (lambda: wf([dev("a", 1)], [route("r", [step("a")], loop=Loop(start=0, end=3))]), "loop"),
        (lambda: wf([dev("a", 1), dev("b", 1)], [route("r", [step("a", "b", units=[1])])]), "one device"),
    ],
)
def test_invalid_workflows_are_rejected(build, message):
    with pytest.raises(ValidationError, match=message):
        build()


@pytest.mark.parametrize("bad", [float("inf"), float("nan"), -1])
def test_bad_times_rejected(bad):
    with pytest.raises(ValidationError):
        dev("a", bad)


def test_phase_bounds():
    with pytest.raises(ValidationError):
        RunSettings(phase=5)


def test_layout_is_optional_and_round_trips():
    w = wf([dev("a", 1)], [route("r", [step("a")])])
    assert w.layout is None
    data = w.model_dump()
    data["layout"] = {"placements": [{"station": "a:1", "x": 1.5, "side": -1}], "rail_speed": 1.2}
    again = type(w).model_validate(data)
    assert again.layout.placements[0].side == -1
    assert again.layout.rail_speed == 1.2


def test_layout_rejects_a_bad_side():
    w = wf([dev("a", 1)], [route("r", [step("a")])])
    with pytest.raises(ValidationError):
        type(w).model_validate({**w.model_dump(), "layout": {"placements": [{"station": "a", "x": 0, "side": 0}]}})
