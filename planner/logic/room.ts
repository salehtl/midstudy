// Rooms (contract §4.9, docs/ROOMS.md §3.1): several photos of one room in one shared frame, the room frame. A member's
// pose {x_m, z_m, yaw_deg} maps its scene frame into the room frame:
//   p_room  = Ry(yaw) · p_scene + (x_m, 0, z_m)        p_scene = Ry(−yaw) · (p_room − (x_m, 0, z_m))
//   Ry(a)   = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]]   (positive: counterclockwise seen from above, +X turns
//             toward −Z, the sign of rotation_y_deg)
//   an item's rotation_y_deg: scene = room − yaw, room = scene + yaw (both into (−180, 180]); elevation is the same.
// Also: the effective camera (height_m × scale, clamped), the photo's view wedge and turn handle on the floor plan, the
// depth points lifted into a member's frame and binned into the plan's density map, the floor plan's view (room xz ↔
// canvas px) and its hit tests, and the small decisions of the room view (which photo opens, keys 1–9, the PUT bodies).
//
// Pure, for TScert (tscert/README.md): plain arithmetic only. sin and cos are this module's own (sinCosDeg: a Taylor
// series on the angle reduced to ±45°, exact at multiples of 90°), so the transforms need no Math.sin or Math.cos and
// keep the fixed signatures the proofs' differential test imports (sceneToRoom, roomToScene, rotationToScene,
// rotationToRoom; proofs/ models them over ℝ).
import type { Pose as ContractPose } from '../../contract/gen/types.js'
import type { Camera } from './camera.js'

/** The contract's Pose (contract/gen/types.ts, room.schema.json $defs/pose): {x_m, z_m, yaw_deg}. */
export type Pose = ContractPose
export type Vec3 = [number, number, number]
/** A point on the floor, [x, z] in meters. */
export type Xz = readonly [number, number]

const PI = 3.141592653589793

/** sin and cos of one angle. */
export interface SinCos {
  readonly s: number
  readonly c: number
}

/** sin and cos of `deg` degrees: the angle reduced to the nearest multiple of 90° (exactly, in degrees), then a Taylor
 *  series on the rest (|t| ≤ π/4, error below 1e-19 before rounding). Exactly 0 and ±1 at multiples of 90°. NaN for a
 *  number that isn't finite. */
export function sinCosDeg(deg: number): SinCos {
  if (!Number.isFinite(deg)) { const nan = deg - deg; return { s: nan, c: nan } }
  let r = deg % 360
  if (r < 0) r += 360
  const q = Math.round(r / 90)
  const t = ((r - 90 * q) * PI) / 180
  const u = t * t
  const s = t * (1 - (u / 6) * (1 - (u / 20) * (1 - (u / 42) * (1 - (u / 72) * (1 - (u / 110) * (1 - (u / 156) * (1 - (u / 210) * (1 - u / 272))))))))
  const c = 1 - (u / 2) * (1 - (u / 12) * (1 - (u / 30) * (1 - (u / 56) * (1 - (u / 90) * (1 - (u / 132) * (1 - (u / 182) * (1 - (u / 240) * (1 - u / 306))))))))
  const k = q % 4
  if (k === 0) return { s, c }
  if (k === 1) return { s: c, c: -s }
  if (k === 2) return { s: -s, c: -c }
  return { s: -c, c: s }
}

/** Degrees into (−180, 180] (contract §4.9 Ranges: ((a + 180) mod 360) − 180, then −180 becomes 180). */
export function wrapYaw(deg: number): number {
  let y = (((deg + 180) % 360) + 360) % 360 - 180
  if (y === -180) y = 180
  return y
}

/** A scene-frame point in the room frame: Ry(yaw) · p + (x_m, 0, z_m). */
export function sceneToRoom(p: readonly [number, number, number], pose: Pose): [number, number, number] {
  const { s, c } = sinCosDeg(pose.yaw_deg)
  const x = p[0]
  const z = p[2]
  return [c * x + s * z + pose.x_m, p[1], -s * x + c * z + pose.z_m]
}

