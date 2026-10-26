"""Lab configuration, run settings and the simulation event record.

All times are in seconds.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

INPUT = "input"
OUTPUT = "output"


class TimeSpec(BaseModel):
    """A duration: `value` is the nominal time, `spread` how far it can vary."""

    value: float = Field(ge=0)
    kind: Literal["fixed", "normal", "uniform", "triangular"] = "fixed"
    spread: float = Field(default=0, ge=0)


class Station(BaseModel):
    id: str = Field(min_length=1)
    name: str
    process_time: TimeSpec
    capacity: int = Field(default=1, ge=1, description="Parallel slots")
    batch_size: int = Field(default=1, ge=1, description="Samples processed together per slot")
    buffer_size: int | None = Field(default=None, ge=1, description="Waiting places; None = unlimited")

    @model_validator(mode="after")
    def _buffer_fits_batch(self):
        if self.buffer_size is not None and self.buffer_size < self.batch_size:
            raise ValueError(
                f"station '{self.id}': buffer_size ({self.buffer_size}) must be at least "
                f"batch_size ({self.batch_size}), otherwise a batch can never fill"
            )
        return self


class Arm(BaseModel):
    id: str = Field(min_length=1)
    name: str


class Transfer(BaseModel):
    from_id: str
    to_id: str
    time: TimeSpec
    arm: str | None = None


class LabConfig(BaseModel):
    name: str = "Untitled lab"
    stations: list[Station] = Field(min_length=1)
    arms: list[Arm] = []
    transfers: list[Transfer] = []

    def locations(self) -> list[str]:
        return [INPUT, *(s.id for s in self.stations), OUTPUT]

    def transfer_for(self, from_id: str, to_id: str) -> Transfer:
        for t in self.transfers:
            if t.from_id == from_id and t.to_id == to_id:
                return t
        return Transfer(from_id=from_id, to_id=to_id, time=TimeSpec(value=0))

    @model_validator(mode="after")
    def _check_references(self):
        ids = [s.id for s in self.stations]
        if len(set(ids)) != len(ids):
            raise ValueError("station ids must be unique")
        if INPUT in ids or OUTPUT in ids:
            raise ValueError(f"'{INPUT}' and '{OUTPUT}' are reserved and cannot be station ids")
        arm_ids = [a.id for a in self.arms]
        if len(set(arm_ids)) != len(arm_ids):
            raise ValueError("arm ids must be unique")
        locs = self.locations()
        legal = set(zip(locs, locs[1:]))
        seen = set()
        for t in self.transfers:
            pair = (t.from_id, t.to_id)
            if pair not in legal:
                raise ValueError(
                    f"transfer {t.from_id} -> {t.to_id} does not join consecutive steps of the route"
                )
            if pair in seen:
                raise ValueError(f"duplicate transfer {t.from_id} -> {t.to_id}")
            seen.add(pair)
            if t.arm is not None and t.arm not in arm_ids:
                raise ValueError(f"transfer {t.from_id} -> {t.to_id} uses unknown arm '{t.arm}'")
        return self


class RunSettings(BaseModel):
    num_samples: int = Field(default=1, ge=1, le=2000)
    arrival_interval: float = Field(default=0, ge=0, description="Seconds between releases; 0 = all at once")
    seed: int | None = None


EventKind = Literal[
    "released", "dest_reserved", "move_start", "move_end", "process_start", "process_end", "completed"
]


class Event(BaseModel):
    t: float
    sample: int
    kind: EventKind
    at: str
    to: str | None = None
    arm: str | None = None
    batch: int | None = None
