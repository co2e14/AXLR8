"""Draw concrete durations from a TimeSpec."""

import random

from axlr8.model import TimeSpec


def sample_time(spec: TimeSpec, rng: random.Random) -> float:
    if spec.kind == "fixed" or spec.spread == 0:
        return spec.value
    lo, hi = spec.value - spec.spread, spec.value + spec.spread
    if spec.kind == "normal":
        t = rng.gauss(spec.value, spec.spread)
    elif spec.kind == "uniform":
        t = rng.uniform(lo, hi)
    else:
        t = rng.triangular(lo, hi, spec.value)
    return max(0.0, t)
