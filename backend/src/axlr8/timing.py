"""Draw concrete durations from a TimeSpec."""

import random

from axlr8.model import TimeSpec


def sample_time(spec: TimeSpec, rng: random.Random, variation: float = 0.0) -> float:
    """`variation`: for a time with no spread of its own, vary it by up to this fraction either way
    (triangular around the value), so repeated runs show how sensitive the results are."""
    if spec.kind == "fixed" or spec.spread == 0:
        if variation > 0 and spec.value > 0:
            return rng.triangular(spec.value * (1 - variation), spec.value * (1 + variation), spec.value)
        return spec.value
    lo, hi = spec.value - spec.spread, spec.value + spec.spread
    if spec.kind == "normal":
        t = rng.gauss(spec.value, spec.spread)
    elif spec.kind == "uniform":
        t = rng.uniform(lo, hi)
    else:
        t = rng.triangular(lo, hi, spec.value)
    return max(0.0, t)
