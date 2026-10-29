"""SimPy discrete-event simulation of items flowing along routes that share devices.

Produces a time-ordered event log; all statistics are derived from it in kpis.py.

Flow of one item through one step:
  1. `move_ready`: it is ready to leave where it is (it keeps that device occupied meanwhile).
  2. It waits for a cobot if the move needs one, then `move_start` (previous device freed) ...
  3. ... `move_end` at the step.
  4. If the step is a join, it waits for an item from the partner route at the same join.
  5. It takes a free unit of one of the step's devices: `process_start` ... `process_end`.
  6. Optional dwell (e.g. incubation) frees the device, then `dwell_end`.

A route whose last step stores the plate (an incubator) leaves it there: it keeps a slot in that
unit, and a unit with an imager images it again at each hour of the imaging schedule.
"""

import random
from collections.abc import Callable
from dataclasses import dataclass, field

import simpy

from axlr8.model import Event, RailMove, RailResult, Route, RunSettings, Step, Workflow
from axlr8.rail import Rail, sample
from axlr8.timing import sample_time


class _PriorityQueue(list):
    """Get requests in priority order (lower first), first come first served within a priority."""

    def append(self, event) -> None:
        p = getattr(event, "priority", 0)
        i = len(self)
        while i > 0 and getattr(self[i - 1], "priority", 0) > p:
            i -= 1
        self.insert(i, event)


class _Get(simpy.resources.store.FilterStoreGet):
    def __init__(self, resource, filter, priority: int):
        self.priority = priority  # set before the request joins the queue
        super().__init__(resource, filter)


class _Units(simpy.FilterStore):
    """The free units of one device. A request with a lower priority number is served first:
    growth images (GROWTH_PRIORITY) wait while a soak or any other step wants the same unit."""

    GetQueue = _PriorityQueue

    def get(self, filter=lambda item: True, priority: int = 0):  # noqa: A002 - SimPy's name
        return _Get(self, filter, priority)


GROWTH_PRIORITY = 1


class WorkflowError(ValueError):
    """The workflow cannot run with these settings (e.g. a required device is not bought yet)."""


def route_scenario(run: RunSettings) -> str:
    """The route scenario a day type runs: a follow-on day is a run day."""
    return "run" if run.scenario == "follow_on" else run.scenario


def active_routes(wf: Workflow, run: RunSettings) -> list[Route]:
    return [r for r in wf.routes if r.enabled and route_scenario(run) in r.scenarios]


def _available(wf: Workflow, device_id: str, phase: int) -> bool:
    units = wf.device(device_id).units_in_phase(phase)
    return units is None or len(units) > 0


def active_sequence(wf: Workflow, route: Route, phase: int, single: bool = False) -> list[int]:
    """Step indices the item visits: loop unrolled, switched-off and unavailable optional steps removed.
    In single mode (GO) a loop runs once, matching the one partner item each route releases."""
    seq = route.sequence() if not single or route.loop is None else list(range(len(route.steps)))
    out = []
    for i in seq:
        s = route.steps[i]
        if not s.enabled:
            continue
        if s.optional and not any(_available(wf, d, phase) for d in s.devices):
            continue
        out.append(i)
    return out


@dataclass
class RunPlan:
    routes: list[Route]  # routes that will run
    skipped: list[tuple[str, str]]  # (route id, reason) for switched-on routes that cannot run
    warnings: list[str]


