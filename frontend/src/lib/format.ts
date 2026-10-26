const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')

export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`
  return `${Math.floor(s / 3600)} h ${pad((s % 3600) / 60)} min`
}

export function fmtClock(seconds: number): string {
  const s = Math.floor(seconds)
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
}

export const fmtPct = (x: number) => `${Math.round(x * 100)}%`

/** Short form for tight labels: seconds under two minutes, otherwise minutes or hours. */
export function fmtCompact(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 120) return `${s} s`
  if (s < 7200) return `${+(s / 60).toFixed(1)} min`
  return `${+(s / 3600).toFixed(1)} h`
}
