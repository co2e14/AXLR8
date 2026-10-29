import type { DbRows, DbStatus, OptimiseResult, RunSettings, SimResult, Workflow } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new Error('Cannot reach the simulation server. Start it with ./dev.sh (or `uv run uvicorn axlr8.api:app` in backend/).')
  }
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json() as Promise<T>
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((d: { msg: string; loc?: (string | number)[] }) => {
          const where = (d.loc ?? []).slice(1).join(' › ')
          const msg = d.msg.replace(/^Value error, /, '')
          return where ? `${where}: ${msg}` : msg
        })
        .join('\n')
    }
    if (typeof body.detail === 'string') return body.detail.split('; ').join('\n')
  } catch {
    /* fall through */
  }
  return `Server error ${res.status}`
}

export const simulate = (workflow: Workflow, run: RunSettings) =>
  request<SimResult>('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, run }),
  })

/** Searches for the station arrangement that lets the day finish soonest; takes up to `budget_s` seconds. */
export const optimise = (workflow: Workflow, run: RunSettings, widths: Record<string, number>, budget_s: number) =>
  request<OptimiseResult>('/api/optimise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, run: { ...run, single: false }, widths, budget_s }),
  })

export const labDbStatus = () => request<DbStatus>('/api/labdb')

/** Rebuilds the mock lab metadata database from one simulated day of this workflow. */
export const buildLabDb = (workflow: Workflow, run: RunSettings) =>
  request<DbStatus>('/api/labdb/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, run: { ...run, single: false } }),
  })

export function labDbRows(name: string, opts: { limit: number; offset: number; column?: string; value?: string }) {
  const q = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) })
  if (opts.column && opts.value) {
    q.set('column', opts.column)
    q.set('value', opts.value)
  }
  return request<DbRows>(`/api/labdb/${encodeURIComponent(name)}?${q}`)
}

export const listExamples = () => request<string[]>('/api/examples')
export const getExample = (name: string) => request<Workflow>(`/api/examples/${encodeURIComponent(name)}`)
