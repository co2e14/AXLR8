"""Builds examples/axl_workflow.json from the AXL deck (see docs/AXL_WORKFLOW.md).

Kept as code so the mapping from deck to config is reviewable; rerun after editing:
    uv run python scripts/build_axl_example.py
"""

import json
from pathlib import Path

from axlr8.model import Workflow

A = "assumed"
P = "project"


def t(v, kind="fixed", spread=0):
    return {"value": v, "kind": kind, "spread": spread}


def d(id, name, phases, secs, kind="process", timing="fixed", note="", **kw):
    return {"id": id, "name": name, "unit_phases": phases, "time": t(secs), "kind": kind, "timing": timing, "note": note, **kw}


devices = [
    d("map_reagents", "MAP (reagents in/out)", None, 0, "manual", note="Manual access point"),
    d("map_plates", "MAP (plates in/out)", None, 0, "manual", note="Manual access point"),
    d("map_pucks", "MAP (pucks in/out)", None, 0, "manual", note="Manual access point"),
    # The Arktik -80 °C store and its Connect bench access (slide 3 lines 29-30) are out of price range;
    # protein comes in and goes out by hand at its own manual access point instead.
    d("map_protein", "MAP (protein in/out)", None, 0, "manual", note="Manual access point; replaces the Arktik and Connect"),
    d("dfsa", "DFSA STX-280 -20 °C", [4], 25, "storage"),
    d("xl200_thaw", "XL200 thawer", [3], 600, timing=A, note="Thaw time not in deck"),
    d("xl200", "XL200 LiHa", [3], 120, timing=A,
      note="Deck says 'batch'. 2 min per plate assumed: slide 2 runs two Mosquitos back to back at 5 min, so the LiHa must supply a plate every 2.5 min"),
    d("centrifuge", "VSpin centrifuge", [1, 4], 120),
    d("peeler", "XPEEL peeler", [1, 4], 18),
    d("plateloc", "PlateLoc foil sealer", [1, 4], 8),
    d("sealer", "A4S clear sealer", [2, 4], 10),
    # Incubators. Slide 3: the STX-500 and STX-200 store and image plates, the STX-1000 only stores them.
    d(
        "spectroq", "SpectroQ", [2, 4, 4], 25, "storage",
        note="STX-500 (P2), STX-200 and STX-1000 (P4). 25 s per access; imaging adds the plate imaging time",
        capacity=[500, 200, 1000], imager_units=[1, 2],
        stored_at_start=[100, 40, 250],  # placeholder: grown plates already inside; set to the real numbers
    ),
    d("benchcel", "BenchCel", [2], 20),
    d("labeller", "Plate labeller", [2], 10, timing=A, note="Time blank in deck"),
    d("dc2sa", "DC2SA compound storage", [2], 25, "storage"),
    d("echo", "Echo 650T", [2, 4], 420, note="Unit 2 is the existing XChem Echo relocated in P4 (slide 3 lists it with quantity 0)"),
    d("mosquito_lcp", "Mosquito LCP", [2], 300),
    d("mosquito_xtal3", "Mosquito Xtal3", [4], 300),
    d("xact", "X-ACT harvester", [2, 3, 3, 4, 4, 4], 2460),
    d("vitrification", "Vitrification", [3], 120, timing=A, note="Not in device list; 1 unit assumed"),
    d("puck_storage", "Puck storage", [3], 25, "storage", timing=A, note="Not in device list; 1 unit assumed"),
    d("ln2", "LN2", None, 30, "storage", timing=A),
    d("waste", "Waste", None, 0, "waste"),
]


def s(*devs, **kw):
    return {"devices": list(devs), **kw}


INCUBATION = t(3600)
BOTH = ["run", "shutdown"]


def soak(n, units_xact, offset):
    return {
        "id": f"soak_{n}", "name": f"Soak workflow {n}", "group": "Soaking", "labware": "Crystal plates",
        "scenarios": ["run"], "count": 8, "interval": 900, "offset": offset,
        "steps": [
            s("spectroq", transport="linked", timing=P, sync=f"soak_{n}_start", label="Retrieve grown plate"),
            s("peeler", units=[n]),
            s("echo", units=[n], join=f"soak_{n}", label="Echo soak"),
            s("sealer"),
            s("spectroq", image=True, label="Pre-soak imaging", dwell=INCUBATION),
            s("spectroq", image=True, transport="linked", label="Post-soak imaging"),
            s("peeler", units=[n]),
            s("xact", units=units_xact, spawn=[{"route": "pins", "count": 1}]),
            s("sealer", optional=True, label="Seal harvested plate"),
            s("spectroq", optional=True, timing=P, label="Return plate to storage"),
        ],
    }