def plan_run(wf: Workflow, run: RunSettings) -> RunPlan:
    """Decide which switched-on routes can run with the equipment of `run.phase`.

    A route is skipped when a required step has no device bought yet, or when a meeting point
    (join/sync) it relies on has no partner route left running."""
    candidates = active_routes(wf, run)
    skipped: dict[str, str] = {}
    for r in candidates:
        for i in sorted(set(active_sequence(wf, r, run.phase))):
            s = r.steps[i]
            if not any(_available(wf, d, run.phase) for d in s.devices):
                names = " or ".join(wf.device(d).name for d in s.devices)
                skipped[r.id] = f"step {i + 1} needs {names}, which is not available in phase {run.phase}"
                break

    def keys(r: Route) -> set[tuple[str, str]]:
        seq = active_sequence(wf, r, run.phase)
        out = set()
        for i in seq:
            if r.steps[i].join:
                out.add(("join", r.steps[i].join))
            if r.steps[i].sync:
                out.add(("sync", r.steps[i].sync))
        return out

    route_keys = {r.id: keys(r) for r in candidates}
    changed = True
    while changed:
        changed = False
        running = [r for r in candidates if r.id not in skipped]
        held: dict[tuple[str, str], set[str]] = {}
        for r in running:
            for k in route_keys[r.id]:
                held.setdefault(k, set()).add(r.id)
        for r in running:
            for kind, key in sorted(route_keys[r.id]):
                if not held[(kind, key)] - {r.id}:
                    word = "meeting point" if kind == "join" else "start point"
                    skipped[r.id] = f"its {word} '{key}' has no partner route running"
                    changed = True
                    break

    running = [r for r in candidates if r.id not in skipped]
    if not running:
        if not candidates:
            raise WorkflowError(f"no routes are switched on for the {route_scenario(run)} scenario")
        raise WorkflowError("; ".join(f"route '{wf.route(rid).name}' cannot run: {why}" for rid, why in skipped.items()))

    warnings = []
    for r in running:
        for i in sorted(set(active_sequence(wf, r, run.phase))):
            s = r.steps[i]
            if s.units and len(s.devices) == 1:
                d = wf.device(s.devices[0])
                have = d.units_in_phase(run.phase) or []
                missing = [u for u in s.units if u not in have]
                if missing and not any(u in have for u in s.units):
                    unit_word = "unit" if len(missing) == 1 else "units"
                    warnings.append(
                        f"{r.name} step {i + 1} asks for {d.name} {unit_word} {'/'.join(map(str, missing))}, "
                        f"not bought in phase {run.phase}; it shares the other units instead"
                    )
    by_join: dict[str, list[tuple[Route, int]]] = {}
    for r in running:
        for i, s in enumerate(r.steps):
            if s.join and s.enabled:
                by_join.setdefault(s.join, []).append((r, i))
    for key, members in by_join.items():
        if len({tuple(r.steps[i].devices) for r, i in members}) > 1:
            warnings.append(f"meeting point '{key}' uses different devices in its routes; the later arrival's step is used")
    return RunPlan(running, [(rid, why) for rid, why in skipped.items()], warnings)


@dataclass
class _Hold:
    """A device unit held by one item, or shared by the two items of a join."""

    store: _Units | None
    unit: int | None
    refs: int = 1
    device: str | None = None

    def release(self) -> None:
        self.refs -= 1
        if self.refs == 0 and self.store is not None:
            self.store.put(self.unit)


@dataclass
class _Waiter:
    item: int
    route: Route
    step: int
    done: simpy.Event
    bound: tuple[str, int | None] | None = None  # the unit it was carried to (rail runs)


