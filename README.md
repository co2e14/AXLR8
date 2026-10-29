# AXLR8

Throughput and bottleneck simulator for the AXL automated crystallography lab.
Python (SimPy/FastAPI) backend, TypeScript (React) frontend.

* [docs/AXL_WORKFLOW.md](docs/AXL_WORKFLOW.md): how the AXL deck (`axlworkflow.pptx`) is modelled, with every assumption
* [docs/PLAN.md](docs/PLAN.md): original design

## Quick start

Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
./dev.sh        # starts the API on :8000 and opens the app on http://localhost:5173
```

The app opens with the AXL workflow from the deck: crystallisation setup, two soaking workflows with
their compound plates, harvesting outputs and seed-stock generation, laid out as lanes in the deck's colour key.

- **GO** sends one item down every active route and animates it.
- **Run the day schedule** releases items as configured per route (by default the deck's daily schedule:
  16 crystal plates; soak workflows every 15 min, offset by 7 min 30 s) and replays the day.
- **Day type** switches between *Run day* (soaking active), *Follow-on day* and *Shutdown day* (seed stock
  generation). A follow-on day is the second run day in a row: the day before is simulated too, and the day
  starts with its unfinished work still in the system (set when day 2 starts, 24 h by default). Results cover
  day 2 only; work carried over is counted separately.
- **Equipment** picks the purchase phase (slide 3); only units bought by that phase exist.
- **Cobots** overrides the number of cobot arms on the rail.
- **Days** runs several days in a row (run or shutdown days), so incubators fill, plates set up on one day are soaked
  once they have grown, and the imaging load builds up; the *Days* tab shows each day. **Runs (seeds)** repeats the
  run with different random seeds and shows the range of the results (the middle 80%); **Time variation** varies
  times that have no spread of their own by up to that much, since with every time fixed all runs are the same.
- **3D lab** shows the lab physically: stations either side of one cobot rail, the PreciseFlex arms and every
  plate, replayed with the playback bar. The arms share the rail, so they keep their order and never pass each
  other: a move waits until its stretch of rail is clear, and idle arms stand aside. The panel lists the moves
  held up this way. Edit where each station stands (and the rail speed, pick/place time and arm spacing) under
  *Layout*; station sizes and arm geometry are approximate.
- **Optimise** (3D lab, under *Layout*) searches for the arrangement of stations along the rail that lets the
  day finish soonest with the current day type, equipment and cobot count. Each candidate is scored by
  simulating the whole day: the time until the work finishes, plus the arms' moving time and the time moves
  wait for another arm. The search takes up to 15 s, applies the best layout (with Undo), and the run is then
  out of date until you run it again. `POST /api/optimise` does the same.
- **Plate imaging** (overview panel): the SpectroQs are incubators. Each unit stores a set number of plates, and
  units with an imager image every well of a plate as it goes in and for each soak (wells × seconds per well,
  default 96 × 8 s). They image stored plates again at the hours you list (default 1, 2, 4, 8 … 128 h after the
  plate is stored), and an incubator does nothing else while it is imaging. The *Bottlenecks* tab shows each
  unit's plates stored, imaging load over the day and how late scheduled images ran.
  Each incubator unit has a capacity and the number of plates already inside at the start of the day; the 3D lab
  shows a fill gauge on each one.
- Click a box to edit that step, a route name to edit the route, or a device in the side panel to change
  its time, how its time is classed (fixed, project-specific, assumed) and its units per phase.
- Boxes marked **?** use an assumed time that is not in the deck. Replace them with measured values.
- *Bottlenecks* ranks devices and cobots by how busy they were; *Routes* shows whether each route keeps up
  with its release rate; *Items* shows where everything is at the current moment; *Compare runs* keeps a baseline.
- *Save to file* / *Open file* exchange workflows as JSON. *Reset to deck* reloads the AXL workflow.

## Backend

```bash
cd backend
uv sync
uv run pytest                                        # tests
uv run uvicorn axlr8.api:app --reload --port 8000    # API (docs at /docs)
uv run python scripts/build_axl_example.py           # regenerate examples/axl_workflow.json
```

`POST /api/simulate` takes `{"workflow": <Workflow>, "run": {"scenario", "days", "day_length", "time_variation", "runs", "phase", "cobots", "single", "seed"}}`
and returns the full event log plus KPIs. All times are in seconds. For `"scenario": "follow_on"`, time 0 is the start of
day 2; items carried over from day 1 are marked `carried` and keep their earlier events at negative times. When the workflow has a `layout`
(every station placed) and the run has cobots, moves are made by arms on the rail and the response also has
`rail`: each arm's motion and each move's arm, pick and place times. With `"runs" > 1` it also has `ranges`: the spread of
the main results over that many seeds. Multi-day runs add a per-day breakdown in `kpis.days`.

## Lab metadata database

`db/schema.sql` is a Postgres schema that follows every plate, well, drop, crystal, pin and puck and keeps what
each instrument reports about them; `backend/scripts/mock_db.py` fills it with mock data from a simulated day.
See [docs/METADATA.md](docs/METADATA.md).

In the app, **Lab data** (next to *Workflow map* and *3D lab*) builds that database from one simulated day of the
current workflow and settings, in an embedded Postgres (`uv sync --extra db`; `./dev.sh` does this), and lets you
browse every table and view, filter by any column, and click a value to follow it.

## Frontend

```bash
cd frontend
npm install
npm run dev     # proxies /api to http://127.0.0.1:8000
npm test        # unit tests (vitest)
npm run build
```
