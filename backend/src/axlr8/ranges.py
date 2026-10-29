"""Result ranges: the same run repeated with different random seeds.

Times vary between repeats only where they have a spread (a device, step or move time that is not
`fixed`), or when the run sets `time_variation`. With every time fixed, all repeats are identical.
"""

from statistics import median

from pydantic import BaseModel

from axlr8.engine import WorkflowError, simulate_with_rail
from axlr8.kpis import Kpis, compute_kpis
from axlr8.model import RunSettings, Workflow

MAX_DAY_RUNS = 200  # runs x days in one request


class Spread(BaseModel):
    min: float
    low: float  # 10th percentile
    median: float
    high: float  # 90th percentile
    max: float


class RouteRange(BaseModel):
    avg_cycle: Spread | None
    keeps_up: int  # in how many runs it kept up


class Ranges(BaseModel):
    runs: int
    seeds: list[int]
    makespan: Spread
    completed: Spread
    cobot_utilisation: Spread | None
    devices: dict[str, Spread]  # utilisation
    routes: dict[str, RouteRange]
    growth_delay: Spread  # average lateness of growth images
    bottleneck: dict[str, int]  # how often each resource was the busiest


def _quantile(xs: list[float], q: float) -> float:
    s = sorted(xs)
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def spread(xs: list[float]) -> Spread:
    return Spread(min=min(xs), low=_quantile(xs, 0.1), median=median(xs), high=_quantile(xs, 0.9), max=max(xs))


def repeat(wf: Workflow, run: RunSettings, first: Kpis) -> Ranges:
    """`first` is the run with `run.seed`; the others use the following seeds."""
    days = 2 if run.scenario == "follow_on" else run.days
    if run.runs * days > MAX_DAY_RUNS:
        raise WorkflowError(f"too many runs: {run.runs} runs of {days} days is more than {MAX_DAY_RUNS} simulated days")
    base = run.seed if run.seed is not None else 1
    seeds = [base + k for k in range(run.runs)]
    all_kpis = [first]
    for s in seeds[1:]:
        r = run.model_copy(update={"seed": s, "runs": 1})
        events, _ = simulate_with_rail(wf, r)
        all_kpis.append(compute_kpis(wf, r, events))

    def growth(k: Kpis) -> float:
        n = sum(i.scheduled for i in k.incubators)
        return sum(i.avg_delay * i.scheduled for i in k.incubators) / n if n else 0.0

    devices = {}
    for d in first.devices:
        vals = [next((x.utilisation for x in k.devices if x.id == d.id), None) for k in all_kpis]
        if all(v is not None for v in vals):
            devices[d.id] = spread(vals)
    routes = {}
    for r in first.routes:
        rows = [next((x for x in k.routes if x.id == r.id), None) for k in all_kpis]
        cycles = [x.avg_cycle_time for x in rows if x is not None and x.avg_cycle_time is not None]
        routes[r.id] = RouteRange(avg_cycle=spread(cycles) if cycles else None, keeps_up=sum(1 for x in rows if x and x.keeps_up))
    busiest: dict[str, int] = {}
    for k in all_kpis:
        if k.bottleneck:
            busiest[k.bottleneck.id] = busiest.get(k.bottleneck.id, 0) + 1
    cobots = [k.cobots.utilisation for k in all_kpis]
    return Ranges(
        runs=len(all_kpis),
        seeds=seeds,
        makespan=spread([k.makespan for k in all_kpis]),
        completed=spread([k.completed for k in all_kpis]),
        cobot_utilisation=spread(cobots) if all(c is not None for c in cobots) else None,
        devices=devices,
        routes=routes,
        growth_delay=spread([growth(k) for k in all_kpis]),
        bottleneck=busiest,
    )
