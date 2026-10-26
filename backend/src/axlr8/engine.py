"""SimPy discrete-event simulation of samples flowing along the lab route.

Produces a time-ordered event log; all statistics are derived from it in kpis.py.
See docs/superpowers/plans/2026-10-26-m1-engine-api.md for the flow semantics.
"""

import random
from collections.abc import Callable

import simpy
from simpy.resources.resource import Request

from axlr8.model import INPUT, OUTPUT, Event, LabConfig, RunSettings, Station
from axlr8.timing import sample_time

Log = Callable[[Event], None]


class _StationSim:
    """Queue + slots for one station, with a dispatcher that forms batches."""

    def __init__(self, env: simpy.Environment, station: Station, total_samples: int,
                 rng: random.Random, log: Log):
        self.env, self.station, self.rng, self.log = env, station, rng, log
        self.slots = simpy.Resource(env, capacity=station.capacity)
        self.buffer = simpy.Resource(env, capacity=station.buffer_size) if station.buffer_size else None
        self.queue: list[tuple[int, simpy.Event, Request | None]] = []
        self.yet_to_arrive = total_samples
        self.batches = 0
        self.wakeup = env.event()
        env.process(self._dispatch())

    def enqueue(self, sample: int, buffer_req: Request | None) -> simpy.Event:
        """Join the queue. The returned event fires at process end with a `leave` event
        the sample must trigger when it is picked up."""
        done = self.env.event()
        self.queue.append((sample, done, buffer_req))
        self.yet_to_arrive -= 1
        if not self.wakeup.triggered:
            self.wakeup.succeed()
        return done

    def _batch_ready(self) -> bool:
        n = len(self.queue)
        return n > 0 and (n >= self.station.batch_size or self.yet_to_arrive == 0)

    def _dispatch(self):
        while True:
            while not self._batch_ready():
                yield self.wakeup
                self.wakeup = self.env.event()
            slot = self.slots.request()
            yield slot
            size = self.station.batch_size
            batch, self.queue = self.queue[:size], self.queue[size:]
            self.env.process(self._run_batch(slot, batch))

    def _run_batch(self, slot, batch):
        self.batches += 1
        batch_id, sid = self.batches, self.station.id
        for sample, _, buf in batch:
            if buf is not None:
                self.buffer.release(buf)
            self.log(Event(t=self.env.now, sample=sample, kind="process_start", at=sid, batch=batch_id))
        yield self.env.timeout(sample_time(self.station.process_time, self.rng))
        leaves = []
        for sample, done, _ in batch:
            self.log(Event(t=self.env.now, sample=sample, kind="process_end", at=sid, batch=batch_id))
            leave = self.env.event()
            leaves.append(leave)
            done.succeed(leave)
        yield self.env.all_of(leaves)
        self.slots.release(slot)


def _sample(env, k, lab, stations, arms, rng, log):
    log(Event(t=env.now, sample=k, kind="released", at=INPUT))
    locs = lab.locations()
    leave_here = None
    for here, there in zip(locs, locs[1:]):
        transfer = lab.transfer_for(here, there)
        dest = stations.get(there)
        buf = None
        if dest is not None and dest.buffer is not None:
            buf = dest.buffer.request()
            yield buf
        log(Event(t=env.now, sample=k, kind="dest_reserved", at=here, to=there))
        arm_req = None
        if transfer.arm is not None:
            arm_req = arms[transfer.arm].request()
            yield arm_req
        log(Event(t=env.now, sample=k, kind="move_start", at=here, to=there, arm=transfer.arm))
        if leave_here is not None:
            leave_here.succeed()
        yield env.timeout(sample_time(transfer.time, rng))
        if arm_req is not None:
            arms[transfer.arm].release(arm_req)
        log(Event(t=env.now, sample=k, kind="move_end", at=there, arm=transfer.arm))
        if dest is None:
            log(Event(t=env.now, sample=k, kind="completed", at=OUTPUT))
        else:
            leave_here = yield dest.enqueue(k, buf)


def _arrivals(env, run: RunSettings, start_sample):
    for k in range(1, run.num_samples + 1):
        if k > 1 and run.arrival_interval > 0:
            yield env.timeout(run.arrival_interval)
        start_sample(k)


def simulate(lab: LabConfig, run: RunSettings) -> list[Event]:
    env = simpy.Environment()
    rng = random.Random(run.seed)
    events: list[Event] = []
    log = events.append
    stations = {s.id: _StationSim(env, s, run.num_samples, rng, log) for s in lab.stations}
    arms = {a.id: simpy.Resource(env, capacity=1) for a in lab.arms}
    env.process(_arrivals(env, run, lambda k: env.process(_sample(env, k, lab, stations, arms, rng, log))))
    env.run()
    done = sum(1 for e in events if e.kind == "completed")
    if done != run.num_samples:
        raise RuntimeError(f"simulation stalled: {done} of {run.num_samples} samples completed")
    return events
