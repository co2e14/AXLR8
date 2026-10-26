import type { RunSettings, SimResult, Workflow } from './types'

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

export const listExamples = () => request<string[]>('/api/examples')
export const getExample = (name: string) => request<Workflow>(`/api/examples/${encodeURIComponent(name)}`)
