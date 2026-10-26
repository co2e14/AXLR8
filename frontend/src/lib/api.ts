import type { LabConfig, RunSettings, SimResult } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new Error('Cannot reach the simulation server. Start it with `uv run uvicorn axlr8.api:app` in backend/.')
  }
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json() as Promise<T>
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((d: { msg: string; loc?: unknown[] }) => d.msg.replace(/^Value error, /, ''))
        .join('\n')
    }
    if (typeof body.detail === 'string') return body.detail
  } catch {
    /* fall through */
  }
  return `Server error ${res.status}`
}

export const simulate = (lab: LabConfig, run: RunSettings) =>
  request<SimResult>('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lab, run }),
  })

export const listExamples = () => request<string[]>('/api/examples')
export const getExample = (name: string) => request<LabConfig>(`/api/examples/${encodeURIComponent(name)}`)
