// Browses the mock lab metadata database (db/schema.sql): every table and view, page by page, with a
// filter on one column. The data is built from one simulated day of the current workflow.
import { useCallback, useEffect, useState } from 'react'
import { buildLabDb, labDbRows, labDbStatus } from '../lib/api'
import type { DbRows, DbStatus, DbTable, RunSettings, Workflow } from '../lib/types'
import './DataView.css'

const PAGE = 50

interface Props {
  wf: Workflow
  run: RunSettings
}

export function DataView({ wf, run }: Props) {
  const [status, setStatus] = useState<DbStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [table, setTable] = useState('drop_history')

  useEffect(() => {
    labDbStatus().then(setStatus).catch((e: Error) => setError(e.message))
  }, [])

  const rebuild = async () => {
    setBuilding(true)
    setError(null)
    try {
      setStatus(await buildLabDb(wf, run))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBuilding(false)
    }
  }

  const sections = new Map<string, DbTable[]>()
  for (const t of status?.tables ?? []) {
    if (!sections.has(t.section)) sections.set(t.section, [])
    sections.get(t.section)!.push(t)
  }
  const current = status?.tables.find((t) => t.name === table) ?? null

  return (
    <div className="data-view">
      <div className="data-bar">
        <button type="button" className="primary" disabled={building} onClick={rebuild}>
          {building ? 'Building…' : status?.built ? 'Rebuild from this workflow' : 'Build the database'}
        </button>
        <p className="hint">
          {status?.built
            ? <>Mock instrument data from one simulated day ({status.source ?? 'an earlier run'}), in Postgres. Every plate, drop, image, crystal and pin, and what each instrument reported.</>
            : 'Builds a Postgres database of mock instrument data from one simulated day of this workflow, with the current day type, equipment, cobots and seed. Takes a few seconds.'}
        </p>
      </div>
      {error && <p className="lab-warn" role="alert">{error}</p>}

      {status?.built && (
        <div className="data-body">
          <nav className="data-tables" aria-label="Tables">
            {[...sections].map(([section, tables]) => (
              <div key={section}>
                <h4>{section}</h4>
                <ul>
                  {tables.map((t) => (
                    <li key={t.name}>
                      <button type="button" className={t.name === table ? 'on' : undefined} aria-current={t.name === table} onClick={() => setTable(t.name)}>
                        <span>{t.name}</span>
                        <span className="count">{t.rows.toLocaleString()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          {current && <TableView key={current.name + (status.source ?? '')} table={current} />}
        </div>
      )}
    </div>
  )
}

function TableView({ table }: { table: DbTable }) {
  const [data, setData] = useState<DbRows | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [column, setColumn] = useState(table.columns[0]?.name ?? '')
  const [value, setValue] = useState('')
  const [applied, setApplied] = useState({ column: '', value: '' })

  const load = useCallback(() => {
    labDbRows(table.name, { limit: PAGE, offset, ...applied })
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [table.name, offset, applied])
  useEffect(load, [load])

  const filterBy = (col: string, v: string) => {
    setColumn(col)
    setValue(v)
    setOffset(0)
    setApplied({ column: col, value: v })
  }
  const total = data?.total ?? 0

  return (
    <section className="data-table" aria-label={table.name}>
      <header>
        <h3>{table.name} <span className="hint">{table.kind === 'view' ? 'view' : 'table'}</span></h3>
        <form
          className="data-filter"
          onSubmit={(e) => {
            e.preventDefault()
            filterBy(column, value)
          }}
        >
          <label>
            <span className="sr-only">Column</span>
            <select value={column} onChange={(e) => setColumn(e.target.value)}>
              {table.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Contains</span>
            <input type="search" placeholder="contains…" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <button type="submit" className="quiet">Filter</button>
          {applied.value && <button type="button" className="link" onClick={() => filterBy(column, '')}>Clear</button>}
        </form>
      </header>
      {error && <p className="lab-warn" role="alert">{error}</p>}
      <div className="data-scroll">
        <table>
          <thead>
            <tr>{table.columns.map((c) => <th key={c.name} scope="col" title={c.type}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {data?.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => {
                  const text = cell(v)
                  return (
                    <td key={j} className={typeof v === 'number' ? 'num' : undefined} title={text.length > 40 ? text : undefined}>
                      {v === null ? <span className="null">—</span> : (
                        <button type="button" className="cell" onClick={() => filterBy(table.columns[j].name, text)} title={`Show rows where ${table.columns[j].name} contains this`}>
                          {text.length > 60 ? `${text.slice(0, 57)}…` : text}
                        </button>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="data-pager">
        <span className="hint">
          {total === 0 ? 'No rows' : `Rows ${offset + 1}–${Math.min(offset + PAGE, total)} of ${total.toLocaleString()}`}
          {applied.value ? ` where ${applied.column} contains “${applied.value}”` : ''}. Click a value to filter by it.
        </span>
        <button type="button" className="quiet" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button type="button" className="quiet" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </footer>
    </section>
  )
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
  const s = String(v)
  // ISO timestamps: drop the seconds' fraction and the T
  return /^\d{4}-\d\d-\d\dT/.test(s) ? s.replace('T', ' ').replace(/\.\d+/, '') : s
}
