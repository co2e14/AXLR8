from axlr8.model import Arm, LabConfig, Station, TimeSpec, Transfer


def fixed(value: float) -> TimeSpec:
    return TimeSpec(value=value)


def station(sid: str, seconds: float, **kwargs) -> Station:
    return Station(id=sid, name=sid.upper(), process_time=fixed(seconds), **kwargs)


def transfer(a: str, b: str, seconds: float, arm: str | None = None) -> Transfer:
    return Transfer(from_id=a, to_id=b, time=fixed(seconds), arm=arm)


def lab(stations, transfers=(), arms=()) -> LabConfig:
    return LabConfig(
        name="test",
        stations=list(stations),
        transfers=list(transfers),
        arms=[Arm(id=a, name=a) for a in arms],
    )