/** A room-frame point in the scene frame: Ry(−yaw) · (p − (x_m, 0, z_m)). */
export function roomToScene(p: readonly [number, number, number], pose: Pose): [number, number, number] {
  const { s, c } = sinCosDeg(pose.yaw_deg)
  const x = p[0] - pose.x_m
  const z = p[2] - pose.z_m
  return [c * x - s * z, p[1], s * x + c * z]
}

/** An item's rotation_y_deg in the room frame as the scene sees it: room − yaw, into (−180, 180]. */
export function rotationToScene(roomDeg: number, pose: Pose): number {
  return wrapYaw(roomDeg - pose.yaw_deg)
}

/** An item's rotation_y_deg in a scene frame as the room sees it: scene + yaw, into (−180, 180]. */
export function rotationToRoom(sceneDeg: number, pose: Pose): number {
  return wrapYaw(sceneDeg + pose.yaw_deg)
}

/** A pose as every writer stores it: x_m and z_m clamped to −50…50, yaw_deg into (−180, 180]. */
export function clampPose(p: Pose): Pose {
  const m = (v: number): number => Math.min(50, Math.max(-50, v))
  return { x_m: m(p.x_m), z_m: m(p.z_m), yaw_deg: wrapYaw(p.yaw_deg) }
}

/** A member's scale as every writer stores it: 0.25–4 (1 for anything that isn't a positive finite number). */
export function clampScale(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return 1
  return Math.min(4, Math.max(0.25, k))
}

/** The member's effective camera: its scene's camera in use with height_m × scale, clamped to 0.2–3.0 as every camera.
 *  The other three numbers are the scene's. */
export function effectiveCamera(cam: Camera, scale: number): Camera {
  const h = Math.min(3, Math.max(0.2, cam.height_m * clampScale(scale)))
  return { fov_y_deg: cam.fov_y_deg, height_m: h, pitch_deg: cam.pitch_deg, roll_deg: cam.roll_deg }
}

/** Where a placed photo's camera stands in the room frame, and the floor direction it looks along (Ry(yaw)·(0, 0, −1)). */
export interface CameraInRoom {
  readonly position: Vec3
  readonly forward: Xz
}
export function cameraInRoom(pose: Pose, eff: Camera): CameraInRoom {
  const { s, c } = sinCosDeg(pose.yaw_deg)
  return { position: [pose.x_m, eff.height_m, pose.z_m], forward: [-s, -c] }
}

/** tan of half the horizontal field of view of a camera on a photo `aspect` (w / h) wide. */
export function tanHalfHfov(fovYDeg: number, aspect: number): number {
  const { s, c } = sinCosDeg(fovYDeg / 2)
  return (s / c) * aspect
}

/** A photo's view wedge on the floor plan (contract §4.9 Floor plan): the camera's floor point, the two edges of its
 *  horizontal field of view `length` m long (left: counterclockwise of the view direction), and the turn handle 0.75 m
 *  along the view direction. Room frame, [x, z]. `sqrt` comes in from the shell (Math's). */
export interface Wedge {
  readonly apex: Xz
  readonly left: Xz
  readonly right: Xz
  readonly handle: Xz
}
export function wedgeOf(pose: Pose, eff: Camera, aspect: number, sqrt: (v: number) => number, length = 1.5): Wedge {
  const { s, c } = sinCosDeg(pose.yaw_deg)
  const t = tanHalfHfov(eff.fov_y_deg, aspect > 0 ? aspect : 4 / 3)
  // forward f = (−s, −c), right r = Ry(yaw)·(1, 0, 0) = (c, −s); each edge is f ± t·r, scaled to `length`
  const k = length / sqrt(1 + t * t)
  const fx = -s
  const fz = -c
  const rx = c
  const rz = -s
  return {
    apex: [pose.x_m, pose.z_m],
    left: [pose.x_m + k * (fx - t * rx), pose.z_m + k * (fz - t * rz)],
    right: [pose.x_m + k * (fx + t * rx), pose.z_m + k * (fz + t * rz)],
    handle: [pose.x_m + 0.75 * fx, pose.z_m + 0.75 * fz],
  }
}

