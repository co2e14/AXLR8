"""The mock lab metadata database, run in an embedded Postgres so the app can browse it.

`rebuild` loads db/schema.sql and the mock data for one simulated day (mockdata.py). `tables` and
`rows` read it back for the app: only tables and views of the `axl` schema can be read, by name, and
filters only compare one of the table's own columns with a value, so no SQL comes from the request.

Needs the optional `db` extra (`uv sync --extra db`): pgserver (Postgres binaries in a wheel) and psycopg.
"""

import threading
from decimal import Decimal
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from axlr8.mockdata import build
from axlr8.model import RunSettings, Workflow

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "db" / "schema.sql"
DATA_DIR = ROOT / "backend" / ".labdb"
MAX_ROWS = 500

# Sections of db/schema.sql, for grouping in the app.
SECTIONS = [
    ("Everything about one thing", ["drop_history", "plate_timeline", "crystal_history"]),
    ("Lab", ["device", "device_unit", "cobot_arm"]),
    ("Samples and labware", ["project", "protein_sample", "screen", "screen_condition", "compound", "labware_type", "plate", "well", "droplet"]),
    ("Operations", ["operation", "cobot_move", "storage_event", "environment_reading", "peel_event", "seal_event",
                    "centrifuge_run", "plate_supply_event", "label_event", "liquid_transfer", "thaw_event",
                    "drop_setup_run", "echo_survey", "echo_transfer"]),
    ("Imaging and crystals", ["imaging_session", "drop_image", "drop_score", "crystal", "crystal_observation"]),
    ("Harvesting", ["dewar", "puck", "pin", "harvest", "vitrification", "puck_storage_event"]),
]


class Unavailable(RuntimeError):
    """The embedded database cannot run here (the `db` extra is not installed)."""


class Column(BaseModel):
    name: str
    type: str


class TableInfo(BaseModel):
    name: str
    kind: str  # 'table' | 'view'
    section: str
    rows: int
    columns: list[Column]


class Rows(BaseModel):
    name: str
    columns: list[Column]
    rows: list[list[Any]]
    total: int  # matching rows
    offset: int


class DbStatus(BaseModel):
    built: bool
    source: str | None = None  # what the data was built from
    tables: list[TableInfo] = []


_lock = threading.RLock()  # rebuild holds it while connecting
_server = None
_source: str | None = None


def _connect():
    global _server
    try:
        import pgserver
        import psycopg
    except ImportError as e:
        raise Unavailable("the lab database needs the optional extra: cd backend && uv sync --extra db") from e
    with _lock:
        if _server is None:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            _server = pgserver.get_server(str(DATA_DIR), cleanup_mode=None)
    return psycopg.connect(_server.get_uri(), autocommit=True)


def rebuild(wf: Workflow, run: RunSettings, source: str) -> DbStatus:
    global _source
    seed_sql = build(wf, run)
    with _lock:
        with _connect() as conn:
            conn.execute("drop schema if exists axl cascade")
            conn.execute(SCHEMA.read_text())
            _copy(conn, seed_sql)
        _source = source
    return status()


def _copy(conn, seed_sql: str) -> None:
    """Runs the generated script: plain statements, and COPY blocks fed through psycopg."""
    lines = seed_sql.splitlines()
    i = 0
    with conn.cursor() as cur:
        cur.execute("set search_path = axl, public")
        while i < len(lines):
            line = lines[i]
            i += 1
            if not line or line.startswith("--") or line in ("begin;", "commit;"):
                continue
            if line.startswith("copy "):
                with cur.copy(line.rstrip(";")) as cp:
                    while lines[i] != "\\.":
                        cp.write(lines[i] + "\n")
                        i += 1
                i += 1
            else:
                cur.execute(line)


def _tables(conn) -> dict[str, tuple[str, list[Column]]]:
    out: dict[str, tuple[str, list[Column]]] = {}
    rows = conn.execute(
        """select c.table_name, t.table_type, c.column_name, c.data_type
           from information_schema.columns c
           join information_schema.tables t using (table_schema, table_name)
           where c.table_schema = 'axl' order by c.table_name, c.ordinal_position"""
    ).fetchall()
    for name, kind, col, typ in rows:
        entry = out.setdefault(name, ("view" if kind == "VIEW" else "table", []))
        entry[1].append(Column(name=col, type=typ))
    return out


def status() -> DbStatus:
    try:
        conn = _connect()
    except Unavailable:
        raise
    with conn:
        found = _tables(conn)
        if not found:
            return DbStatus(built=False)
        section_of = {t: s for s, names in SECTIONS for t in names}
        out = []
        for section, names in SECTIONS:
            for name in names + ([n for n in sorted(found) if n not in section_of] if section == SECTIONS[-1][0] else []):
                if name not in found:
                    continue
                kind, cols = found[name]
                n = conn.execute(f'select count(*) from axl."{name}"').fetchone()[0]  # name is from the catalogue
                out.append(TableInfo(name=name, kind=kind, section=section_of.get(name, section), rows=n, columns=cols))
        return DbStatus(built=True, source=_source, tables=out)


def rows(name: str, limit: int = 50, offset: int = 0, column: str | None = None, value: str | None = None) -> Rows:
    from psycopg import sql

    with _connect() as conn:
        found = _tables(conn)
        if name not in found:
            raise KeyError(name)
        _, cols = found[name]
        names = [c.name for c in cols]
        where = sql.SQL("")
        params: list[Any] = []
        if column and value is not None and value != "":
            if column not in names:
                raise KeyError(column)
            where = sql.SQL(" where {}::text ilike %s").format(sql.Identifier(column))
            params.append(f"%{value}%")
        table = sql.Identifier("axl", name)
        total = conn.execute(sql.SQL("select count(*) from {}").format(table) + where, params).fetchone()[0]
        order = sql.SQL(" order by {}").format(sql.Identifier(names[0]))
        q = sql.SQL("select * from {}").format(table) + where + order + sql.SQL(" limit %s offset %s")
        data = conn.execute(q, [*params, max(1, min(MAX_ROWS, limit)), max(0, offset)]).fetchall()
        return Rows(name=name, columns=cols, rows=[[_plain(v) for v in r] for r in data], total=total, offset=offset)


def _plain(v: Any) -> Any:
    """JSON-friendly cell values."""
    if v is None or isinstance(v, (str, int, float, bool, dict, list)):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)
