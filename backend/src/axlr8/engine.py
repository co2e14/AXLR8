"""SimPy discrete-event simulation of items flowing along routes that share devices.

Produces a time-ordered event log; all statistics are derived from it in kpis.py.

Flow of one item through one step:
  1. `move_ready`: it is ready to leave where it is (it keeps that device occupied meanwhile).
  2. It waits for a cobot if the move needs one, then `move_start` (previous device freed) ...
  3. ... `move_end` at the step.
  4. If the step is a join, it waits for an item from the partner route at the same join.
  5. It takes a free unit of one of the step's devices: `process_start` ... `process_end`.
  6. Optional dwell (e.g. incubation) frees the device, then `dwell_end`.
"""

import random
from collections.abc import Callable
from dataclasses import dataclass, field

import simpy

from axlr8.model import Event, Route, RunSettings, Step, Workflow
from axlr8.timing import sample_time


class WorkflowError(ValueError):
    """The workflow cannot run with these settings (e.g. a required device is not bought yet)."""


def active_routes(wf: Workflow, run: RunSettings) -> list[Route]:
    return [r for r in wf.routes if r.enabled and run.scenario in r.scenarios]


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

    changed = True
    while changed:
        changed = False
        running = [r for r in candidates if r.id not in skipped]
        for r in running:
            for kind, key in sorted(keys(r)):
                if not any(o.id != r.id and (kind, key) in keys(o) for o in running):
                    word = "meeting point" if kind == "join" else "start point"
                    skipped[r.id] = f"its {word} '{key}' has no partner route running"
                    changed = True
                    break

    running = [r for r in candidates if r.id not in skipped]
    if not running:
        if not candidates:
            raise WorkflowError(f"no routes are switched on for the {run.scenario} scenario")
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

    store: simpy.FilterStore | None
    unit: int | None
    refs: int = 1

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


@dataclass
class _Sim:
    wf: Workflow
    run: RunSettings
    env: simpy.Environment = field(default_factory=simpy.Environment)
    events: list[Event] = field(default_factory=list)
    next_item: int = 0

    def __post_init__(self):
        self._root = self.run.seed if self.run.seed is not None else random.SystemRandom().randrange(2**63)
        self._streams: dict[str, random.Random] = {}
        self.stores: dict[str, simpy.FilterStore | None] = {}
        self.units: dict[str, list[int] | None] = {}
        for d in self.wf.devices:
            units = d.units_in_phase(self.run.phase)
            self.units[d.id] = units
            if units is None:
                self.stores[d.id] = None
            else:
                store = simpy.FilterStore(self.env)
                store.items = list(units)
                self.stores[d.id] = store
        cobots = self.run.cobots if self.run.cobots is not None else self.wf.cobots_by_phase.get(self.run.phase, 0)
        self.cobots = cobots
        self.arms = simpy.Resource(self.env, capacity=cobots) if cobots > 0 else None
        self.joins: dict[str, list[_Waiter]] = {}
        self.syncs: dict[str, list[_Waiter]] = {}
        self.sequences = {r.id: active_sequence(self.wf, r, self.run.phase, self.run.single) for r in self.wf.routes}
        self.plan = plan_run(self.wf, self.run)
        self.active = {r.id for r in self.plan.routes}

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

    def start_item(self, route: Route) -> None:
        self.next_item += 1
        self.env.process(self._item(self.next_item, route))

    def _release_all(self, route: Route):
        n = 1 if self.run.single else route.count
        for k in range(n):
            delay = route.offset + k * route.interval
            if delay > self.env.now:
                yield self.env.timeout(delay - self.env.now)
            self.start_item(route)

    def _item(self, item: int, route: Route):
        log = self._logger(item, route)
        log(kind="released", step=-1)
        hold: _Hold | None = None
        prev = -1
        for si in self.sequences[route.id]:
            step = route.steps[si]
            yield from self._move(log, route, prev, si, step, hold)
            if step.sync:
                yield from self._sync(item, route, si, step)
            hold = yield from self._process(item, route, si, step, log)
            if step.dwell is not None:
                hold.release()
                hold = None
                yield self.env.timeout(sample_time(step.dwell, self.rng(f"dwell:{route.id}:{si}")))
                log(kind="dwell_end", step=si)
            prev = si
        if hold is not None:
            hold.release()
        log(kind="completed", step=prev)

    def _move(self, log, route: Route, frm: int, to: int, step: Step, hold: _Hold | None):
        log(kind="move_ready", step=frm, to=to)
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
        yield self.env.timeout(sample_time(self.wf.move_time, self.rng(f"move:{route.id}:{to}")))
        if req is not None:
            self.arms.release(req)
        log(kind="move_end", step=to, cobot=req is not None)

    def _allowed(self, step: Step, device_id: str) -> list[int] | None:
        units = self.units[device_id]
        if units is None or step.units is None:
            return units
        pinned = [u for u in step.units if u in units]
        return pinned or units  # pinned unit not bought in this phase: use any unit

    def _acquire(self, step: Step):
        """Wait for a free unit of any of the step's devices. Returns (device_id, hold)."""
        options = [d for d in step.devices if _available(self.wf, d, self.run.phase)]
        for d in options:
            if self.stores[d] is None:
                return d, _Hold(None, None)
        reqs = []
        for d in options:
            allowed = set(self._allowed(step, d))
            reqs.append((d, self.stores[d].get(lambda u, allowed=allowed: u in allowed)))
        result = yield self.env.any_of([r for _, r in reqs])
        device, req = next((d, r) for d, r in reqs if r in result)
        for d, r in reqs:
            if r is req:
                continue
            if r.triggered:
                self.stores[d].put(r.value)
            else:
                r.cancel()
        return device, _Hold(self.stores[device], req.value)

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

    def _process(self, item: int, route: Route, si: int, step: Step, log):
        partner: _Waiter | None = None
        if step.join:
            queue = self.joins.setdefault(step.join, [])
            partner = next((w for w in queue if w.route.id != route.id), None)
            if partner is None:
                waiter = _Waiter(item, route, si, self.env.event())
                queue.append(waiter)
                hold = yield waiter.done
                return hold
            queue.remove(partner)
        device, hold = yield from self._acquire(step)
        members = [(log, si, route)]
        if partner is not None:
            hold.refs = 2
            members.append((self._logger(partner.item, partner.route), partner.step, partner.route))
        for lg, s, _ in members:
            lg(kind="process_start", step=s, device=device, unit=hold.unit)
        spec = step.time or self.wf.device(device).time
        yield self.env.timeout(sample_time(spec, self.rng(f"step:{route.id}:{si}")))
        for lg, s, r in members:
            lg(kind="process_end", step=s, device=device, unit=hold.unit)
            for sp in r.steps[s].spawn:
                target = self.wf.route(sp.route)
                if target.id in self.active:
                    for _ in range(sp.count):
                        self.start_item(target)
        if partner is not None:
            partner.done.succeed(hold)
        return hold

    def go(self) -> list[Event]:
        for r in self.plan.routes:
            if r.count > 0:
                self.env.process(self._release_all(r))
        self.env.run()
        return self.events


MAX_EVENTS = 150_000  # keeps a response to roughly 15 MB


def simulate(wf: Workflow, run: RunSettings) -> list[Event]:
    return _Sim(wf, run).go()