/** The yaw that turns a photo at `apex` to look at `toward` (the turn handle dragged there), into (−180, 180]; null when
 *  the two are the same point. `atan2` comes in from the shell (Math's). */
export function yawToward(apex: Xz, toward: Xz, atan2: (y: number, x: number) => number): number | null {
  const dx = toward[0] - apex[0]
  const dz = toward[1] - apex[1]
  if (dx === 0 && dz === 0) return null
  // forward = (−sin yaw, −cos yaw): yaw = atan2(−dx, −dz)
  return wrapYaw((atan2(-dx, -dz) * 180) / PI)
}

/** An item's footprint on the floor in the room frame: its local box's floor corners (min/max x and z of the item frame)
 *  turned by its room rotation and placed at its room position. Order: back-left, back-right, front-right, front-left. */
export function footprintXz(position: Xz, rotationDeg: number, min: Xz, max: Xz): Xz[] {
  const { s, c } = sinCosDeg(rotationDeg)
  const at = (lx: number, lz: number): Xz => [position[0] + c * lx + s * lz, position[1] - s * lx + c * lz]
  return [at(min[0], min[1]), at(max[0], min[1]), at(max[0], max[1]), at(min[0], max[1])]
}

/** Whether a floor point is inside a polygon (crossing count; a point on an edge may go either way). */
export function insidePolygon(p: Xz, poly: readonly Xz[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = poly[i]
    const b = poly[j]
    if (a === undefined || b === undefined) continue
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Squared distance between two floor points. */
export function dist2(a: Xz, b: Xz): number {
  const dx = a[0] - b[0]
  const dz = a[1] - b[1]
  return dx * dx + dz * dz
}

/** What a press on the floor plan grabs, nearest first: a turn handle, a photo (its dot or its wedge), a piece. */
export type PlanHit =
  | { readonly kind: 'handle'; readonly scene: string }
  | { readonly kind: 'photo'; readonly scene: string }
  | { readonly kind: 'item'; readonly uid: string }
  | { readonly kind: 'none' }

/** A photo on the plan, as a hit test needs it. */
export interface PlanPhoto {
  readonly scene: string
  readonly wedge: Wedge
  /** only the current photo's turn handle can be grabbed */
  readonly current: boolean
}
/** A piece on the plan, as a hit test needs it. */
export interface PlanPiece {
  readonly uid: string
  readonly corners: readonly Xz[]
}

/** The plan's hit test at a room-frame floor point, `r` the grab radius in meters (the pointer's slop at the plan's
 *  zoom). In Align photos: the current photo's handle, then any photo's dot, then any photo's wedge. Otherwise: pieces
 *  first (the topmost, i.e. the last drawn), then nothing (photos aren't moved outside Align photos). */
export function planHit(p: Xz, r: number, photos: readonly PlanPhoto[], pieces: readonly PlanPiece[], align: boolean): PlanHit {
  const r2 = r * r
  if (align) {
    for (const ph of photos) if (ph.current && dist2(p, ph.wedge.handle) <= r2) return { kind: 'handle', scene: ph.scene }
    for (const ph of photos) if (dist2(p, ph.wedge.apex) <= r2) return { kind: 'photo', scene: ph.scene }
    for (let i = photos.length - 1; i >= 0; i -= 1) {
      const ph = photos[i]
      if (ph !== undefined && insidePolygon(p, [ph.wedge.apex, ph.wedge.left, ph.wedge.right])) return { kind: 'photo', scene: ph.scene }
    }
    return { kind: 'none' }
  }
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const pc = pieces[i]
    if (pc !== undefined && insidePolygon(p, pc.corners)) return { kind: 'item', uid: pc.uid }
  }
  // a small piece is hard to hit at a far zoom: within r of its middle counts too
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const pc = pieces[i]
    if (pc !== undefined && dist2(p, middleOf(pc.corners)) <= r2) return { kind: 'item', uid: pc.uid }
  }
  return { kind: 'none' }
}

