// Three.js view of the lab: stations either side of the cobot rail, the PreciseFlex arms on their
// carriages and every plate where it is at time t. Loaded lazily, so three.js only downloads when
// the 3D view is opened.
import { createContext, useContext, useMemo, type ReactNode, type RefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { BENCH_H, NEST_H, NEST_OFFSET, inPhase, type ResolvedLayout, type Station } from '../lib/lab'
import { levelAt, sample, spotAt, type Clash, type Level, type Replay } from '../lib/physical'
import { armPose, PF400 } from '../lib/pf400'
import type { Route, Workflow } from '../lib/types'

export interface Palette {
  bg: string
  floor: string
  rule: string
  ink: string
  bench: string
  rail: string
  arm: string
  clash: string
  fixed: string
  project: string
  manual: string
  waste: string
  groups: Record<string, string>
  fallback: string
}

interface Props {
  wf: Workflow
  layout: ResolvedLayout
  replay: Replay
  t: number
  phase: number
  palette: Palette
  labels: boolean
  selected: string | null
  onSelect: (station: string | null) => void
  levels: Map<string, Level> // incubator units: plates inside over time
  overlay: RefObject<HTMLDivElement | null> // where the HTML labels go (a div over the canvas)
}

// HTML labels are attached to a div the page owns, not to the canvas's parent: that parent may not exist
// yet when the first labels mount, and is already gone when the view unmounts.
const Overlay = createContext<RefObject<HTMLDivElement | null> | null>(null)
const Label = (props: Parameters<typeof Html>[0]) => {
  const overlay = useContext(Overlay)
  return <Html {...props} portal={overlay?.current ? (overlay as RefObject<HTMLDivElement>) : undefined} />
}

const PLATE = { w: 0.128, d: 0.086, h: 0.014 }

export default function Lab3D({ wf, layout, replay, t, phase, palette, labels, selected, onSelect, levels, overlay }: Props) {
  const mid = (replay.start + replay.end) / 2
  const span = replay.end - replay.start
  const routes = useMemo(() => new Map(wf.routes.map((r) => [r.id, r])), [wf.routes])
  const active = replay.clashes.filter((c) => c.start <= t && t <= c.end)
  const clashing = new Set(active.flatMap((c) => c.arms))

  return (
    <Canvas
      frameloop="demand"
      shadows
      camera={{ position: [mid, 3 + span * 0.4, 2.5 + span * 0.45], fov: 35, near: 0.05, far: 200 }}
      onPointerMissed={() => onSelect(null)}
      style={{ background: palette.bg }}
    >
      <Overlay.Provider value={overlay}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[mid - 4, 8, 5]} intensity={1.4} castShadow shadow-mapSize={[2048, 2048]}>
        <orthographicCamera attach="shadow-camera" args={[-mid - 2, mid + 2, 6, -6, 0.1, 30]} />
      </directionalLight>
      <OrbitControls target={[mid, 0.8, 0]} maxPolarAngle={Math.PI / 2.05} makeDefault />

      <mesh rotation-x={-Math.PI / 2} position={[mid, 0, 0]} receiveShadow>
        <planeGeometry args={[span + 4, 7]} />
        <meshStandardMaterial color={palette.floor} />
      </mesh>
      <gridHelper args={[Math.ceil(span + 4), Math.ceil(span + 4), palette.rule, palette.rule]} position={[mid, 0.002, 0]} />

      {/* Rail plinth and track */}
      <mesh position={[mid, PF400.railTop / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[span, PF400.railTop, 0.3]} />
        <meshStandardMaterial color={palette.rail} />
      </mesh>
      <mesh position={[mid, PF400.railTop + 0.005, 0]}>
        <boxGeometry args={[span, 0.01, 0.08]} />
        <meshStandardMaterial color={palette.ink} metalness={0.6} roughness={0.3} />
      </mesh>

      {layout.stations.map((s) => (
        <StationModel
          key={s.key}
          s={s}
          layout={layout}
          bought={inPhase(s, phase)}
          palette={palette}
          label={labels || selected === s.key}
          selected={selected === s.key}
          onSelect={onSelect}
          level={levels.get(s.key) ? { count: levelAt(levels.get(s.key)!, t), capacity: levels.get(s.key)!.capacity } : undefined}
        />
      ))}

      {replay.arms.map((track, i) => (
        <Arm key={i} index={i} k={sample(track, t)} color={clashing.has(i) ? palette.clash : palette.arm} />
      ))}

      {active.map((c, i) => (
        <ClashZone key={i} c={c} replay={replay} t={t} color={palette.clash} />
      ))}

      <Plates replay={replay} layout={layout} routes={routes} t={t} palette={palette} />
      </Overlay.Provider>
    </Canvas>
  )
}

function stationColor(s: Station, p: Palette) {
  if (s.device.kind === 'manual') return p.manual
  if (s.device.kind === 'waste') return p.waste
  return s.device.timing === 'project' ? p.project : p.fixed
}

function StationModel({ s, layout, bought, palette, label, selected, onSelect, level }: {
  level?: { count: number; capacity: number }
  s: Station
  layout: ResolvedLayout
  bought: boolean
  palette: Palette
  label: boolean
  selected: boolean
  onSelect: (station: string | null) => void
}) {
  const p = layout.at.get(s.key)!
  const { w, d, h, floor } = s.fp
  const base = floor ? 0 : BENCH_H
  const z = p.side * (NEST_OFFSET + 0.08 + d / 2)
  const color = stationColor(s, palette)
  const ghost = bought ? {} : { transparent: true, opacity: 0.18, depthWrite: false }
  return (
    <group
      onClick={(e) => {
        e.stopPropagation()
        onSelect(s.key)
      }}
    >
      {!floor && (
        <mesh position={[p.x, BENCH_H / 2, z]} castShadow={bought} receiveShadow>
          <boxGeometry args={[w + 0.1, BENCH_H, d + 0.1]} />
          <meshStandardMaterial color={palette.bench} {...ghost} />
        </mesh>
      )}
      <mesh position={[p.x, base + h / 2, z]} castShadow={bought} receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} emissive={selected ? palette.ink : '#000000'} emissiveIntensity={selected ? 0.35 : 0} {...ghost} />
      </mesh>
      {/* Plate nest: the pick point the arm reaches over */}
      <mesh position={[p.x, NEST_H - 0.01, p.side * NEST_OFFSET]}>
        <boxGeometry args={[0.15, 0.02, 0.15]} />
        <meshStandardMaterial color={palette.ink} {...ghost} />
      </mesh>
      {level && bought && <FillGauge x={p.x} z={z - p.side * (d / 2 + 0.012)} base={base} h={h} w={w} level={level} palette={palette} />}
      {label && (
        <Label position={[p.x, Math.max(base + h, NEST_H) + 0.15, z]} center distanceFactor={8} zIndexRange={[10, 0]}>
          <span className={`lab-label${bought ? '' : ' ghost'}${selected ? ' selected' : ''}`}>{s.name}</span>
        </Label>
      )}
    </group>
  )
}

