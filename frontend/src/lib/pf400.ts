// Approximate geometry of a PreciseFlex 400 (SCARA-type collaborative arm) on a rail carriage, and
// the planar inverse kinematics that place its gripper over a plate nest. Metres and radians.
// The PF400 is quoted with a 588 mm reach; the split into links below is an approximation.
import { NEST_H, NEST_OFFSET } from './lab'

export const PF400 = {
  inner: 0.225, // shoulder to elbow
  outer: 0.21, // elbow to wrist
  gripper: 0.153, // wrist to plate centre
  carriage: { w: 0.35, d: 0.32, h: 0.12 },
  railTop: 0.72, // top of the rail plinth
  armHeight: NEST_H + 0.07, // links run just above the plate
}

export const RETRACTED = 0.12 // plate centre from the column when carried

export interface ArmPose {
  shoulder: [number, number] // (x, z) in world
  elbow: [number, number]
  wrist: [number, number]
  plate: [number, number] // plate centre held by the gripper
}

/** Pose with the gripper pointing across the rail to `side`, plate centre `reach` (0 = retracted,
 *  1 = over the nest) of the way out. The elbow bends towards +x. */
export function armPose(x: number, side: -1 | 1, reach: number): ArmPose {
  const r = RETRACTED + Math.max(0, Math.min(1, reach)) * (NEST_OFFSET - RETRACTED)
  const w = r - PF400.gripper // signed wrist distance from the column, across the rail
  const { inner: a, outer: b } = PF400
  const dist = Math.max(Math.abs(a - b) + 1e-6, Math.min(a + b - 1e-6, Math.abs(w)))
  // Angle at the shoulder between the wrist direction and the inner link (law of cosines).
  const alpha = Math.acos((a * a + dist * dist - b * b) / (2 * a * dist))
  const toWrist = w >= 0 ? side * (Math.PI / 2) : -side * (Math.PI / 2) // direction in the x–z plane, from +x
  const theta = toWrist - side * alpha * Math.sign(w || 1)
  const elbow: [number, number] = [x + a * Math.cos(theta), a * Math.sin(theta)]
  const wrist: [number, number] = [x, side * w]
  return { shoulder: [x, 0], elbow, wrist, plate: [x, side * r] }
}