/** The middle of a polygon's corners. */
export function middleOf(pts: readonly Xz[]): Xz {
  let x = 0
  let z = 0
  for (const q of pts) { x += q[0]; z += q[1] }
  const n = pts.length > 0 ? pts.length : 1
  return [x / n, z / n]
}

// --- the floor plan's view: room xz ↔ canvas px ----------------------------------------------------------------------

/** canvas px = (ox + s·x, oy + s·z): +X to the right, −Z up (as the first photo looks), s px per meter. */
export interface PlanView {
  readonly s: number
  readonly ox: number
  readonly oy: number
}
/** The plan's zoom range, px per meter. */
export const PLAN_MIN_S = 8
export const PLAN_MAX_S = 600

export function planToCanvas(v: PlanView, p: Xz): Xz {
  return [v.ox + v.s * p[0], v.oy + v.s * p[1]]
}
export function canvasToPlan(v: PlanView, x: number, y: number): Xz {
  return [(x - v.ox) / v.s, (y - v.oy) / v.s]
}

/** A box on the floor: min/max x and z (m). */
export interface FloorBox {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

/** The box around some floor points, at least `pad` m on every side; a 4 m square about the origin without any. */
export function boxAround(pts: readonly Xz[], pad: number): FloorBox {
  if (pts.length === 0) return { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const q of pts) {
    minX = Math.min(minX, q[0])
    maxX = Math.max(maxX, q[0])
    minZ = Math.min(minZ, q[1])
    maxZ = Math.max(maxZ, q[1])
  }
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }
}

/** Fit: the view that shows the whole box, centred, in a w × h px canvas. */
export function planFit(box: FloorBox, w: number, h: number): PlanView {
  const bw = Math.max(0.5, box.maxX - box.minX)
  const bh = Math.max(0.5, box.maxZ - box.minZ)
  const s = Math.min(PLAN_MAX_S, Math.max(PLAN_MIN_S, Math.min(w / bw, h / bh)))
  const cx = (box.minX + box.maxX) / 2
  const cz = (box.minZ + box.maxZ) / 2
  return { s, ox: w / 2 - s * cx, oy: h / 2 - s * cz }
}

/** The view zoomed by `factor` about canvas point (x, y) (that floor point stays under it). */
export function planZoom(v: PlanView, factor: number, x: number, y: number): PlanView {
  const s = Math.min(PLAN_MAX_S, Math.max(PLAN_MIN_S, v.s * factor))
  const k = s / v.s
  return { s, ox: x - (x - v.ox) * k, oy: y - (y - v.oy) * k }
}

/** The view panned by (dx, dy) canvas px. */
export function planPan(v: PlanView, dx: number, dy: number): PlanView {
  return { s: v.s, ox: v.ox + dx, oy: v.oy + dy }
}

/** The 50 cm grid lines inside the canvas: their room coordinates, x for the vertical lines and z for the horizontal
 *  ones (`step` m apart; every whole meter is `major`). */
export interface GridLines {
  readonly xs: readonly number[]
  readonly zs: readonly number[]
}
export function gridLines(v: PlanView, w: number, h: number, step = 0.5): GridLines {
  const a = canvasToPlan(v, 0, 0)
  const b = canvasToPlan(v, w, h)
  const xs: number[] = []
  const zs: number[] = []
  if (!(step > 0) || v.s * step < 3) return { xs, zs }
  for (let i = Math.ceil(a[0] / step); i * step <= b[0] && xs.length < 2000; i += 1) xs.push(i * step)
  for (let j = Math.ceil(a[1] / step); j * step <= b[1] && zs.length < 2000; j += 1) zs.push(j * step)
  return { xs, zs }
}

// --- the room's shape: depth points lifted into a member's frame, binned on the plan ----------------------------------

