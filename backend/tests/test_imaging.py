import pytest

from axlr8.engine import simulate
from axlr8.kpis import compute_kpis
from axlr8.model import Imaging, RunSettings
from conftest import dev, done, route, step, wf


def incubator(**kw):
    return dev("inc", 10, units=2, capacity=kw.pop("capacity", [5, 5]), imager_units=kw.pop("imager_units", [1]), **kw)


def plates(n=1, imaging=None, **kw):
    imaging = imaging or Imaging(wells_per_plate=10, seconds_per_well=6, schedule_hours=[1, 2])
    return wf([incubator(**kw)], [route("p", [step("inc", image=True, store=True)], count=n)], imaging=imaging)


def test_imaging_a_plate_takes_wells_times_seconds_per_well():
    events = simulate(plates(), RunSettings())
    # 10 s access + 10 wells x 6 s, on the unit with the imager
    assert done(events) == [70]
    assert {e.unit for e in events if e.kind == "process_start"} == {1}


def test_a_stored_plate_stays_and_is_imaged_on_schedule():
    events = simulate(plates(), RunSettings())
    end = next(e for e in events if e.kind == "completed")
    assert (end.device, end.unit) == ("inc", 1)
    images = [(e.t, e.due) for e in events if e.kind == "image_start"]
    assert images == [(70 + 3600, 70 + 3600), (70 + 7200, 70 + 7200)]


def test_scheduled_images_wait_for_the_imager():
    events = simulate(plates(n=2, imaging=Imaging(wells_per_plate=100, seconds_per_well=40, schedule_hours=[1])), RunSettings())
    starts = sorted((e.t, e.due) for e in events if e.kind == "image_start")
    # each image takes 4000 s; the second plate's is due while the first one's is running
    assert starts[1][0] == pytest.approx(starts[0][0] + 4000)
    assert starts[1][0] > starts[1][1]
    k = compute_kpis(plates(n=2, imaging=Imaging(wells_per_plate=100, seconds_per_well=40, schedule_hours=[1])), RunSettings(), events)
    inc = k.incubators[0]
    assert (inc.stored_end, inc.images, inc.scheduled) == (2, 4, 2)
    assert inc.max_delay > 0
    assert k.makespan == max(e.t for e in events if e.kind == "completed")  # re-imaging is not the day's work
    assert k.stuck == []


def test_a_full_incubator_takes_no_more_plates():
    events = simulate(plates(n=3, capacity=[2, 2]), RunSettings())
    assert len(done(events)) == 2  # the third plate waits for a slot


def test_a_follow_on_day_remembers_plates_stored_the_day_before():
    w = plates(imaging=Imaging(wells_per_plate=10, seconds_per_well=6, schedule_hours=[1, 20, 30]))
    run = RunSettings(scenario="follow_on", day_length=2 * 3600)
    events = simulate(w, run)
    k = compute_kpis(w, run, events)
    assert k.incubators[0].stored_start == 1 and k.incubators[0].stored_end == 2
    assert k.carried_over == 0  # a stored plate is not unfinished work
    due = [e.due for e in events if e.kind == "image_start" and e.carried]
    assert due == [70 + 3600 - 7200, 70 + 20 * 3600 - 7200]  # 30 h is after the day ends


def test_on_the_rail_a_plate_is_carried_to_a_unit_with_room():
    from axlr8.model import Layout, Placement
    w = plates(n=3, capacity=[1, 5], imager_units=[1, 2])
    w = w.model_copy(update={"layout": Layout(placements=[Placement(station="inc:1", x=1), Placement(station="inc:2", x=3)])})
    events = simulate(w, RunSettings(cobots=1))
    assert len(done(events)) == 3


def test_plates_inside_at_the_start_take_slots():
    w = plates(n=3, capacity=[2, 2], stored_at_start=[1, 2])
    events = simulate(w, RunSettings())
    assert len(done(events)) == 1  # unit 1 has one free slot; unit 2 is full (and has no imager)
    k = compute_kpis(w, RunSettings(), events)
    assert [(i.stored_start, i.stored_end) for i in k.incubators] == [(1, 2), (2, 2)]


def test_more_plates_inside_than_the_unit_holds_is_rejected():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError, match="holds 2"):
        plates(capacity=[2, 2], stored_at_start=[3, 0])


def test_soak_images_go_ahead_of_growth_images():
    from axlr8.model import TimeSpec
    # One imager. A plate stored at 0 is due a growth image at 1 h; at the same moment a soak plate
    # starts queuing for its image. The soak goes first even though the growth image was asked first.
    inc = incubator(capacity=[5, 5], imager_units=[1], stored_at_start=[2, 0])  # grown plates to soak
    grow = route("grow", [step("inc", image=True, store=True)], count=1)
    soak = route("soak", [step("inc", image=True, units=[1])], count=1, offset=3670 - 1)
    hold = route("hold", [step("inc", units=[1], time=TimeSpec(value=2))], count=1, offset=3670 - 1.5)
    w = wf([inc], [grow, soak, hold], imaging=Imaging(wells_per_plate=10, seconds_per_well=6, schedule_hours=[1]))
    events = simulate(w, RunSettings())
    growth = next(e for e in events if e.kind == "image_start")
    soak_start = next(e for e in events if e.kind == "process_start" and e.route == "soak")
    assert growth.due < soak_start.t < growth.t  # due first, but waited for the soak