def compound(n):
    return {
        "id": f"compound_{n}", "name": f"Compound plate {n}", "group": "Soaking", "labware": "Compound plate",
        "scenarios": ["run"], "count": 1,
        "steps": [
            s("dc2sa", transport="linked", sync=f"soak_{n}_start", label="Retrieve compound plate"),
            s("centrifuge", units=[n], optional=True, label="Centrifuge*"),
            s("peeler", units=[n]),
            s("echo", units=[n], join=f"soak_{n}", label="Echo soak"),
            s("plateloc"),
            s("dc2sa", label="Return compound plate"),
        ],
        "loop": {"start": 0, "end": 5, "times": 8},
    }


routes = [
    {
        "id": "protein", "name": "Protein from MAP", "group": "Crystallisation setup",
        "labware": "Reagents", "scenarios": BOTH, "count": 1,
        "steps": [
            s("map_protein", transport="manual"),
            s("centrifuge"),
            s("xl200"),
            s("ln2", optional=True, enabled=False, label="Leftover: LN2"),
            s("map_protein", optional=True, enabled=False, label="Leftover: protein out"),
        ],
    },
    {
        "id": "reagents_minus20", "name": "Reagents from -20 °C", "group": "Crystallisation setup",
        "labware": "Reagents", "scenarios": BOTH, "count": 1,
        "steps": [
            s("map_reagents", transport="manual"),
            s("dfsa", transport="manual"),
            s("xl200_thaw"),
            s("centrifuge"),
            s("peeler"),
            s("xl200"),
            s("ln2", optional=True, enabled=False, label="Leftover: LN2"),
            s("dfsa", optional=True, enabled=False, label="Leftover: DFSA"),
        ],
    },
    {
        "id": "reagents_spectroq", "name": "Reagents from SpectroQ", "group": "Crystallisation setup",
        "labware": "Reagents", "scenarios": BOTH, "count": 1,
        "steps": [
            s("map_reagents", transport="manual"),
            s("spectroq", transport="manual"),
            s("centrifuge", optional=True, label="Centrifuge*"),
            s("peeler", optional=True, label="Peeler*"),
            s("xl200"),
            s("sealer", optional=True, enabled=False, label="Leftover: Sealer/Capper"),
            s("spectroq", optional=True, enabled=False, label="Leftover: SpectroQ"),
        ],
    },
    {
        "id": "source_plates", "name": "Mosquito source plates", "group": "Crystallisation setup",
        "labware": "Source plates", "scenarios": BOTH, "count": 2,
        "steps": [
            s("benchcel", transport="linked"),
            s("labeller", transport="linked"),
            s("xl200"),
            s("sealer"),
            s("centrifuge", optional=True, label="Centrifuge*"),
            s("peeler"),
            s("mosquito_xtal3", "mosquito_lcp", join="mosquito", label="Mosquito"),
            s("waste"),
        ],
        "loop": {"start": 6, "end": 6, "times": 8},
    },
    {
        "id": "crystal_plates", "name": "Crystal plates", "group": "Crystallisation setup",
        "labware": "Crystal plates", "scenarios": BOTH, "count": 16,
        "steps": [
            s("benchcel", transport="linked"),
            s("labeller", transport="linked"),
            s("xl200"),
            s("mosquito_xtal3", "mosquito_lcp", join="mosquito", label="Mosquito"),
            s("sealer"),
            s("centrifuge", optional=True, label="Centrifuge*"),
            s("spectroq", timing=P, image=True, store=True, label="Growth storage"),
        ],
    },
    soak(1, [1, 3, 5], 0),
    soak(2, [2, 4, 6], 450),
    compound(1),
    compound(2),
    {
        "id": "pins", "name": "Pins", "group": "After harvesting", "labware": "Pins / pucks",
        "scenarios": BOTH, "count": 0,
        "steps": [s("vitrification"), s("puck_storage")],
    },
    {
        "id": "seed_tubes", "name": "Seed tubes", "group": "Seed stock generation", "labware": "Seed tubes",
        "scenarios": ["shutdown"], "count": 4,
        "steps": [
            s("xact"),
            s("xl200"),
            s("centrifuge", optional=True, label="Centrifuge*"),
            s("xl200", spawn=[{"route": "seed_vitrification", "count": 1}]),
            s("spectroq", label="Seed stock storage"),
        ],
    },
    {
        "id": "seed_vitrification", "name": "Seed stock vitrification", "group": "Seed stock generation",
        "labware": "Seed tubes", "scenarios": ["shutdown"], "count": 0,
        "steps": [s("vitrification"), s("dfsa")],
    },
]

wf = Workflow.model_validate(
    {
        "name": "AXL workflow",
        "devices": devices,
        "routes": routes,
        "move_time": {"value": 30, "kind": "fixed", "spread": 0},
        "cobots_by_phase": {1: 0, 2: 0, 3: 1, 4: 3},
    }
)
out = Path(__file__).resolve().parents[2] / "examples" / "axl_workflow.json"
out.write_text(wf.model_dump_json(indent=2, exclude_defaults=False) + "\n")
print(f"wrote {out}")