@dataclass
class _Sim:
    wf: Workflow
    run: RunSettings
    env: simpy.Environment = field(default_factory=simpy.Environment)
    events: list[Event] = field(default_factory=list)
    next_item: int = 0
    early: set[int] = field(default_factory=set)  # items of the days before the reported one
    slots: dict[tuple[str, int], int] = field(default_factory=dict)  # plates stored in each unit
    stock: dict[tuple[str, int], int] = field(default_factory=dict)  # plates there at the start (grown already)
    grown: dict[str, list[tuple[float, int, int]]] = field(default_factory=dict)  # device -> (ready at, item, unit)
    taken: set[int] = field(default_factory=set)  # stored plates taken out again

    def __post_init__(self):
        self._root = self.run.seed if self.run.seed is not None else random.SystemRandom().randrange(2**63)
        self._streams: dict[str, random.Random] = {}
        self.stores: dict[str, _Units | None] = {}
        self.units: dict[str, list[int] | None] = {}
        for d in self.wf.devices:
            units = d.units_in_phase(self.run.phase)
            self.units[d.id] = units
            if units is None:
                self.stores[d.id] = None
            else:
                store = _Units(self.env)
                store.items = list(units)
                self.stores[d.id] = store
        cobots = self.run.cobots if self.run.cobots is not None else self.wf.cobots_by_phase.get(self.run.phase, 0)
        self.cobots = cobots
        self.arms = simpy.Resource(self.env, capacity=cobots) if cobots > 0 else None
        self.rail: Rail | None = None
        self.rail_moves: list[RailMove] = []
        self.rail_waiters: list[simpy.Event] = []
        self.bound: dict[tuple[str, int], int] = {}  # plates on their way to each unit
        if cobots > 0 and self.wf.layout is not None:
            self.arms = None
            self.places = {p.station: p for p in self.wf.layout.placements}
            xs = [self.places[s].x for s in self._stations() if s in self.places]
            missing = [s for s in self._stations() if s not in self.places]
            if missing:
                raise WorkflowError(f"the layout does not place {', '.join(missing)}")
            self.rail = Rail.build(self.wf.layout, cobots, xs)
        for d in self.wf.devices:
            for u in self.units[d.id] or []:
                if d.stored_at_start and u <= len(d.stored_at_start):
                    self.slots[(d.id, u)] = d.stored_at_start[u - 1]
                    self.stock[(d.id, u)] = d.stored_at_start[u - 1]
        self.stored_signal = self.env.event()
        self.joins: dict[str, list[_Waiter]] = {}
        self.syncs: dict[str, list[_Waiter]] = {}
        self.sequences = {r.id: active_sequence(self.wf, r, self.run.phase, self.run.single) for r in self.wf.routes}
        self.plan = plan_run(self.wf, self.run)
        self.active = {r.id for r in self.plan.routes}

    def _stations(self) -> list[str]:
        out = []
        for d in self.wf.devices:
            units = self.units[d.id]
            out += [d.id] if units is None else [f"{d.id}:{u}" for u in units]
        return out

    # One random stream per step/move, so editing one part leaves the draws elsewhere unchanged.
    def rng(self, key: str) -> random.Random:
        if key not in self._streams:
            self._streams[key] = random.Random(f"{self._root}:{key}")
        return self._streams[key]

    def log(self, **kw) -> None:
        self.events.append(Event(t=self.env.now, **kw))
        if len(self.events) > MAX_EVENTS:
            raise WorkflowError(
                f"run too large: more than {MAX_EVENTS:,} events. Release fewer items, or use fewer repeats or spawns."
            )

    def _logger(self, item: int, route: Route) -> Callable[..., None]:
        return lambda **kw: self.log(item=item, route=route.id, **kw)

    def start_item(self, route: Route, early: bool = False) -> None:
        """`early`: the item belongs to a day before the reported one."""
        self.next_item += 1
        if self.next_item > MAX_ITEMS:
            raise WorkflowError(f"run too large: more than {MAX_ITEMS:,} items. Release fewer items, or use fewer spawns.")
        if early:
            self.early.add(self.next_item)
        self.env.process(self._item(self.next_item, route))

    def _release_all(self, route: Route, day: float = 0.0):
        n = 1 if self.run.single else route.count
        for k in range(n):
            delay = day + route.offset + k * route.interval
            if delay > self.env.now:
                yield self.env.timeout(delay - self.env.now)
            self.start_item(route, day < self.report_from())

    def _item(self, item: int, route: Route):
        log = self._logger(item, route)
        log(kind="released", step=-1)
        hold: _Hold | None = None
        prev = -1
        here: str | None = None  # station the plate is at
        for si in self.sequences[route.id]:
            step = route.steps[si]
            takes = None
            if prev < 0 and self._takes_stored(step):
                # Starts with a grown plate from storage: wait until one has grown, then go to its unit.
                takes, unit = yield from self._grown_plate(step)
                bound = (step.devices[0], unit)
                yield from self._move(log, item, route, prev, si, step, hold, here)
            else:
                bound = yield from self._move(log, item, route, prev, si, step, hold, here)
            if step.sync:
                yield from self._sync(item, route, si, step)
            hold = yield from self._process(item, route, si, step, log, bound, takes)
            placed, stored_at = (hold.device, hold.unit), self.env.now
            if prev < 0 and not step.store and self._stores_plates(hold):
                # The route starts with a plate stored here (e.g. a grown plate for soaking): its slot frees.
                key = (hold.device, hold.unit)
                self.slots[key] = max(0, self.slots.get(key, 0) - 1)
            here = _key(hold.device, hold.unit)
            if step.dwell is not None:
                hold.release()
                hold = None
                yield self.env.timeout(sample_time(step.dwell, self.rng(f"dwell:{route.id}:{si}"), self.run.time_variation))
                log(kind="dwell_end", step=si)
            prev = si
        if hold is not None:
            hold.release()
        last = route.steps[prev] if prev >= 0 else None
        if last is not None and last.store:
            log(kind="completed", step=prev, device=placed[0], unit=placed[1])
            hours = _growth_hours(self.wf.growth, self.rng(f"growth:{route.id}"))
            self.grown.setdefault(placed[0], []).append((stored_at + hours * 3600, item, placed[1]))
            self.stored_signal.succeed()
            self.stored_signal = self.env.event()
            self.env.process(self._monitor(item, route, prev, placed[0], placed[1], stored_at))
        else:
            log(kind="completed", step=prev)

    def _takes_stored(self, step: Step) -> bool:
        """A route whose first step is at a device that stores plates takes a stored (grown) plate out."""
        return len(step.devices) == 1 and not step.store and self.wf.device(step.devices[0]).capacity is not None

    def _grown_plate(self, step: Step):
        """The plate a soak takes: the simulated plate that has been ready longest, else one that was there
        at the start of the day, else wait until one has grown. Returns (item or None, unit)."""
        device = step.devices[0]
        allowed = set(self._allowed(step, device) or [])
        while True:
            now = self.env.now
            ready = [p for p in self.grown.get(device, []) if p[0] <= now and p[2] in allowed]
            if ready:
                plate = min(ready)
                self.grown[device].remove(plate)
                self.taken.add(plate[1])
                return plate[1], plate[2]
            stock = [u for u in sorted(allowed) if self.stock.get((device, u), 0) > 0]
            if stock:
                u = max(stock, key=lambda u: self.stock[(device, u)])
                self.stock[(device, u)] -= 1
                return None, u
            pending = [p[0] for p in self.grown.get(device, []) if p[2] in allowed]
            if pending:
                yield self.env.timeout(min(pending) - now)
            else:
                yield self.stored_signal

    def _monitor(self, item: int, route: Route, si: int, device: str, unit: int, stored_at: float):
        """Images a stored plate again at each hour of the schedule, while there is time left and until
        it is taken out."""
        if unit not in self.wf.device(device).imager_units:
            return
        log = self._logger(item, route)
        imaging = self.wf.imaging
        for h in imaging.schedule_hours:
            due = stored_at + h * 3600
            if due > self.horizon() or item in self.taken:
                return
            yield self.env.timeout(max(0.0, due - self.env.now))
            if item in self.taken:
                return
            yield self.stores[device].get(lambda u: u == unit, priority=GROWTH_PRIORITY)
            if item in self.taken:  # taken out for a soak while it waited for the imager
                self.stores[device].put(unit)
                return
            log(kind="image_start", step=si, device=device, unit=unit, due=due)
            yield self.env.timeout(imaging.plate_time())
            log(kind="image_end", step=si, device=device, unit=unit)
            self.stores[device].put(unit)

    def _move(self, log, item: int, route: Route, frm: int, to: int, step: Step, hold: _Hold | None, here: str | None):
        """Moves the item to step `to`. On a rail run, returns the unit it was carried to."""
        log(kind="move_ready", step=frm, to=to)
        if step.transport == "cobot" and self.rail is not None:
            return (yield from self._rail_move(log, item, route, frm, to, step, hold, here))
        if step.transport != "cobot":
            log(kind="move_start", step=frm, to=to)
            if hold is not None:
                hold.release()
            log(kind="move_end", step=to)
            return
        req = None
        if self.arms is not None:
            req = self.arms.request()
            yield req
        log(kind="move_start", step=frm, to=to, cobot=req is not None)
        if hold is not None:
            hold.release()
        yield self.env.timeout(sample_time(self.wf.move_time, self.rng(f"move:{route.id}:{to}"), self.run.time_variation))
        if req is not None:
            self.arms.release(req)
        log(kind="move_end", step=to, cobot=req is not None)
        return None

    def _rail_move(self, log, item: int, route: Route, frm: int, to: int, step: Step, hold: _Hold | None, here: str | None):
        bound = self._bind(route, step, here)
        target = _key(*bound)
        source = here or target  # the first move of a route starts at the station it is loaded into
        a, b = self.places[source], self.places[target]
        rail = self.rail
        ready = self.env.now
        blocked = 0.0
        while (arm := rail.choose(self.env.now, a.x, b.x)) is None:
            wake = self.env.event()
            self.rail_waiters.append(wake)
            some_idle = bool(rail.idle())
            since = self.env.now
            yield wake
            if some_idle:
                blocked += self.env.now - since
        window = sample_time(self.wf.move_time, self.rng(f"move:{route.id}:{to}"), self.run.time_variation)
        plan = rail.assign(arm, self.env.now, a.x, a.side, b.x, b.side, window)
        log(kind="move_start", step=frm, to=to, cobot=True, arm=arm)
        if hold is not None:
            hold.release()
        yield self.env.timeout(plan.end - self.env.now)
        rail.release(arm, self.env.now)
        if sum(len(track) for track in rail.tracks) > MAX_KEYFRAMES:
            raise WorkflowError("run too large for the rail replay: release fewer items, or use fewer cobots")
        self.rail_moves.append(
            RailMove(
                item=item, arm=arm, start=plan.start, end=plan.end, pick=plan.pick, place=plan.place,
                source=source, target=target, need=plan.need, blocked=min(blocked, plan.start - ready),
            )
        )
        if bound[1] is not None:
            self.bound[bound] -= 1
        waiters, self.rail_waiters = self.rail_waiters, []
        for w in waiters:
            w.succeed()
        log(kind="move_end", step=to, cobot=True, arm=arm)
        return bound

    def _bind(self, route: Route, step: Step, here: str | None) -> tuple[str, int | None]:
        """Picks the unit a plate is carried to: the one a meeting partner waits at, else a free
        unit (the emptiest one for a plate that stays stored) nearest the plate, else the unit with
        the fewest plates already on their way."""
        if step.join:
            partner = next((w for w in self.joins.get(step.join, []) if w.route.id != route.id and w.bound), None)
            if partner is not None:
                return partner.bound
        x0 = self.places[here].x if here else None
        best: tuple[tuple, tuple[str, int | None]] | None = None
        for d in step.devices:
            if not _available(self.wf, d, self.run.phase):
                continue
            if self.stores[d] is None:
                return (d, None)
            free = set(self.stores[d].items)
            for u in self._allowed(step, d):
                if not self._room(step, d, u) and any(self._room(step, d, v) for v in self._allowed(step, d)):
                    continue  # full: carry the plate to a unit with a free slot
                dist = abs(self.places[f"{d}:{u}"].x - x0) if x0 is not None else 0.0
                stored = self.slots.get((d, u), 0) if step.store else 0  # spread stored plates over the imagers
                score = (u not in free, self.bound.get((d, u), 0), stored, dist)
                if best is None or score < best[0]:
                    best = (score, (d, u))
        assert best is not None  # plan_run guarantees a device
        self.bound[best[1]] = self.bound.get(best[1], 0) + 1
        if step.store:  # the slot is taken as soon as the plate is on its way
            self.slots[best[1]] = self.slots.get(best[1], 0) + 1
        return best[1]

    def _allowed(self, step: Step, device_id: str) -> list[int] | None:
        units = self.units[device_id]
        if units is None:
            return units
        if step.image or step.store:
            imagers = self.wf.device(device_id).imager_units
            units = [u for u in units if u in imagers] or units
        if step.units is None:
            return units
        pinned = [u for u in step.units if u in units]
        return pinned or units  # pinned unit not bought in this phase: use any unit

    def _stores_plates(self, hold: _Hold) -> bool:
        return hold.unit is not None and self.wf.device(hold.device).capacity is not None

    def _room(self, step: Step, device_id: str, unit: int) -> bool:
        """Whether a plate this step stores still fits in the unit."""
        if not step.store:
            return True
        cap = self.wf.device(device_id).capacity or []
        return unit > len(cap) or self.slots.get((device_id, unit), 0) < cap[unit - 1]

    def _acquire(self, step: Step, bound: tuple[str, int | None] | None = None):
        """Wait for a free unit of any of the step's devices (or for the unit the plate was carried
        to). Returns (device_id, hold)."""
        options = [d for d in step.devices if _available(self.wf, d, self.run.phase)]
        if bound is not None:
            options = [bound[0]]
        for d in options:
            if self.stores[d] is None:
                return d, _Hold(None, None, device=d)
        reqs = []
        for d in options:
            allowed = {bound[1]} if bound is not None else set(self._allowed(step, d))
            room = bound is None  # a plate carried here already has its slot
            reqs.append((d, self.stores[d].get(lambda u, allowed=allowed, d=d, room=room: u in allowed and (not room or self._room(step, d, u)))))
        result = yield self.env.any_of([r for _, r in reqs])
        device, req = next((d, r) for d, r in reqs if r in result)
        for d, r in reqs:
            if r is req:
                continue
            if r.triggered:
                self.stores[d].put(r.value)
            else:
                r.cancel()
        if step.store and bound is None:
            self.slots[(device, req.value)] = self.slots.get((device, req.value), 0) + 1
        return device, _Hold(self.stores[device], req.value, device=device)

    def _sync(self, item: int, route: Route, si: int, step: Step):
        """Wait until an item from another route reaches a step with the same start key."""
        queue = self.syncs.setdefault(step.sync, [])
        partner = next((w for w in queue if w.route.id != route.id), None)
        if partner is not None:
            queue.remove(partner)
            partner.done.succeed()
            return
        waiter = _Waiter(item, route, si, self.env.event())
        queue.append(waiter)
        yield waiter.done

    def _process(
        self, item: int, route: Route, si: int, step: Step, log, bound: tuple[str, int | None] | None = None, takes: int | None = None
    ):
        partner: _Waiter | None = None
        if step.join:
            queue = self.joins.setdefault(step.join, [])
            partner = next((w for w in queue if w.route.id != route.id), None)
            if partner is None:
                waiter = _Waiter(item, route, si, self.env.event(), bound)
                queue.append(waiter)
                hold = yield waiter.done
                return hold
            queue.remove(partner)
            bound = partner.bound or bound  # the partner's plate is already there
        device, hold = yield from self._acquire(step, bound)
        members = [(log, si, route, item)]
        if partner is not None:
            hold.refs = 2
            members.append((self._logger(partner.item, partner.route), partner.step, partner.route, partner.item))
        for lg, s, _, it in members:
            lg(kind="process_start", step=s, device=device, unit=hold.unit, **({"takes": takes} if it == item and takes else {}))
        spec = step.time or self.wf.device(device).time
        imaging = self.wf.imaging.plate_time() if step.image and hold.unit in self.wf.device(device).imager_units else 0.0
        yield self.env.timeout(sample_time(spec, self.rng(f"step:{route.id}:{si}"), self.run.time_variation) + imaging)
        for lg, s, r, it in members:
            lg(kind="process_end", step=s, device=device, unit=hold.unit)
            for sp in r.steps[s].spawn:
                target = self.wf.route(sp.route)
                if target.id in self.active:
                    for _ in range(sp.count):
                        self.start_item(target, it in self.early)
        if partner is not None:
            partner.done.succeed(hold)
        return hold

    def rail_result(self) -> RailResult | None:
        r = self.rail
        if r is None:
            return None
        return RailResult(start=r.start, end=r.end, homes=r.homes, tracks=r.tracks, moves=self.rail_moves)

    def horizon(self) -> float:
        """Stored plates are imaged on schedule until a day after the last day starts."""
        return self.days()[-1] + 24 * 3600

    def days(self) -> list[float]:
        """Start time of each day simulated."""
        n = 2 if self.run.scenario == "follow_on" else self.run.days
        return [k * self.run.day_length for k in range(n)]

    def report_from(self) -> float:
        """Results start here: the second day of a follow-on run, else the first day."""
        return self.days()[-1] if self.run.scenario == "follow_on" else 0.0

    def go(self) -> list[Event]:
        for day in self.days():
            for r in self.plan.routes:
                if r.count > 0:
                    self.env.process(self._release_all(r, day))
        self.env.run()
        return self.events


