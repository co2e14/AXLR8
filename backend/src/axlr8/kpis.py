"""Summary statistics derived purely from the engine's event log.

Statistics cover time 0 onwards. On a follow-on day, work carried over from day 1 has events at
negative times; only its share after time 0 counts.
"""

from collections import defaultdict
from statistics import mean
from typing import Literal

from pydantic import BaseModel

from axlr8.engine import plan_run
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


class IncubatorStats(BaseModel):
    """One unit of a device that stores plates."""

    id: str
    name: str
    unit: int
    capacity: int | None
    imager: bool
    stored_start: int  # plates inside at time 0: there at the start of the day, or stored the day before
    stored_end: int  # plates inside at the end: those, plus plates stored, minus plates taken out for a soak
    stored_today: int  # plates put in for storage from time 0
    taken_out: int  # stored plates taken out from time 0 (grown plates retrieved for a soak)
    images: int  # plates imaged from time 0: as they went in, for a soak, or on the growth schedule
    imaging_time: float  # seconds spent imaging from time 0, over the whole imaging window
    imaging_share: float  # of the imaging window (24 h after the last day starts) spent imaging
    scheduled: int  # growth images done on schedule from time 0
    avg_delay: float  # scheduled image: due -> started
    max_delay: float


class DayStats(BaseModel):
    """One day of a multi-day run."""

    day: int  # 1-based
    start: float
    released: int  # items released that day (spawned items count on the day they start)
    completed: int  # of those, how many finished (on any day)
    last_finish: float | None  # last of them finished this long after the day started
    stored_end: int  # plates in all incubators at the end of the day
    soaks_grown: int  # soaks that took a plate grown in the run
    soaks_stock: int  # soaks that took a plate that was inside at the start
    images: int  # plates imaged that day
    imaging_hours: float
    growth_delay: float  # growth images started that day: average time after they were due
    cobot_moves: int


class Bottleneck(BaseModel):
    id: str
    name: str
    kind: Literal["device", "cobot"]
    utilisation: float


class Skipped(BaseModel):
    route: str
    reason: str


class Kpis(BaseModel):
    makespan: float
    skipped: list[Skipped]  # switched-on routes that cannot run with this phase's equipment
    warnings: list[str]
    released: int
    completed: int
    carried_over: int  # items still in the system from the day before (follow-on days)
    carried_completed: int  # of those, how many finished
    devices: list[DeviceStats]
    incubators: list[IncubatorStats]
    days: list[DayStats]  # empty for a one-day run
    cobots: CobotStats
    routes: list[RouteStats]
    stuck: list[Stuck]
    ranking: list[Bottleneck]
    bottleneck: Bottleneck | None


def _share(amount: float, total: float) -> float:
    return amount / total if total > 0 else 0.0


