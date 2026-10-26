import pytest
from pydantic import ValidationError

from axlr8.model import INPUT, OUTPUT, RunSettings
from conftest import lab, station, transfer


def test_locations_wrap_stations_with_input_and_output():
    cfg = lab([station("a", 1), station("b", 2)])
    assert cfg.locations() == [INPUT, "a", "b", OUTPUT]


def test_missing_transfer_defaults_to_instant_without_arm():
    cfg = lab([station("a", 1)])
    t = cfg.transfer_for(INPUT, "a")
    assert t.time.value == 0 and t.arm is None


def test_declared_transfer_is_returned():
    cfg = lab([station("a", 1)], [transfer(INPUT, "a", 7, arm="cobot")], arms=["cobot"])
    t = cfg.transfer_for(INPUT, "a")
    assert t.time.value == 7 and t.arm == "cobot"


@pytest.mark.parametrize(
    "build, message",
    [
        (lambda: lab([station("a", 1), station("a", 2)]), "unique"),
        (lambda: lab([station("input", 1)]), "reserved"),
        (lambda: lab([station("a", 1)], [transfer(INPUT, "a", 1, arm="ghost")]), "unknown arm"),
        (lambda: lab([station("a", 1), station("b", 1)], [transfer(INPUT, "b", 1)]), "consecutive"),
        (lambda: lab([station("a", 1)], [transfer(INPUT, "a", 1), transfer(INPUT, "a", 2)]), "duplicate"),
        (lambda: lab([station("a", 1, batch_size=4, buffer_size=2)]), "buffer_size"),
        (lambda: lab([]), "at least 1"),
    ],
)
def test_invalid_labs_are_rejected_with_a_clear_message(build, message):
    with pytest.raises(ValidationError, match=message):
        build()


@pytest.mark.parametrize("n", [0, 2001])
def test_num_samples_is_bounded(n):
    with pytest.raises(ValidationError):
        RunSettings(num_samples=n)


def test_negative_times_rejected():
    with pytest.raises(ValidationError):
        station("a", -1)


def test_unknown_station_in_transfer_is_named():
    with pytest.raises(ValidationError, match="unknown location 'zz'"):
        lab([station("a", 1)], [transfer("a", "zz", 1)])


@pytest.mark.parametrize("bad", [float("inf"), float("nan")])
def test_non_finite_times_rejected(bad):
    with pytest.raises(ValidationError):
        station("a", bad)
