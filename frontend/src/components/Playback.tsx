import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtClock } from '../lib/format'

export const SPEEDS = [1, 10, 60, 300, 1800]

/** Smallest speed that replays the whole run in about 30 seconds or less. */
export const autoSpeed = (makespan: number) => SPEEDS.find((s) => makespan / s <= 30) ?? SPEEDS[SPEEDS.length - 1]

export function usePlayback(makespan: number) {
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const last = useRef<number | null>(null)

  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000
      last.current = now
      setT((prev) => {
        const next = prev + dt * speed
        if (next >= makespan) {
          setPlaying(false)
          return makespan
        }
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      last.current = null
    }
  }, [playing, speed, makespan])

  const start = useCallback((total: number) => {
    setT(0)
    setSpeed(autoSpeed(total))
    setPlaying(true)
  }, [])

  return { t, setT, playing, setPlaying, speed, setSpeed, start }
}

type PlaybackState = ReturnType<typeof usePlayback>

export function PlaybackBar({ pb, makespan }: { pb: PlaybackState; makespan: number }) {
  const atEnd = pb.t >= makespan
  return (
    <div className="playback">
      <button
        type="button"
        className="play"
        onClick={() => {
          if (atEnd) pb.setT(0)
          pb.setPlaying(!pb.playing)
        }}
        aria-label={pb.playing ? 'Pause' : atEnd ? 'Replay' : 'Play'}
      >
        {pb.playing ? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2.5v11a.5.5 0 0 0 .77.42l8.5-5.5a.5.5 0 0 0 0-.84l-8.5-5.5A.5.5 0 0 0 4 2.5Z" /></svg>
        )}
      </button>
      <output className="clock" aria-label="Simulated time">{fmtClock(pb.t)}</output>
      <input
        className="scrub"
        type="range"
        min={0}
        max={makespan}
        step="any"
        value={pb.t}
        aria-label="Simulated time"
        onChange={(e) => {
          pb.setPlaying(false)
          pb.setT(Number(e.target.value))
        }}
      />
      <output className="clock muted">{fmtClock(makespan)}</output>
      <label className="speed">
        <span>Speed</span>
        <select value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? 'Real time' : `${s}×`}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
