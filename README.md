# AXLR8

Throughput and bottleneck simulator for the AXL automated crystallography lab.
Python (SimPy/FastAPI) backend, TypeScript (React/Three.js) frontend, all running locally on your machine.

* [docs/AXL_WORKFLOW.md](docs/AXL_WORKFLOW.md): how the AXL deck (`axlworkflow.pptx`) is modelled, with every assumption
* [docs/METADATA.md](docs/METADATA.md): the lab metadata database
* [docs/PLAN.md](docs/PLAN.md): original design

## Install and run from scratch

### 1. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| [git](https://git-scm.com/) | any | to clone the repository |
| [uv](https://docs.astral.sh/uv/) | 0.5 or newer | runs the Python backend; it downloads Python 3.12 itself, so you do not need to install Python |
| [Node.js](https://nodejs.org/) | **20.19+ or 22.12+** (Vite 8 needs one of these) | builds and serves the web app; npm comes with it |

macOS (with [Homebrew](https://brew.sh/)):

```bash
brew install git uv node
```

Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # uv (open a new shell afterwards)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22                                          # Node 22 LTS with npm
```

Windows: use [WSL](https://learn.microsoft.com/windows/wsl/install) and follow the Linux steps; `dev.sh` is a bash script.

Check:

```bash
uv --version
node --version     # must print v20.19 or later, or v22.12 or later
```

### 2. Get the code

```bash
git clone git@github.com:co2e14/AXLR8.git        # SSH
# or: git clone https://github.com/co2e14/AXLR8.git
cd AXLR8
```

If the repository is private, ask the owner to add your GitHub account first.

### 3. Run it

```bash
./dev.sh
```

This installs the backend (including the embedded Postgres used by the *Lab data* tab), installs the frontend
packages if they are missing, starts the API on http://localhost:8000 and opens the app on http://localhost:5173.
The first run downloads Python, the Python packages and the npm packages, so it takes a few minutes; later runs
start in seconds. Stop everything with `Ctrl+C`.

The API's interactive documentation is at http://localhost:8000/docs.

### 3b. Or run the two halves yourself

Use this if `dev.sh` does not suit your machine, or the embedded Postgres will not install on your platform
(only the *Lab data* tab needs it; everything else works without it).

Terminal 1, the API:

```bash
cd backend
uv sync                      # add --extra db for the Lab data tab
uv run uvicorn axlr8.api:app --port 8000
```

Terminal 2, the web app:

```bash
cd frontend
npm ci                       # installs the exact versions in package-lock.json
npm run dev                  # then open http://localhost:5173
```

The web app forwards `/api` requests to the API on port 8000, so the API must be running.

### 4. Check the install

```bash
curl http://localhost:8000/api/health     # with the API running: {"status":"ok"}
cd backend && uv run pytest               # backend tests
cd frontend && npm test                   # frontend unit tests
cd frontend && npm run build              # type-check and production build
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| The app loads but every run fails with a network or fetch error | The API is not running. Check the terminal for an error from `uv`, or start it by hand (step 3b). |
| `dev.sh` stops while installing `pgserver` or `psycopg` | The embedded Postgres has no build for your platform. Run the two halves yourself (step 3b) without `--extra db`. |
| `Address already in use` on port 8000 or 5173 | Another copy is still running. Stop it, or find it with `lsof -i :8000` and end that process. |
| Vite refuses to start and complains about the Node version | Install Node 22 (`nvm install 22`, or `brew upgrade node`). |
| *Lab data* shows old or broken data | Stop the API, delete `backend/.labdb/`, start again and rebuild it from the app. |
| `./dev.sh: Permission denied` | `chmod +x dev.sh`, or run `bash dev.sh`. |

## Repository layout

```
backend/            Python package axlr8: simulation engine, cobot rail, KPIs, optimiser, FastAPI app
  src/axlr8/        api.py (HTTP API), engine.py (SimPy model), rail.py, optimise.py, labdb.py, ...
  scripts/          build_axl_example.py (regenerates the example workflow), mock_db.py (mock lab data)
  tests/            pytest suite
frontend/           React + Vite app: workflow map, 3D lab, results, lab data browser
db/                 Postgres schema for lab metadata, plus a docker-compose file for a standalone copy
docs/               Workflow model, metadata database and design notes
examples/           axl_workflow.json, the AXL workflow from the deck
axlworkflow.pptx    The AXL workflow deck the model is based on
dev.sh              Starts API and app together
```

## Using the app

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
- **Lab data** (next to *Workflow map* and *3D lab*) builds the lab metadata database from one simulated day of
  the current workflow and settings, and lets you browse every table and view, filter by any column, and click a
  value to follow it. See [Lab metadata database](#lab-metadata-database).
- Click a box to edit that step, a route name to edit the route, or a device in the side panel to change
  its time, how its time is classed (fixed, project-specific, assumed) and its units per phase.
- Boxes marked **?** use an assumed time that is not in the deck. Replace them with measured values.
- *Bottlenecks* ranks devices and cobots by how busy they were; *Routes* shows whether each route keeps up
  with its release rate; *Items* shows where everything is at the current moment; *Compare runs* keeps a baseline.
- The playback bar replays a run at 60x by default; pick a faster speed from its menu for multi-day runs.
- *Save to file* / *Open file* exchange workflows as JSON. *Reset to deck* reloads the AXL workflow. Edits are
  kept in the browser between visits.

## Backend

```bash
cd backend
uv sync                                              # add --extra db for the lab database
uv run pytest                                        # tests
uv run uvicorn axlr8.api:app --reload --port 8000    # API with auto-reload (docs at /docs)
uv run python scripts/build_axl_example.py           # regenerate examples/axl_workflow.json
```

Endpoints:

| Method and path | What it does |
|-----------------|--------------|
| `GET /api/health` | liveness check |
| `GET /api/examples`, `GET /api/examples/{name}` | list and load the example workflows in `examples/` |
| `POST /api/simulate` | run a simulation |
| `POST /api/optimise` | search for the best station layout along the rail |
| `POST /api/labdb/build` | build the lab metadata database from one simulated day |
| `GET /api/labdb`, `GET /api/labdb/{name}` | list tables and views, read rows from one |

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

The app's *Lab data* tab runs this in an embedded Postgres (the `db` extra: `uv sync --extra db`; `./dev.sh`
does this). Its files live in `backend/.labdb/`, which is not committed.

To get a standalone copy you can query with `psql` or any SQL client (needs Docker):

```bash
cd backend && uv run python scripts/mock_db.py     # writes db/seed.sql (not committed)
cd ../db && docker compose up                      # Postgres on localhost:5433
psql postgresql://axl:axl@localhost:5433/axlr8
```

## Frontend

```bash
cd frontend
npm ci          # or npm install
npm run dev     # proxies /api to http://127.0.0.1:8000
npm test        # unit tests (vitest)
npm run lint    # oxlint
npm run build   # type-check and production build into dist/
```
