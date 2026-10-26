"""Workflow configuration, run settings and the simulation event record.

A workflow is a set of shared devices and a set of routes. Each route is the ordered
list of steps one kind of labware goes through. All times are in seconds.
See docs/AXL_WORKFLOW.md for how the AXL deck maps onto this model.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TimeSpec(BaseModel):
    """A duration. `value` is the nominal time. `spread` is the standard deviation for
    `normal`, and the half-width of the range for `uniform` and `triangular`."""

    model_config = ConfigDict(allow_inf_nan=False)

    value: float = Field(ge=0)
    kind: Literal["fixed", "normal", "uniform", "triangular"] = "fixed"
    spread: float = Field(default=0, ge=0)


Timing = Literal["fixed", "project", "assumed"]
DeviceKind = Literal["process", "storage", "manual", "waste"]


class Device(BaseModel):
    id: str = Field(min_length=1)
    name: str
    kind: DeviceKind = "process"
    # Phase in which each unit arrives; None = unlimited units (manual points, waste, LN2).
    unit_phases: list[int] | None = Field(default_factory=lambda: [1])
    time: TimeSpec
    timing: Timing = "fixed"
    note: str = ""

    def units_in_phase(self, phase: int) -> list[int] | None:
        """1-based unit numbers available in `phase`, or None when unlimited."""
        if self.unit_phases is None:
            return None
        return [i + 1 for i, p in enumerate(self.unit_phases) if p <= phase]


Transport = Literal["cobot", "linked", "manual"]


class Spawn(BaseModel):
    route: str
    count: int = Field(default=1, ge=1, le=100)


class Step(BaseModel):
    devices: list[str] = Field(min_length=1, description="Alternatives; the first free one is used")
    units: list[int] | None = Field(default=None, description="Restrict to these unit numbers (single device only)")
    time: TimeSpec | None = None  # overrides the device's time for this step
    dwell: TimeSpec | None = None  # waiting after the step without holding the device (e.g. incubation)
    timing: Timing | None = None  # overrides the device's timing tag for this step
    label: str | None = None
    optional: bool = False
    enabled: bool = True
    transport: Transport = "cobot"  # how the item gets into this step
    join: str | None = None  # rendezvous key: waits for an item from another route at a step with the same key
    spawn: list[Spawn] = []


class Loop(BaseModel):
    start: int = Field(ge=0)  # first step index in the loop
    end: int = Field(ge=0)  # last step index in the loop (inclusive)
    times: int = Field(default=1, ge=1, le=200)


Scenario = Literal["run", "shutdown"]


class Route(BaseModel):
    id: str = Field(min_length=1)
    name: str
    group: str = ""
    labware: str = ""
    enabled: bool = True
    scenarios: list[Scenario] = ["run", "shutdown"]
    count: int = Field(default=1, ge=0, le=500, description="Items released; 0 = only fed by spawns")
    interval: float = Field(default=0, ge=0)
    offset: float = Field(default=0, ge=0)
    steps: list[Step] = Field(min_length=1)
    loop: Loop | None = None

    model_config = ConfigDict(allow_inf_nan=False)

    def sequence(self) -> list[int]:
        """Step indices in the order an item visits them, with the loop unrolled."""
        idx = list(range(len(self.steps)))
        if self.loop is None:
            return idx
        lp = self.loop
        block = idx[lp.start : lp.end + 1]
        return idx[: lp.start] + block * lp.times + idx[lp.end + 1 :]


class Workflow(BaseModel):
    name: str = "Untitled workflow"
    devices: list[Device] = Field(min_length=1)
    routes: list[Route] = Field(min_length=1)
    move_time: TimeSpec = TimeSpec(value=30)  # cobot move time
    cobots_by_phase: dict[int, int] = {1: 0, 2: 0, 3: 1, 4: 3}

    def device(self, device_id: str) -> Device:
        return next(d for d in self.devices if d.id == device_id)

    def route(self, route_id: str) -> Route:
        return next(r for r in self.routes if r.id == route_id)

    @model_validator(mode="after")
    def _check_references(self):
        dev_ids = [d.id for d in self.devices]
        if len(set(dev_ids)) != len(dev_ids):
            raise ValueError("device ids must be unique")
        route_ids = [r.id for r in self.routes]
        if len(set(route_ids)) != len(route_ids):
            raise ValueError("route ids must be unique")
        for r in self.routes:
            n = len(r.steps)
            if r.loop is not None and not (r.loop.start <= r.loop.end < n):
                raise ValueError(f"route '{r.name}': loop must cover steps 1 to {n}")
            for i, s in enumerate(r.steps, start=1):
                where = f"route '{r.name}' step {i}"
                for d in s.devices:
                    if d not in dev_ids:
                        raise ValueError(f"{where} uses unknown device '{d}'")
                if s.units is not None and len(s.devices) != 1:
                    raise ValueError(f"{where}: units can only be restricted when the step uses one device")
                for sp in s.spawn:
                    if sp.route not in route_ids:
                        raise ValueError(f"{where} spawns unknown route '{sp.route}'")
        return self


class RunSettings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    scenario: Scenario = "run"
    phase: int = Field(default=4, ge=1, le=4)
    cobots: int | None = Field(default=None, ge=0, le=20, description="None = the phase default")
    single: bool = Field(default=False, description="Release one item per active route (the GO button)")
    seed: int | None = None


EventKind = Literal[
    "released",
    "move_ready",
    "move_start",
    "move_end",
    "process_start",
    "process_end",
    "dwell_end",
    "completed",
]


class Event(BaseModel):
    t: float
    item: int
    route: str
    kind: EventKind
    step: int  # index into route.steps; -1 = route start
    device: str | None = None
    unit: int | None = None
    to: int | None = None  # destination step for moves (-2 = route end)
    cobot: bool = False
