"""Summary statistics derived purely from the engine's event log."""

from collections import defaultdict
from statistics import mean
from typing import Literal

from pydantic import BaseModel

from axlr8.model import Arm, Event, LabConfig, Station


class StationStats(BaseModel):
    id: str
    name: str
    utilisation: float  # share of slot-time spent processing
    blocked_fraction: float  # share of slot-time holding finished samples that cannot move on
    avg_wait: float  # arrival -> process start
    max_wait: float
    avg_queue: float  # time-averaged number of samples waiting
    max_queue: int
    batches: int


class ArmStats(BaseModel):
    id: str
    name: str
    utilisation: float
    moves: int
    avg_wait: float  # destination reserved -> arm picks up


class Bottleneck(BaseModel):
    id: str
    kind: Literal["station", "arm"]
    utilisation: float


class Kpis(BaseModel):
    num_samples: int
    makespan: float
    throughput_per_hour: float | None
    avg_cycle_time: float
    min_cycle_time: float
    max_cycle_time: float
    stations: list[StationStats]
    arms: list[ArmStats]
    bottleneck: Bottleneck | None


def _share(amount: float, total: float) -> float:
    return amount / total if total > 0 else 0.0


def _queue_profile(changes: list[tuple[float, int]], makespan: float) -> tuple[float, int]:
    """Time-average and peak of a count driven by (time, +1/-1) changes."""
    count = peak = 0
    area = prev = 0.0
    for t, delta in sorted(changes):  # -1 before +1 at equal times
        area += count * (t - prev)
        prev = t
        count += delta
        peak = max(peak, count)
    return _share(area, makespan), peak


def _station_stats(st: Station, events: list[Event], makespan: float) -> StationStats:
    sid = st.id
    arrive = {e.sample: e.t for e in events if e.kind == "move_end" and e.at == sid}
    starts = [e for e in events if e.kind == "process_start" and e.at == sid]
    ends = [e for e in events if e.kind == "process_end" and e.at == sid]
    leave = {e.sample: e.t for e in events if e.kind == "move_start" and e.at == sid}

    batch_start = {e.batch: e.t for e in starts}
    batch_end, batch_leave = {}, {}
    for e in ends:
        batch_end[e.batch] = e.t
        batch_leave[e.batch] = max(batch_leave.get(e.batch, e.t), leave[e.sample])
    busy = sum(batch_end[b] - batch_start[b] for b in batch_end)
    blocked = sum(batch_leave[b] - batch_end[b] for b in batch_end)

    waits = [e.t - arrive[e.sample] for e in starts]
    changes = [(arrive[e.sample], 1) for e in starts] + [(e.t, -1) for e in starts]
    avg_queue, max_queue = _queue_profile(changes, makespan)
    slot_time = st.capacity * makespan
    return StationStats(
        id=sid,
        name=st.name,
        utilisation=_share(busy, slot_time),
        blocked_fraction=_share(blocked, slot_time),
        avg_wait=mean(waits) if waits else 0.0,
        max_wait=max(waits, default=0.0),
        avg_queue=avg_queue,
        max_queue=max_queue,
        batches=len(batch_start),
    )


def _arm_stats(arm: Arm, events: list[Event], makespan: float) -> ArmStats:
    reserved: dict[int, float] = {}
    started: dict[int, float] = {}
    busy, waits = 0.0, []
    for e in events:
        if e.kind == "dest_reserved":
            reserved[e.sample] = e.t
        elif e.arm != arm.id:
            continue
        elif e.kind == "move_start":
            started[e.sample] = e.t
            waits.append(e.t - reserved[e.sample])
        elif e.kind == "move_end":
            busy += e.t - started.pop(e.sample)
    return ArmStats(
        id=arm.id,
        name=arm.name,
        utilisation=_share(busy, makespan),
        moves=len(waits),
        avg_wait=mean(waits) if waits else 0.0,
    )


def compute_kpis(lab: LabConfig, events: list[Event]) -> Kpis:
    released = {e.sample: e.t for e in events if e.kind == "released"}
    completed = {e.sample: e.t for e in events if e.kind == "completed"}
    makespan = max(completed.values(), default=0.0)
    cycles = [completed[s] - released[s] for s in completed] or [0.0]

    stations = [_station_stats(s, events, makespan) for s in lab.stations]
    arms = [_arm_stats(a, events, makespan) for a in lab.arms]

    candidates = [Bottleneck(id=s.id, kind="station", utilisation=s.utilisation) for s in stations]
    candidates += [Bottleneck(id=a.id, kind="arm", utilisation=a.utilisation) for a in arms]
    top = max(candidates, key=lambda c: c.utilisation, default=None)

    return Kpis(
        num_samples=len(completed),
        makespan=makespan,
        throughput_per_hour=len(completed) / makespan * 3600 if makespan > 0 else None,
        avg_cycle_time=mean(cycles),
        min_cycle_time=min(cycles),
        max_cycle_time=max(cycles),
        stations=stations,
        arms=arms,
        bottleneck=top if top is not None and top.utilisation > 0 else None,
    )