def _after_zero(start: float, end: float, stop: float = float("inf")) -> float:
    return max(0.0, min(end, stop) - max(start, 0.0))


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
            if e.t >= 0:
                waits[e.device].append(e.t - arrive[e.item])
                queue[e.device] += [(max(arrive[e.item], 0.0), 1), (e.t, -1)]
            if e.unit is None:
                uses_unlimited[e.device] += e.t >= 0
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
        elif e.kind == "image_start":
            runs[(e.device, e.unit, e.t)] = [e.t, e.t, e.t]
            current[-e.item] = (e.device, e.unit, e.t)  # negative key: kept apart from the item's own steps
        elif e.kind == "image_end":
            key = current.pop(-e.item)
            runs[key][1] = runs[key][2] = e.t

    out = []
    for d in wf.devices:
        units = d.units_in_phase(run.phase)
        mine = [(k, v) for k, v in runs.items() if k[0] == d.id and v[2] > 0]
        # Imaging after the last item finished is left out here; the incubator stats cover it.
        busy = sum(_after_zero(v[0], v[1], makespan) for _, v in mine)
        blocked = sum(_after_zero(v[1], v[2], makespan) for _, v in mine)
        per_unit: dict[int, float] = {}
        for (_, u, _), v in mine:
            per_unit[u] = per_unit.get(u, 0.0) + _after_zero(v[0], v[1], makespan)
        unit_time = (len(units) if units else 0) * makespan
        w = waits.get(d.id, [])
        out.append(
            DeviceStats(
                id=d.id,
                name=d.name,
                units=None if units is None else len(units),
                uses=sum(0 <= k[2] <= makespan for k, _ in mine) if units is not None else uses_unlimited[d.id],
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
            if e.t >= 0:
                waits.append(e.t - ready[e.item])
        elif e.kind == "move_end" and e.cobot:
            busy += _after_zero(started.pop(e.item), e.t)
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
    carried = {e.item for e in events if e.carried}
    for e in events:
        if e.kind == "released":
            released[e.item] = e.t
            route_of[e.item] = e.route
        elif e.kind == "completed":
            completed[e.item] = e.t
    out = []
    for r in plan_run(wf, run).routes:
        items = sorted(i for i, rid in route_of.items() if rid == r.id and i not in carried)
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


def _imaging_window(run: RunSettings) -> float:
    """Seconds from time 0 until stored plates stop being imaged: a day after the last day starts."""
    days = 1 if run.scenario == "follow_on" else run.days
    return (days - 1) * run.day_length + 24 * 3600


def _incubator_stats(wf: Workflow, run: RunSettings, events: list[Event]) -> list[IncubatorStats]:
    route_by_id = {r.id: r for r in wf.routes}
    stored_start: dict[tuple[str, int], int] = defaultdict(int)
    stored_end: dict[tuple[str, int], int] = defaultdict(int)
    images: dict[tuple[str, int], list[float]] = defaultdict(list)  # durations
    delays: dict[tuple[str, int], list[float]] = defaultdict(list)
    started: dict[int, Event] = {}
    stored_today: dict[tuple[str, int], int] = defaultdict(int)
    taken_out: dict[tuple[str, int], int] = defaultdict(int)
    capacity_devices = {d.id for d in wf.devices if d.capacity is not None}
    for e in events:
        key = (e.device, e.unit)
        if e.kind == "completed" and e.device is not None:
            stored_end[key] += 1
            stored_start[key] += e.t < 0
            stored_today[key] += e.t >= 0
        elif (e.kind == "process_end" and e.step == 0 and e.device in capacity_devices
              and not route_by_id[e.route].steps[0].store and e.t >= 0):
            taken_out[key] += 1
            stored_end[key] -= 1
        elif (e.kind == "process_end" and e.step == 0 and e.device in capacity_devices
              and not route_by_id[e.route].steps[0].store):
            stored_end[key] -= 1  # taken out before time 0 (the day before a follow-on day)
            stored_start[key] -= 1
        elif e.kind == "image_start":
            started[e.item] = e
        elif e.kind == "image_end":
            s = started.pop(e.item)
            if s.t >= 0:
                images[key].append(e.t - s.t)
                delays[key].append(s.t - (s.due if s.due is not None else s.t))
        elif e.kind == "process_start" and e.unit is not None and route_by_id[e.route].steps[e.step].image:
            started[e.item] = e
        elif e.kind == "process_end" and e.item in started and started[e.item].kind == "process_start":
            s = started.pop(e.item)
            if s.t >= 0:
                images[key].append(e.t - s.t)
    out = []
    for d in wf.devices:
        if d.capacity is None and not d.imager_units:
            continue
        for u in d.units_in_phase(run.phase) or []:
            key = (d.id, u)
            busy = sum(images[key])
            initial = d.stored_at_start[u - 1] if d.stored_at_start and u <= len(d.stored_at_start) else 0
            w = delays[key]
            out.append(
                IncubatorStats(
                    id=d.id,
                    name=d.name,
                    unit=u,
                    capacity=d.capacity[u - 1] if d.capacity and u <= len(d.capacity) else None,
                    imager=u in d.imager_units,
                    stored_start=initial + stored_start[key],
                    stored_end=max(0, initial + stored_end[key]),
                    stored_today=stored_today[key],
                    taken_out=taken_out[key],
                    images=len(images[key]),
                    imaging_time=busy,
                    imaging_share=busy / _imaging_window(run),
                    scheduled=len(w),
                    avg_delay=mean(w) if w else 0.0,
                    max_delay=max(w, default=0.0),
                )
            )
    return out


def _day_stats(wf: Workflow, run: RunSettings, events: list[Event], makespan: float) -> list[DayStats]:
    n = run.days if run.scenario != "follow_on" else 1
    if n <= 1:
        return []
    length = run.day_length
    route_by_id = {r.id: r for r in wf.routes}
    capacity_devices = {d.id for d in wf.devices if d.capacity is not None}
    initial = sum(
        d.stored_at_start[u - 1]
        for d in wf.devices
        if d.stored_at_start
        for u in d.units_in_phase(run.phase) or []
        if u <= len(d.stored_at_start)
    )
    released: dict[int, float] = {}
    completed: dict[int, float] = {}
    changes: list[tuple[float, int]] = []  # incubator plates in/out
    soaks: list[tuple[float, bool]] = []  # (t, from a grown plate)
    imaging: list[tuple[float, float, float | None]] = []  # (start, end, due)
    open_image: dict[int, Event] = {}
    moves: list[float] = []
    for e in events:
        if e.kind == "released":
            released[e.item] = e.t
        elif e.kind == "completed":
            completed[e.item] = e.t
            if e.device is not None:
                changes.append((e.t, 1))
        elif e.kind == "move_start" and e.cobot:
            moves.append(e.t)
        elif e.kind == "image_start":
            open_image[-e.item] = e
        elif e.kind == "image_end":
            s = open_image.pop(-e.item)
            imaging.append((s.t, e.t, s.due))
        elif e.kind == "process_start" and e.unit is not None and route_by_id[e.route].steps[e.step].image:
            open_image[e.item] = e
        elif e.kind == "process_end":
            s = open_image.pop(e.item, None)
            if s is not None:
                imaging.append((s.t, e.t, None))
            if e.step == 0 and e.device in capacity_devices and not route_by_id[e.route].steps[0].store:
                changes.append((e.t, -1))
        if e.kind == "process_start" and e.step == 0 and e.device in capacity_devices and not route_by_id[e.route].steps[0].store:
            soaks.append((e.t, e.takes is not None))
    out = []
    for k in range(n):
        start, end = k * length, (k + 1) * length if k < n - 1 else max(makespan, (k + 1) * length)
        mine = [i for i, t in released.items() if start <= t < end]
        done = [completed[i] - start for i in mine if i in completed]
        images = [(a, b, due) for a, b, due in imaging if start <= a < end]
        late = [a - due for a, _, due in images if due is not None]
        out.append(DayStats(
            day=k + 1,
            start=start,
            released=len(mine),
            completed=len(done),
            last_finish=max(done) if done else None,
            stored_end=max(0, initial + sum(d for t, d in changes if t < end)),
            soaks_grown=sum(1 for t, g in soaks if start <= t < end and g),
            soaks_stock=sum(1 for t, g in soaks if start <= t < end and not g),
            images=len(images),
            imaging_hours=sum(b - a for a, b, _ in images) / 3600,
            growth_delay=mean(late) if late else 0.0,
            cobot_moves=sum(1 for t in moves if start <= t < end),
        ))
    return out


def compute_kpis(wf: Workflow, run: RunSettings, events: list[Event]) -> Kpis:
    # The day's work ends with the last item; stored plates go on being imaged after that.
    makespan = max((e.t for e in events if e.kind not in ("image_start", "image_end")), default=0.0)
    devices = _device_stats(wf, run, events, makespan)
    cobots = _cobot_stats(wf, run, events, makespan)
    routes = _route_stats(wf, run, events, makespan)

    last: dict[int, Event] = {}
    finished = set()
    for e in events:
        if e.kind not in ("image_start", "image_end"):
            last[e.item] = e
        if e.kind == "completed":
            finished.add(e.item)
    stuck = [Stuck(item=i, route=e.route, step=e.step, since=e.t) for i, e in sorted(last.items()) if i not in finished]

    ranking = [
        Bottleneck(id=d.id, name=d.name, kind="device", utilisation=d.utilisation)
        for d in devices
        if d.utilisation is not None and d.utilisation > 0
    ]
    if cobots.utilisation:
        ranking.append(Bottleneck(id="cobots", name="Cobots", kind="cobot", utilisation=cobots.utilisation))
    ranking.sort(key=lambda b: -b.utilisation)

    # Carried over: day-1 work still under way at time 0 (not plates sitting in storage).
    done_before = {e.item for e in events if e.kind == "completed" and e.t < 0}
    carried = {e.item for e in events if e.carried} - done_before
    plan = plan_run(wf, run)
    return Kpis(
        makespan=makespan,
        skipped=[Skipped(route=rid, reason=why) for rid, why in plan.skipped],
        warnings=plan.warnings,
        released=sum(r.released for r in routes),
        completed=sum(r.completed for r in routes),
        carried_over=len(carried),
        carried_completed=sum(1 for e in events if e.kind == "completed" and e.item in carried),
        devices=devices,
        incubators=_incubator_stats(wf, run, events),
        days=_day_stats(wf, run, events, makespan),
        cobots=cobots,
        routes=routes,
        stuck=stuck,
        ranking=ranking,
        bottleneck=ranking[0] if ranking else None,
    )
