"""Summary statistics derived purely from the engine's event log."""

from collections import defaultdict
from statistics import mean
from typing import Literal

from pydantic import BaseModel

from axlr8.engine import active_routes
from axlr8.model import Event, RunSettings, Workflow


class DeviceStats(BaseModel):
    id: str
    name: str
    units: int | None  # None = unlimited
    uses: int
    utilisation: float | None  # share of unit-time spent processing; None when unlimited
    blocked_fraction: float  # share of unit-time holding finished items waiting to be picked up
    avg_wait: float  # arrival at the step -> processing starts (includes waiting for a join partner)
    max_wait: float
    max_queue: int
    unit_utilisation: dict[int, float]


class CobotStats(BaseModel):
    count: int
    utilisation: float | None
    moves: int
    avg_wait: float  # ready to move -> a cobot picks it up


class RouteStats(BaseModel):
    id: str
    name: str
    released: int
    completed: int
    avg_cycle_time: float | None
    min_cycle_time: float | None
    max_cycle_time: float | None
    throughput_per_hour: float | None
    keeps_up: bool | None  # None when the route has no steady release rate to keep up with


class Stuck(BaseModel):
    item: int
    route: str
    step: int
    since: float


class Bottleneck(BaseModel):
    id: str
    name: str
    kind: Literal["device", "cobot"]
    utilisation: float


class Kpis(BaseModel):
    makespan: float
    released: int
    completed: int
    devices: list[DeviceStats]
    cobots: CobotStats
    routes: list[RouteStats]
    stuck: list[Stuck]
    ranking: list[Bottleneck]
    bottleneck: Bottleneck | None


def _share(amount: float, total: float) -> float:
    return amount / total if total > 0 else 0.0


def _queue_peak(changes: list[tuple[float, int]]) -> int:
    count = peak = 0
    for _, delta in sorted(changes):  # -1 before +1 at equal times
        count += delta
        peak = max(peak, count)
    return peak


def _device_stats(wf: Workflow, run: RunSettings, events: list[Event], makespan: float) -> list[DeviceStats]:
    route_by_id = {r.id: r for r in wf.routes}
    runs: dict[tuple, list[float]] = {}  # (device, unit, start) -> [start, end, release]
    arrive: dict[int, float] = {}
    current: dict[int, tuple] = {}  # item -> run key it is holding
    waits: dict[str, list[float]] = defaultdict(list)
    queue: dict[str, list[tuple[float, int]]] = defaultdict(list)
    uses_unlimited: dict[str, int] = defaultdict(int)

    def let_go(item: int, t: float):
        key = current.pop(item, None)
        if key is not None:
            runs[key][2] = max(runs[key][2], t)

    for e in events:
        if e.kind == "move_end":
            arrive[e.item] = e.t
        elif e.kind == "process_start":
            waits[e.device].append(e.t - arrive[e.item])
            queue[e.device] += [(arrive[e.item], 1), (e.t, -1)]
            if e.unit is None:
                uses_unlimited[e.device] += 1
            else:
                key = (e.device, e.unit, e.t)
                runs.setdefault(key, [e.t, e.t, e.t])
                current[e.item] = key
        elif e.kind == "process_end":
            key = current.get(e.item)
            if key is not None:
                runs[key][1] = runs[key][2] = e.t
                if route_by_id[e.route].steps[e.step].dwell is not None:
                    current.pop(e.item)
        elif e.kind in ("move_start", "completed"):
            let_go(e.item, e.t)

    out = []
    for d in wf.devices:
        units = d.units_in_phase(run.phase)
        mine = [(k, v) for k, v in runs.items() if k[0] == d.id]
        busy = sum(v[1] - v[0] for _, v in mine)
        blocked = sum(v[2] - v[1] for _, v in mine)
        per_unit: dict[int, float] = {}
        for (_, u, _), v in mine:
            per_unit[u] = per_unit.get(u, 0.0) + v[1] - v[0]
        unit_time = (len(units) if units else 0) * makespan
        w = waits.get(d.id, [])
        out.append(
            DeviceStats(
                id=d.id,
                name=d.name,
                units=None if units is None else len(units),
                uses=len(mine) if units is not None else uses_unlimited[d.id],
                utilisation=None if units is None else _share(busy, unit_time),
                blocked_fraction=0.0 if units is None else _share(blocked, unit_time),
                avg_wait=mean(w) if w else 0.0,
                max_wait=max(w, default=0.0),
                max_queue=_queue_peak(queue.get(d.id, [])),
                unit_utilisation={u: _share(per_unit.get(u, 0.0), makespan) for u in (units or [])},
            )
        )
    return out


