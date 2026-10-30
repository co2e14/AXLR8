"""Searches for the station arrangement along the rail that lets the day finish soonest.

A layout is encoded as the order of stations on each side of the rail; stations are packed edge to
edge (with a gap) from the start of the rail, so no two overlap. Each candidate is scored by running
the full simulation with the run's settings and cobot count:

    cost = time until the last item finished
         + MOVE_WEIGHT  x total time the arms spend making moves (driving, picking, placing)
         + BLOCK_WEIGHT x total time moves waited for another arm to clear the rail

The search is simulated annealing (swap two stations, move one to another place or side, reverse a run
of stations), started from the current layout and from a traffic-based arrangement that puts stations
with many moves between them next to each other. It stops after `budget_s` seconds.
"""

import math
import random
import time
from collections import defaultdict
from dataclasses import dataclass

from pydantic import BaseModel, Field

from axlr8.engine import WorkflowError, simulate_with_rail
from axlr8.kpis import compute_kpis
from axlr8.model import Layout, Placement, RunSettings, Workflow

MOVE_WEIGHT = 0.25
BLOCK_WEIGHT = 0.5
MAX_STATIONS = 400


class Score(BaseModel):
    cost: float
    makespan: float
    move_time: float  # summed over all cobot moves
    blocked: float  # summed time moves waited for the rail
    blocked_moves: int


class OptimiseResult(BaseModel):
    layout: Layout
    before: Score
    after: Score
    evaluations: int
    seconds: float
    improved: bool


class OptimiseRequest(BaseModel):
    workflow: Workflow
    run: RunSettings = RunSettings()
    widths: dict[str, float] = Field(description="Footprint along the rail of each station, in metres")
    gap: float = Field(default=0.15, ge=0, le=5)
    margin: float = Field(default=0.6, ge=0, le=20)  # free rail before the first station
    budget_s: float = Field(default=15, gt=0, le=60)


@dataclass
class _Arrangement:
    sides: dict[int, list[str]]  # side -> stations in order along the rail

    def copy(self) -> "_Arrangement":
        return _Arrangement({s: list(v) for s, v in self.sides.items()})


def _pack(arr: _Arrangement, widths: dict[str, float], gap: float, margin: float) -> list[Placement]:
    out = []
    for side, keys in arr.sides.items():
        x = margin
        for k in keys:
            w = widths[k]
            out.append(Placement(station=k, x=round(x + w / 2, 3), side=side))
            x += w + gap
    return out


def _score(wf: Workflow, run: RunSettings, layout: Layout) -> Score:
    w = wf.model_copy(update={"layout": layout})
    events, rail = simulate_with_rail(w, run)
    makespan = compute_kpis(w, run, events).makespan
    moves = rail.moves if rail else []
    move_time = sum(m.end - m.start for m in moves)
    blocked = sum(m.blocked for m in moves)
    return Score(
        cost=makespan + MOVE_WEIGHT * move_time + BLOCK_WEIGHT * blocked,
        makespan=makespan,
        move_time=move_time,
        blocked=blocked,
        blocked_moves=sum(1 for m in moves if m.blocked > 1e-6),
    )


def _traffic(wf: Workflow, run: RunSettings, layout: Layout) -> dict[tuple[str, str], int]:
    """Cobot moves between each pair of stations in one run."""
    _, rail = simulate_with_rail(wf.model_copy(update={"layout": layout}), run)
    out: dict[tuple[str, str], int] = defaultdict(int)
    for m in rail.moves if rail else []:
        a, b = sorted((m.source, m.target))
        if a != b:
            out[(a, b)] += 1
    return out


def _by_traffic(keys: list[str], traffic: dict[tuple[str, str], int], widths: dict[str, float]) -> _Arrangement:
    """Greedy chain: start from the busiest station, keep adding the station with most moves to the
    stations already placed near the growing end; alternate sides so busy pairs face each other."""
    load: dict[str, int] = defaultdict(int)
    for (a, b), n in traffic.items():
        load[a] += n
        load[b] += n
    left = sorted(keys, key=lambda k: -load[k])
    chain = [left.pop(0)]
    while left:
        recent = chain[-3:]
        best = max(left, key=lambda k: (sum(traffic.get(tuple(sorted((k, r))), 0) for r in recent), load[k]))
        left.remove(best)
        chain.append(best)
    sides: dict[int, list[str]] = {1: [], -1: []}
    fill = {1: 0.0, -1: 0.0}
    for k in chain:  # the side that is shorter so far, so both sides advance together
        side = 1 if fill[1] <= fill[-1] else -1
        sides[side].append(k)
        fill[side] += widths[k]
    return _Arrangement(sides)


