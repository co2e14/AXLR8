from axlr8.engine import simulate
from axlr8.model import Device, Route, RunSettings, Step, TimeSpec, Workflow


def dev(did: str, seconds: float, units: int | None = 1, phases: list[int] | None = None, **kw) -> Device:
    unit_phases = phases if phases is not None else (None if units is None else [1] * units)
    return Device(id=did, name=did.upper(), time=TimeSpec(value=seconds), unit_phases=unit_phases, **kw)


def step(*devices: str, **kw) -> Step:
    return Step(devices=list(devices), **kw)


def route(rid: str, steps, count: int = 1, **kw) -> Route:
    return Route(id=rid, name=rid, steps=list(steps), count=count, **kw)


def wf(devices, routes, move: float = 0, **kw) -> Workflow:
    return Workflow(name="test", devices=list(devices), routes=list(routes), move_time=TimeSpec(value=move), **kw)


def run(w: Workflow, **kw):
    return simulate(w, RunSettings(**kw))


def done(events, route_id: str | None = None):
    return sorted(e.t for e in events if e.kind == "completed" and (route_id is None or e.route == route_id))


def starts(events, device: str):
    return [(e.t, e.item, e.unit) for e in events if e.kind == "process_start" and e.device == device]
