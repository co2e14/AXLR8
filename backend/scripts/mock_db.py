"""Writes db/seed.sql: mock lab metadata from one simulated day of the AXL example (see docs/METADATA.md).

    uv run python scripts/mock_db.py                # writes db/seed.sql
    psql -d axlr8 -f db/schema.sql -f db/seed.sql   # into an existing database

Options: --phase, --scenario (run | follow_on | shutdown), --seed, --out.
"""

import argparse
from pathlib import Path

from axlr8.mockdata import build
from axlr8.model import RunSettings, Workflow

ROOT = Path(__file__).resolve().parents[2]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", type=int, default=4)
    ap.add_argument("--scenario", default="run", choices=["run", "follow_on", "shutdown"])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=ROOT / "db" / "seed.sql")
    a = ap.parse_args()
    wf = Workflow.model_validate_json((ROOT / "examples" / "axl_workflow.json").read_text())
    sql = build(wf, RunSettings(scenario=a.scenario, phase=a.phase, seed=a.seed))
    a.out.write_text(sql)
    print(f"wrote {a.out} ({len(sql) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