def _neighbour(arr: _Arrangement, rng: random.Random) -> _Arrangement:
    new = arr.copy()
    all_keys = [(s, i) for s, v in new.sides.items() for i in range(len(v))]
    kind = rng.random()
    if kind < 0.45 and len(all_keys) >= 2:  # swap two stations
        (s1, i1), (s2, i2) = rng.sample(all_keys, 2)
        new.sides[s1][i1], new.sides[s2][i2] = new.sides[s2][i2], new.sides[s1][i1]
    elif kind < 0.85:  # move one station somewhere else, maybe to the other side
        s1, i1 = rng.choice(all_keys)
        k = new.sides[s1].pop(i1)
        s2 = rng.choice([1, -1])
        new.sides[s2].insert(rng.randint(0, len(new.sides[s2])), k)
    else:  # reverse a run of stations on one side
        s1 = rng.choice([s for s, v in new.sides.items() if len(v) >= 2] or [1])
        v = new.sides[s1]
        if len(v) >= 2:
            i, j = sorted(rng.sample(range(len(v)), 2))
            v[i : j + 1] = reversed(v[i : j + 1])
    return new


def optimise(req: OptimiseRequest) -> OptimiseResult:
    wf, run = req.workflow, req.run
    if wf.layout is None or not wf.layout.placements:
        raise WorkflowError("the workflow has no layout to optimise")
    keys = [p.station for p in wf.layout.placements]
    if len(keys) > MAX_STATIONS:
        raise WorkflowError(f"too many stations to optimise (more than {MAX_STATIONS})")
    missing = [k for k in keys if k not in req.widths]
    if missing:
        raise WorkflowError(f"no width given for {', '.join(missing[:5])}")
    widths = {k: max(0.05, min(10.0, req.widths[k])) for k in keys}
    params = wf.layout.model_dump(exclude={"placements"})
    to_layout = lambda arr: Layout(placements=_pack(arr, widths, req.gap, req.margin), **params)  # noqa: E731

    started = time.monotonic()
    before = _score(wf, run, wf.layout)  # raises WorkflowError when the run cannot happen
    if not wf.layout.placements or before.move_time == 0:
        return OptimiseResult(layout=wf.layout, before=before, after=before, evaluations=1, seconds=0.0, improved=False)

    current_order = _Arrangement({
        side: [p.station for p in sorted(wf.layout.placements, key=lambda p: p.x) if p.side == side] for side in (1, -1)
    })
    traffic = _traffic(wf, run, wf.layout)
    starts = [current_order, _by_traffic(keys, traffic, widths)]
    scored = [(_score(wf, run, to_layout(a)), a) for a in starts]
    evaluations = 2 + len(scored)
    cur_score, cur = min(scored, key=lambda x: x[0].cost)
    best_score, best = cur_score, cur

    rng = random.Random(run.seed if run.seed is not None else 0)
    t0 = max(1.0, 0.02 * cur_score.cost)  # temperature: early on, accept moves up to ~2% worse
    while (elapsed := time.monotonic() - started) < req.budget_s:
        temp = t0 * (1 - elapsed / req.budget_s) + 1e-6
        cand = _neighbour(cur, rng)
        try:
            s = _score(wf, run, to_layout(cand))
        except WorkflowError:
            continue
        evaluations += 1
        if s.cost <= cur_score.cost or rng.random() < math.exp(-(s.cost - cur_score.cost) / temp):
            cur, cur_score = cand, s
            if s.cost < best_score.cost - 1e-9:
                best, best_score = cand, s

    improved = best_score.cost < before.cost - 1e-6
    return OptimiseResult(
        layout=to_layout(best) if improved else wf.layout,
        before=before,
        after=best_score if improved else before,
        evaluations=evaluations,
        seconds=round(time.monotonic() - started, 2),
        improved=improved,
    )