def _cobot_stats(wf: Workflow, run: RunSettings, events: list[Event], makespan: float) -> CobotStats:
    count = run.cobots if run.cobots is not None else wf.cobots_by_phase.get(run.phase, 0)
    ready: dict[int, float] = {}
    started: dict[int, float] = {}
    busy, waits = 0.0, []
    for e in events:
        if e.kind == "move_ready":
            ready[e.item] = e.t
        elif e.kind == "move_start" and e.cobot:
            started[e.item] = e.t
            waits.append(e.t - ready[e.item])
        elif e.kind == "move_end" and e.cobot:
            busy += e.t - started.pop(e.item)
    return CobotStats(
        count=count,
        utilisation=_share(busy, count * makespan) if count > 0 else None,
        moves=len(waits),
        avg_wait=mean(waits) if waits else 0.0,
    )


def _keeps_up(cycles: list[float], released: int, completed: int, interval: float) -> bool | None:
    if interval <= 0 or released < 4:
        return None
    if completed < released:
        return False
    q = max(1, len(cycles) // 4)
    return mean(cycles[-q:]) <= mean(cycles[:q]) * 1.25


def _route_stats(wf: Workflow, run: RunSettings, events: list[Event], makespan: float) -> list[RouteStats]:
    released: dict[int, float] = {}
    completed: dict[int, float] = {}
    route_of: dict[int, str] = {}
    for e in events:
        if e.kind == "released":
            released[e.item] = e.t
            route_of[e.item] = e.route
        elif e.kind == "completed":
            completed[e.item] = e.t
    out = []
    for r in active_routes(wf, run):
        items = sorted(i for i, rid in route_of.items() if rid == r.id)
        cycles = [completed[i] - released[i] for i in items if i in completed]
        n_done = len(cycles)
        out.append(
            RouteStats(
                id=r.id,
                name=r.name,
                released=len(items),
                completed=n_done,
                avg_cycle_time=mean(cycles) if cycles else None,
                min_cycle_time=min(cycles, default=None),
                max_cycle_time=max(cycles, default=None),
                throughput_per_hour=n_done / makespan * 3600 if makespan > 0 and n_done else None,
                keeps_up=_keeps_up(cycles, len(items), n_done, 0 if run.single else r.interval),
            )
        )
    return out


def compute_kpis(wf: Workflow, run: RunSettings, events: list[Event]) -> Kpis:
    makespan = max((e.t for e in events), default=0.0)
    devices = _device_stats(wf, run, events, makespan)
    cobots = _cobot_stats(wf, run, events, makespan)
    routes = _route_stats(wf, run, events, makespan)

    last: dict[int, Event] = {}
    for e in events:
        last[e.item] = e
    stuck = [Stuck(item=i, route=e.route, step=e.step, since=e.t) for i, e in sorted(last.items()) if e.kind != "completed"]

    ranking = [
        Bottleneck(id=d.id, name=d.name, kind="device", utilisation=d.utilisation)
        for d in devices
        if d.utilisation is not None and d.utilisation > 0
    ]
    if cobots.utilisation:
        ranking.append(Bottleneck(id="cobots", name="Cobots", kind="cobot", utilisation=cobots.utilisation))
    ranking.sort(key=lambda b: -b.utilisation)

    return Kpis(
        makespan=makespan,
        released=sum(r.released for r in routes),
        completed=sum(r.completed for r in routes),
        devices=devices,
        cobots=cobots,
        routes=routes,
        stuck=stuck,
        ranking=ranking,
        bottleneck=ranking[0] if ranking else None,
    )
