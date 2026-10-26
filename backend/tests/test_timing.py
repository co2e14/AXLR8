import random
import statistics

import pytest

from axlr8.model import TimeSpec
from axlr8.timing import sample_time


def draws(spec, n=5000, seed=1):
    rng = random.Random(seed)
    return [sample_time(spec, rng) for _ in range(n)]


def test_fixed_returns_value():
    assert draws(TimeSpec(value=12, spread=5), n=10) == [12] * 10


@pytest.mark.parametrize("kind", ["normal", "uniform", "triangular"])
def test_zero_spread_returns_value(kind):
    assert draws(TimeSpec(value=3, kind=kind), n=10) == [3] * 10


@pytest.mark.parametrize("kind", ["uniform", "triangular"])
def test_bounded_kinds_stay_within_spread(kind):
    xs = draws(TimeSpec(value=10, kind=kind, spread=2))
    assert min(xs) >= 8 and max(xs) <= 12


def test_normal_is_centred_on_value():
    xs = draws(TimeSpec(value=100, kind="normal", spread=10))
    assert statistics.mean(xs) == pytest.approx(100, abs=1)


@pytest.mark.parametrize("kind", ["normal", "uniform", "triangular"])
def test_large_spread_never_negative(kind):
    assert min(draws(TimeSpec(value=1, kind=kind, spread=50))) >= 0