/** A decoded depth.png (core/js/web.ts decodeDepth): meters along the view axis (contract §4.1's d), 0 = no occluder;
 *  row-major from the top-left. */
export interface DepthLike {
  readonly data: ArrayLike<number>
  readonly width: number
  readonly height: number
}

/** The depth points between `yMin` and `yMax` m above the floor, lifted through the camera `cam` (the member's effective
 *  camera) into its scene frame, as [x0, z0, x1, z1, …]. `scale` multiplies the depth (§4.5 Occlusion: the effective
 *  height over calib.json's, or 1); `step` takes every step-th pixel in both directions. */
export function liftDepth(depth: DepthLike, cam: Camera, scale: number, step: number, yMin = 0.1, yMax = 2): number[] {
  const out: number[] = []
  const w = depth.width
  const hgt = depth.height
  const st = step >= 1 ? Math.floor(step) : 1
  if (!(w > 0) || !(hgt > 0) || !(scale > 0)) return out
  const half = sinCosDeg(cam.fov_y_deg / 2)
  const f = (hgt / 2) * (half.c / half.s)
  const p = sinCosDeg(cam.pitch_deg)
  const r = sinCosDeg(cam.roll_deg)
  const k = scale
  for (let j = 0; j < hgt; j += st) {
    const cy = -((j + 0.5 - hgt / 2) / f)
    for (let i = 0; i < w; i += st) {
      const raw = depth.data[j * w + i]
      if (raw === undefined || !(raw > 0)) continue
      const d = raw * k
      const cx = (i + 0.5 - w / 2) / f
      // camera coordinates (x right, y up, −z ahead) at depth d, then R = Rx(pitch) · Rz(roll), then + (0, h, 0)
      const vx = cx * d
      const vy = cy * d
      const vz = -d
      const ux = r.c * vx - r.s * vy
      const uy = r.s * vx + r.c * vy
      const y = p.c * uy - p.s * vz + cam.height_m
      if (y < yMin || y > yMax) continue
      out.push(ux, p.s * uy + p.c * vz)
    }
  }
  return out
}

/** The plan's density grid: `nx` × `nz` cells of `cell` m, the first one's corner at (x0, z0). */
export interface DensityGrid {
  readonly x0: number
  readonly z0: number
  readonly cell: number
  readonly nx: number
  readonly nz: number
}

/** A grid of `cell` m cells over a floor box (at most `maxCells` per side: the cell grows when the box is large). */
export function gridOver(box: FloorBox, cell: number, maxCells = 400): DensityGrid {
  const w = box.maxX - box.minX
  const h = box.maxZ - box.minZ
  const c = Math.max(cell, w / maxCells, h / maxCells)
  return { x0: box.minX, z0: box.minZ, cell: c, nx: Math.max(1, Math.ceil(w / c)), nz: Math.max(1, Math.ceil(h / c)) }
}

/** Scene-frame points [x0, z0, …] (liftDepth) taken into the room frame through `pose`: the density grid's cell of
 *  each (row-major, z rows), −1 outside the grid. The shell counts them. */
export function cellsOf(points: readonly number[], pose: Pose, g: DensityGrid): number[] {
  const cells: number[] = []
  const { s, c } = sinCosDeg(pose.yaw_deg)
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]
    const z = points[i + 1]
    if (x === undefined || z === undefined) continue
    const rx = c * x + s * z + pose.x_m
    const rz = -s * x + c * z + pose.z_m
    const ci = Math.floor((rx - g.x0) / g.cell)
    const cj = Math.floor((rz - g.z0) / g.cell)
    cells.push(ci < 0 || cj < 0 || ci >= g.nx || cj >= g.nz ? -1 : cj * g.nx + ci)
  }
  return cells
}

/** The density map's opacity for a cell's count: saturating (count / (count + knee)), at most `max`. */
export function densityAlpha(count: number, knee: number, max = 0.85): number {
  if (!(count > 0)) return 0
  const k = knee > 0 ? knee : 1
  return (max * count) / (count + k)
}

