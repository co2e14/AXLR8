"""Workflow configuration, run settings and the simulation event record.

A workflow is a set of shared devices and a set of routes. Each route is the ordered
list of steps one kind of labware goes through. All times are in seconds.
See docs/AXL_WORKFLOW.md for how the AXL deck maps onto this model.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Limits that keep one request's simulation small (times in seconds, about four months).
MAX_TIME = 1e7
MAX_LIST = 200


class TimeSpec(BaseModel):
    """A duration. `value` is the nominal time. `spread` is the standard deviation for
    `normal`, and the half-width of the range for `uniform` and `triangular`."""

    model_config = ConfigDict(allow_inf_nan=False)

    value: float = Field(ge=0, le=MAX_TIME)
    kind: Literal["fixed", "normal", "uniform", "triangular"] = "fixed"
    spread: float = Field(default=0, ge=0, le=MAX_TIME)


Timing = Literal["fixed", "project", "assumed"]
DeviceKind = Literal["process", "storage", "manual", "waste"]


class Device(BaseModel):
    id: str = Field(min_length=1)
    name: str
    kind: DeviceKind = "process"
    # Phase in which each unit arrives; None = unlimited units (manual points, waste, LN2).
    unit_phases: list[int] | None = Field(default_factory=lambda: [1], max_length=100)
    time: TimeSpec
    timing: Timing = "fixed"
    note: str = ""
    # Plates each unit stores (incubators); None = it does not store plates.
    capacity: list[int] | None = Field(default=None, max_length=100)
    # Plates already inside each unit when the day starts (counted against its capacity).
    stored_at_start: list[int] | None = Field(default=None, max_length=100)
    imager_units: list[int] = Field(default=[], max_length=100)  # units with an imaging add-on (they image the plates stored inside)

    @model_validator(mode="after")
    def _check_storage(self):
        if self.stored_at_start is not None:
            if self.capacity is None:
                raise ValueError(f"{self.name}: plates inside at the start need a capacity")
            for i, n in enumerate(self.stored_at_start):
                if n < 0 or (i < len(self.capacity) and n > self.capacity[i]):
                    raise ValueError(f"{self.name} unit {i + 1}: {n} plates inside, but it holds {self.capacity[i] if i < len(self.capacity) else 0}")
        return self

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
    devices: list[str] = Field(min_length=1, max_length=20, description="Alternatives; the first free one is used")
    units: list[int] | None = Field(default=None, max_length=100, description="Restrict to these unit numbers (single device only)")
    time: TimeSpec | None = None  # overrides the device's time for this step
    dwell: TimeSpec | None = None  # waiting after the step without holding the device (e.g. incubation)
    timing: Timing | None = None  # overrides the device's timing tag for this step
    label: str | None = None
    optional: bool = False
    enabled: bool = True
    transport: Transport = "cobot"  # how the item gets into this step
    join: str | None = None  # rendezvous key: waits for an item from another route at a step with the same key
    sync: str | None = None  # start key: waits for an item from another route, then each uses its own device
    spawn: list[Spawn] = Field(default=[], max_length=20)
    image: bool = False  # the device images the whole plate here (adds the plate imaging time; needs an imager unit)
    store: bool = False  # last step only: the plate stays in this unit, takes a slot and is imaged on schedule


class Imaging(BaseModel):
    """How long an imager takes per plate, and when stored plates are imaged again."""

    model_config = ConfigDict(allow_inf_nan=False)

    wells_per_plate: int = Field(default=96, ge=1, le=1536)
    drops_per_well: int = Field(default=3, ge=1, le=16)  # imaged within the well's time
    seconds_per_well: float = Field(default=8, ge=0, le=3600)  # several images per well, Z-stacked
    # Hours after a plate is stored at which it is imaged again, to follow crystal growth.
    schedule_hours: list[float] = Field(default=[1, 2, 4, 8, 16, 32, 64, 128], max_length=100)

    @model_validator(mode="after")
    def _check_schedule(self):
        if any(h <= 0 for h in self.schedule_hours):
            raise ValueError("imaging hours must be after the plate is stored (more than 0)")
        self.schedule_hours = sorted(set(self.schedule_hours))
        return self

    def plate_time(self) -> float:
        return self.wells_per_plate * self.seconds_per_well


class Growth(BaseModel):
    """How long a stored crystal plate grows before it can be soaked: normal, cut off at min and max."""

    model_config = ConfigDict(allow_inf_nan=False)

    mean_hours: float = Field(default=48, gt=0, le=24 * 60)
    sd_hours: float = Field(default=24, ge=0, le=24 * 60)
    min_hours: float = Field(default=2, ge=0, le=24 * 60)
    max_hours: float = Field(default=168, gt=0, le=24 * 60)

    @model_validator(mode="after")
    def _check_range(self):
        if not self.min_hours <= self.mean_hours <= self.max_hours:
            raise ValueError("growth: the mean must lie between the shortest and the longest time")
        return self


class Loop(BaseModel):
    start: int = Field(ge=0)  # first step index in the loop
    end: int = Field(ge=0)  # last step index in the loop (inclusive)
    times: int = Field(default=1, ge=1, le=200)


Scenario = Literal["run", "shutdown"]
# A follow-on day is the second of two run days in a row: it starts with day 1's unfinished work.
DayType = Literal["run", "shutdown", "follow_on"]


class Placement(BaseModel):
    """Where one station sits along the cobot rail. The engine ignores the layout; the app uses it
    to replay a run physically and check the arms for clashes."""

    model_config = ConfigDict(allow_inf_nan=False)

    station: str = Field(min_length=1)  # "<device id>" for unlimited devices, "<device id>:<unit>" otherwise
    x: float = Field(ge=0, le=1000)  # metres along the rail to the station's pick point
    side: Literal[-1, 1] = 1  # which side of the rail it stands on


class Layout(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    placements: list[Placement] = Field(default=[], max_length=2000)
    rail_speed: float = Field(default=0.8, ge=0.01, le=10)  # m/s of a carriage along the rail
    handoff_time: float = Field(default=4, ge=0, le=3600)  # s for one pick or one place
    min_separation: float = Field(default=0.9, gt=0, le=20)  # m between two carriage centres
    return_home: bool = True  # an idle arm goes back to its home position on the rail


class Route(BaseModel):
    id: str = Field(min_length=1)
    name: str
    group: str = ""
    labware: str = ""
    enabled: bool = True
    scenarios: list[Scenario] = ["run", "shutdown"]
    count: int = Field(default=1, ge=0, le=500, description="Items released; 0 = only fed by spawns")
    interval: float = Field(default=0, ge=0, le=MAX_TIME)
    offset: float = Field(default=0, ge=0, le=MAX_TIME)
    steps: list[Step] = Field(min_length=1, max_length=MAX_LIST)
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
    devices: list[Device] = Field(min_length=1, max_length=MAX_LIST)
    routes: list[Route] = Field(min_length=1, max_length=MAX_LIST)
    move_time: TimeSpec = TimeSpec(value=30)  # cobot move time
    cobots_by_phase: dict[int, int] = {1: 0, 2: 0, 3: 1, 4: 3}
    layout: Layout | None = None  # physical arrangement; None = the app's default arrangement
    imaging: Imaging = Imaging()
    growth: Growth = Growth()

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
                if s.store and (i != n or len(s.devices) != 1):
                    raise ValueError(f"{where}: only the last step can store the plate, at one device")
                if s.store and s.join:
                    raise ValueError(f"{where}: a step that stores the plate cannot also be a meeting point")
                if s.store and self.device(s.devices[0]).capacity is None:
                    raise ValueError(f"{where} stores the plate in {s.devices[0]}, which has no capacity set")
                if s.image and not any(self.device(d).imager_units for d in s.devices):
                    raise ValueError(f"{where} images the plate, but none of its devices has an imager")
        return self


class RunSettings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    scenario: DayType = "run"
    day_length: float = Field(
        default=24 * 3600, gt=0, le=7 * 24 * 3600, description="Seconds from the start of one day to the start of the next"
    )
    days: int = Field(default=1, ge=1, le=30, description="Run and shutdown days: consecutive days simulated, day_length apart")
    time_variation: float = Field(default=0, ge=0, le=0.5, description="Vary times that have no spread by up to this fraction")
    runs: int = Field(default=1, ge=1, le=50, description="Repeats with seeds seed, seed+1, ... for result ranges")
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
    "completed",  # device/unit set when the plate stays stored there
    "image_start",  # a stored plate imaged again on schedule
    "image_end",
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
    arm: int | None = None  # which arm on the rail made a cobot move (when the workflow has a layout)
    carried: bool = False  # the item comes from the day before (follow-on days)
    due: float | None = None  # image_start: when the schedule wanted the image
    takes: int | None = None  # process_start of a route's first step: the stored plate (item) it took out, if simulated


class RailMove(BaseModel):
    item: int
    arm: int
    start: float
    end: float  # arm free again
    pick: float  # plate leaves the source nest
    place: float  # plate is in the destination nest
    source: str  # station keys
    target: str
    need: float  # seconds of arm motion
    blocked: float  # seconds the move waited because the rail was in the way (an arm was free)


class RailResult(BaseModel):
    start: float  # rail extent, metres
    end: float
    homes: list[float]
    tracks: list[list[tuple[float, float, int, float]]]  # per arm: (t, x, side, reach) keyframes
    moves: list[RailMove]