MAX_EVENTS = 150_000  # keeps a response to roughly 15 MB
MAX_ITEMS = 20_000
MAX_KEYFRAMES = 150_000  # arm keyframes on the rail, which grow with moves x arms


def _growth_hours(g, rng: random.Random) -> float:
    """Normal growth time, drawn again until it lies between the shortest and longest (a truncated normal),
    so no plates pile up exactly at a limit."""
    for _ in range(100):
        h = rng.gauss(g.mean_hours, g.sd_hours)
        if g.min_hours <= h <= g.max_hours:
            return h
    return min(g.max_hours, max(g.min_hours, g.mean_hours))


def _key(device: str | None, unit: int | None) -> str | None:
    if device is None:
        return None
    return device if unit is None else f"{device}:{unit}"


def _from_last_day(
    day: float, early: set[int], events: list[Event], rail: RailResult | None
) -> tuple[list[Event], RailResult | None]:
    """Moves the time origin to the start of the last day. Items from the days before are marked
    carried over and keep their events, at negative times."""
    if day == 0:
        return events, rail
    # Every earlier event is kept (at negative times): what was stored and taken out before day 2
    # decides how full the incubators are when it starts.
    events = [
        e.model_copy(update={"t": e.t - day, "carried": e.item in early, "due": None if e.due is None else e.due - day})
        for e in events
    ]
    if rail is not None:
        tracks = []
        for track in rail.tracks:
            now = sample(track, day)
            tracks.append([(0.0, *now[1:])] + [(t - day, *k) for t, *k in track if t > day])
        moves = [
            m.model_copy(update={"start": m.start - day, "end": m.end - day, "pick": m.pick - day, "place": m.place - day})
            for m in rail.moves
            if m.end > day
        ]
        rail = rail.model_copy(update={"tracks": tracks, "moves": moves})
    return events, rail


def simulate(wf: Workflow, run: RunSettings) -> list[Event]:
    return simulate_with_rail(wf, run)[0]


def simulate_with_rail(wf: Workflow, run: RunSettings) -> tuple[list[Event], RailResult | None]:
    """Like `simulate`, plus the arms' motion on the rail when the workflow has a layout.

    On a follow-on day, time 0 is the start of day 2."""
    sim = _Sim(wf, run)
    events = sim.go()
    return _from_last_day(sim.report_from(), sim.early, events, sim.rail_result())
