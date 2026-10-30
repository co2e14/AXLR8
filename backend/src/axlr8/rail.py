"""The cobots as PreciseFlex arms on one shared linear rail.

Arms keep their order along the rail (arm 0 nearest the start) and never come closer than
`min_separation`, so they cannot pass each other. A move goes to an idle arm only when the whole
stretch of rail it needs (from where the arm is, to the source station, to the destination
station) is clear of the busy arms, with room for the idle arms in between to stand aside. Idle
arms are moved out of the way, and go back towards their home positions when they can.

Each arm's motion is kept as keyframes (t, x, side, reach) that the app replays in 3D.
"""

from dataclasses import dataclass, field

from axlr8.model import Layout

EPS = 1e-9

Key = tuple[float, float, int, float]  # t, x along the rail, side the gripper points to, reach 0..1


@dataclass
class _Busy:
    lo: float  # stretch of rail the arm needs until `end`
    hi: float
    end: float


@dataclass
class Plan:
    arm: int
    start: float
    end: float  # when the arm is free again
    pick: float  # when the plate leaves the source nest
    place: float  # when it is in the destination nest
    need: float  # seconds of motion at full speed


@dataclass
class Rail:
    layout: Layout
    arms: int
    start: float  # rail extent
    end: float
    homes: list[float] = field(default_factory=list)
    tracks: list[list[Key]] = field(default_factory=list)
    busy: list[_Busy | None] = field(default_factory=list)

    @classmethod
    def build(cls, layout: Layout, arms: int, station_xs: list[float]) -> "Rail":
        # Past the outermost stations there is room for every other arm to park, so any arm can be
        # cleared out of the way of a move to either end.
        sep = layout.min_separation
        start = min(station_xs) - sep * (arms - 1)
        end = max(station_xs) + sep * (arms - 1)
        rail = cls(layout, arms, start, end)
        rail.homes = [start + (end - start) * (i + 0.5) / arms for i in range(arms)]
        rail.tracks = [[(0.0, x, 1, 0.0)] for x in rail.homes]
        rail.busy = [None] * arms
        return rail

    # ----- positions -----

    def pos(self, arm: int, t: float) -> float:
        return sample(self.tracks[arm], t)[1]

    def _cut(self, arm: int, t: float) -> Key:
        """Drops the arm's planned motion after t; returns its keyframe at t."""
        track = self.tracks[arm]
        now = sample(track, t)
        while track and track[-1][0] >= t:
            track.pop()
        track.append(now)
        return now

    # ----- choosing an arm -----

    def _bounds(self, arm: int, lo: float, hi: float) -> bool:
        """Whether `arm` can have the stretch [lo, hi] with every arm between it and the nearest
        busy arm (or the rail end) standing aside."""
        sep = self.layout.min_separation
        for j in range(arm - 1, -2, -1):
            if j < 0:
                if lo - sep * arm < self.start - EPS:
                    return False
                break
            b = self.busy[j]
            if b is not None:
                if b.hi + sep * (arm - j) > lo + EPS:
                    return False
                break
        for j in range(arm + 1, self.arms + 1):
            if j == self.arms:
                if hi + sep * (self.arms - 1 - arm) > self.end + EPS:
                    return False
                break
            b = self.busy[j]
            if b is not None:
                if hi + sep * (j - arm) > b.lo - EPS:
                    return False
                break
        return True

    def idle(self) -> list[int]:
        return [i for i, b in enumerate(self.busy) if b is None]

    def choose(self, t: float, xs: float, xd: float) -> int | None:
        """The nearest idle arm that can make the move now, or None if every path is blocked."""
        best: tuple[float, int] | None = None
        for i in self.idle():
            x0 = self.pos(i, t)
            if self._bounds(i, min(x0, xs, xd), max(x0, xs, xd)):
                cand = (abs(x0 - xs), i)
                if best is None or cand < best:
                    best = cand
        return None if best is None else best[1]

    # ----- moving -----

    def assign(self, arm: int, t: float, xs: float, side_s: int, xd: float, side_d: int, min_window: float) -> Plan:
        v = self.layout.rail_speed
        h = self.layout.handoff_time
        x0 = self._cut(arm, t)[1]
        t1 = t + abs(xs - x0) / v
        t2 = t1 + h
        t3 = t2 + abs(xd - xs) / v
        t4 = t3 + h
        need = t4 - t
        end = t + max(min_window, need)
        self.tracks[arm] += [
            (t1, xs, side_s, 0.0),
            ((t1 + t2) / 2, xs, side_s, 1.0),
            (t2, xs, side_s, 0.0),
            (t3, xd, side_d, 0.0),
            ((t3 + t4) / 2, xd, side_d, 1.0),
            (t4, xd, side_d, 0.0),
        ]
        self.busy[arm] = _Busy(min(x0, xs, xd), max(x0, xs, xd), end)
        self._settle(t)
        return Plan(arm, t, end, (t1 + t2) / 2, (t3 + t4) / 2, need)

    def release(self, arm: int, t: float) -> None:
        self.busy[arm] = None
        self._settle(t)

    def _settle(self, t: float) -> None:
        """Sends every idle arm towards where it wants to be (home, or where it stands), kept clear
        of the busy arms' stretches and in order along the rail."""
        sep = self.layout.min_separation
        v = self.layout.rail_speed
        n = self.arms
        for k in self.idle():
            want = self.homes[k] if self.layout.return_home else self.tracks[k][-1][1]
            lb = self.start + sep * k
            for j in range(k - 1, -1, -1):
                if self.busy[j] is not None:
                    lb = self.busy[j].hi + sep * (k - j)
                    break
            ub = self.end - sep * (n - 1 - k)
            for j in range(k + 1, n):
                if self.busy[j] is not None:
                    ub = self.busy[j].lo - sep * (j - k)
                    break
            target = max(min(want, ub), lb)  # if squeezed (it should not be), keep clear of the arm before
            track = self.tracks[k]
            moving = track[-1][0] > t
            if not moving and abs(track[-1][1] - target) < EPS:
                continue
            _, x, side, _ = self._cut(k, t)
            if abs(x - target) > EPS:
                track.append((t + abs(target - x) / v, target, side, 0.0))


def sample(track: list[Key], t: float) -> Key:
    lo, hi, found = 0, len(track) - 1, -1
    while lo <= hi:
        mid = (lo + hi) // 2
        if track[mid][0] <= t:
            found, lo = mid, mid + 1
        else:
            hi = mid - 1
    if found < 0:
        return (t, *track[0][1:])
    a = track[found]
    if found + 1 >= len(track) or track[found + 1][0] <= a[0]:
        return (t, *a[1:])
    b = track[found + 1]
    f = (t - a[0]) / (b[0] - a[0])
    side = a[2] if a[3] > 0 else b[2]
    return (t, a[1] + (b[1] - a[1]) * f, side, a[3] + (b[3] - a[3]) * f)