/** The knee of the density map: the mean of the cells that have points (so a wall seen by several photos is dark and a
 *  lone stray point faint), at least 1. */
export function densityKnee(counts: readonly number[]): number {
  let sum = 0
  let n = 0
  for (const v of counts) if (v > 0) { sum += v; n += 1 }
  return n > 0 ? Math.max(1, sum / n) : 1
}

// --- the room view's small decisions ------------------------------------------------------------------------------------

/** A member as the room view's decisions read it. */
export interface MemberLite {
  readonly scene: string
  readonly placed: boolean
}

/** Which photo a room opens on (§4.9 Room view): `want` (?photo= or openRoom's) when it is a member; else the photo this
 *  device last had open in the room; else the first placed member; else the first member; null for an empty room. */
export function photoToOpen(members: readonly MemberLite[], want: string | null, last: string | null): string | null {
  const has = (n: string | null): boolean => n !== null && members.some((m) => m.scene === n)
  if (want !== null && has(want)) return want
  if (last !== null && has(last)) return last
  for (const m of members) if (m.placed) return m.scene
  const first = members[0]
  return first === undefined ? null : first.scene
}

/** Keys 1–9 switch to photos 1–9 (§4.9): the member a key names, or null. */
export function photoForKey(key: string, scenes: readonly string[]): string | null {
  if (key.length !== 1 || key < '1' || key > '9') return null
  const i = key.charCodeAt(0) - 49
  return scenes[i] ?? null
}

/** One entry of PUT /api/rooms/<room> `members` (api/room-put.schema.json RoomMemberPut). */
export interface MemberPut {
  readonly scene: string
  readonly pose?: Pose | null
  readonly scale?: number
}

/** The whole member list for a PUT that changes one photo's pose (Align photos, setPose): every member in order, the
 *  changed one with its new pose (and scale when given), the others with nothing (they keep theirs). */
export function membersWithPose(scenes: readonly string[], scene: string, pose: Pose | null, scale: number | null): MemberPut[] {
  const out: MemberPut[] = []
  const p = pose === null ? null : clampPose(pose)
  for (const s of scenes) {
    if (s !== scene) out.push({ scene: s })
    else if (scale === null) out.push({ scene: s, pose: p })
    else out.push({ scene: s, pose: p, scale: clampScale(scale) })
  }
  return out
}

/** The member list with one scene added at the end (Add photo) or taken out (Remove photo). */
export function membersAdding(scenes: readonly string[], scene: string): MemberPut[] {
  const out: MemberPut[] = scenes.map((s) => ({ scene: s }))
  if (!scenes.includes(scene)) out.push({ scene })
  return out
}
export function membersRemoving(scenes: readonly string[], scene: string): MemberPut[] {
  return scenes.filter((s) => s !== scene).map((s) => ({ scene: s }))
}

/** Set scale for the room (§4.9 Set scale): the factor k = true length / measured length, or null when either isn't a
 *  positive finite number or k is 1 (nothing to do). */
export function rescaleFactor(measuredM: number, trueM: number): number | null {
  if (!Number.isFinite(measuredM) || !Number.isFinite(trueM) || measuredM <= 0 || trueM <= 0) return null
  const k = trueM / measuredM
  return k === 1 ? null : k
}

/** A pose moved by a drag on the plan: the photo's position follows the pointer by (dx, dz) from where it was. */
export function movedPose(p: Pose, dx: number, dz: number): Pose {
  return clampPose({ x_m: p.x_m + dx, z_m: p.z_m + dz, yaw_deg: p.yaw_deg })
}

/** Two poses equal to the contract's precision (1e-6 m and degrees). */
export function samePose(a: Pose | null, b: Pose | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a.x_m - b.x_m) < 1e-6 && Math.abs(a.z_m - b.z_m) < 1e-6 && Math.abs(wrapYaw(a.yaw_deg - b.yaw_deg)) < 1e-6
}