/** A level gauge on the face of an incubator towards the rail: how full it is, and the count. */
function FillGauge({ x, z, base, h, w, level, palette }: {
  x: number
  z: number
  base: number
  h: number
  w: number
  level: { count: number; capacity: number }
  palette: Palette
}) {
  const frac = level.capacity > 0 ? Math.min(1, level.count / level.capacity) : 0
  const tall = h * 0.8
  const bottom = base + h * 0.1
  const gx = x + w / 2 - 0.08
  const color = frac >= 0.9 ? palette.clash : frac >= 0.75 ? palette.project : palette.manual
  return (
    <group>
      <mesh position={[gx, bottom + tall / 2, z]}>
        <boxGeometry args={[0.07, tall, 0.012]} />
        <meshStandardMaterial color={palette.ink} />
      </mesh>
      {frac > 0 && (
        <mesh position={[gx, bottom + (tall * frac) / 2, z + Math.sign(z) * -0.004]}>
          <boxGeometry args={[0.05, tall * frac, 0.014]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
        </mesh>
      )}
      <Label position={[gx, bottom + tall + 0.08, z]} center distanceFactor={8} zIndexRange={[10, 0]}>
        <span className="lab-level" title={`${level.count} of ${level.capacity} plates inside`}>
          {level.count}/{level.capacity}
        </span>
      </Label>
    </group>
  )
}

/** A thin box from a to b (world x, z) at height y. */
function Link({ a, b, y, width, height, color }: { a: [number, number]; b: [number, number]; y: number; width: number; height: number; color: string }) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const angle = -Math.atan2(b[1] - a[1], b[0] - a[0])
  return (
    <mesh position={[(a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2]} rotation-y={angle} castShadow>
      <boxGeometry args={[len + width, height, width]} />
      <meshStandardMaterial color={color} />
    </mesh>
  )
}

function Arm({ index, k, color }: { index: number; k: ReturnType<typeof sample>; color: string }) {
  const pose = armPose(k.x, k.side, k.reach)
  const { carriage, railTop, armHeight } = PF400
  const top = railTop + carriage.h
  return (
    <group>
      <mesh position={[k.x, railTop + carriage.h / 2, 0]} castShadow>
        <boxGeometry args={[carriage.w, carriage.h, carriage.d]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.5} />
      </mesh>
      <mesh position={[k.x, (top + armHeight) / 2, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.07, armHeight - top, 24]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <Link a={pose.shoulder} b={pose.elbow} y={armHeight} width={0.09} height={0.06} color={color} />
      <Link a={pose.elbow} b={pose.wrist} y={armHeight + 0.06} width={0.07} height={0.05} color={color} />
      <Link a={pose.wrist} b={pose.plate} y={NEST_H + 0.03} width={0.03} height={0.02} color={color} />
      <Label position={[k.x, armHeight + 0.3, 0]} center distanceFactor={8} zIndexRange={[20, 10]}>
        <span className="lab-label arm">Arm {index + 1}</span>
      </Label>
    </group>
  )
}

function ClashZone({ c, replay, t, color }: { c: Clash; replay: Replay; t: number; color: string }) {
  const [a, b] = c.arms.map((i) => sample(replay.arms[i], t).x)
  const lo = Math.min(a, b)
  const len = Math.max(0.05, Math.abs(b - a))
  return (
    <mesh position={[lo + len / 2, PF400.railTop + 0.2, 0]}>
      <boxGeometry args={[len, 0.4, 0.5]} />
      <meshStandardMaterial color={color} transparent opacity={0.35} depthWrite={false} />
    </mesh>
  )
}

function Plates({ replay, layout, routes, t, palette }: {
  replay: Replay
  layout: ResolvedLayout
  routes: Map<string, Route>
  t: number
  palette: Palette
}) {
  const stacks = new Map<string, number>()
  const out: ReactNode[] = []
  for (const [item, { route, stays }] of replay.plates) {
    const spot = spotAt(stays, t)
    if (!spot) continue
    const r = routes.get(route)
    const color = palette.groups[r?.group ?? ''] ?? palette.fallback
    const puck = /puck|pin|tube/i.test(r?.labware ?? '')
    let pos: [number, number, number]
    if (spot.kind === 'arm') {
      const k = sample(replay.arms[spot.arm], t)
      const p = armPose(k.x, k.side, k.reach).plate
      pos = [p[0], NEST_H + 0.01, p[1]]
    } else {
      const p = layout.at.get(spot.station)
      if (!p) continue
      const n = stacks.get(spot.station) ?? 0
      stacks.set(spot.station, n + 1)
      pos = [p.x, NEST_H + 0.01 + n * (PLATE.h + 0.004), p.side * NEST_OFFSET]
    }
    out.push(
      <mesh key={item} position={pos} castShadow>
        {puck ? <cylinderGeometry args={[0.03, 0.03, 0.03, 16]} /> : <boxGeometry args={[PLATE.w, PLATE.h, PLATE.d]} />}
        <meshStandardMaterial color={color} />
      </mesh>,
    )
  }
  return <>{out}</>
}
