// The room view (contract §4.9 Planner): the photo strip, the floor plan and Align photos. Styles: styles/rooms.css
// (.rm-*). Shown only while a room is open (engine.getRoomState()); a scene opened on its own looks exactly as before.
//   photo strip   numbered thumbnails in member order (room-photo, data-scene, aria-pressed on the current one); a tap,
//                 or keys 1–9, switches photos (a cut); the floor plan's toggle (floor-plan-toggle) at its end; the
//                 one-line note over an unplaced or doubtful photo under it
//   floor plan    a <canvas> (floor-plan): desktop beside the view (right), phone a sheet over the dock. Top-down, the room
//                 frame, +X right, −Z up, a 50 cm grid; each placed photo's dot (its number), its view wedge (1.5 m) and,
//                 on the current one, its turn handle (0.75 m ahead); the furniture's footprints (tap selects, drag
//                 moves, the grip turns); the room's shape: every placed photo's depth.png lifted into the room frame,
//                 points 0.1–2.0 m above the floor, as a faint density map. Wheel or pinch zooms, an empty drag pans,
//                 Fit frames every photo and piece.
//   Align photos  (align-photos, aria-pressed): drag a photo to move it, its handle to turn it; the density map and the
//                 photo view follow live (engine.previewPose); release saves (engine.setPose: pose_source manual). An
//                 unplaced photo is placed by tapping the plan, then turned. Reset (align-reset) puts the photo back to
//                 the solver's answer; Align again asks for a new alignment (manual poses kept).
// It tells the workspace how much of the window it covers (ctx.floorPlan.insets), and gives the hook floorPlanPoint.
import { icon, ring } from './icons.js'
import { quiet, sceneTitle, type UiContext } from './seam.js'
import * as R from '../logic/room.js'
import type { Pose, Xz } from '../logic/room.js'
import type { Camera } from '../logic/camera.js'
import { alignHint, photoHue, photoLabel, photoNote } from './logic/rooms.js'

const DESK_PLAN_W = 360
const PHONE_PLAN_FRACTION = 0.46
const DENSITY_CELL = 0.05
const LIFT_STEP = 3
const STORE_KEY = 'midstudy.floorPlan'

/** A member's depth points in its own (effective) scene frame, and what they were lifted with. */
interface Lifted {
  readonly sig: string
  readonly points: readonly number[]
}
type Drag =
  | { readonly kind: 'pan'; readonly id: number; x: number; y: number; moved: boolean }
  | { readonly kind: 'photo'; readonly id: number; readonly scene: string; readonly from: Xz; readonly pose0: Pose; moved: boolean }
  | { readonly kind: 'handle'; readonly id: number; readonly scene: string; moved: boolean }
  | { readonly kind: 'item'; readonly id: number; readonly uid: string; readonly from: Xz; readonly at0: Xz; moved: boolean }
  | { readonly kind: 'turn'; readonly id: number; readonly uid: string; moved: boolean }

const store = {
  get: (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { engine, shell, kit, keys } = ctx
  const { h } = kit
  const phone = (): boolean => shell.isPhone()
  const inRoom = (): boolean => !!engine.getRoomState()

  // --- the photo strip ---------------------------------------------------------------------------------------------
  const toggle = h('button.rm-plan-toggle', { type: 'button', 'aria-label': 'Floor plan', 'aria-pressed': 'false', dataset: { midstudy: 'floor-plan-toggle', tip: 'Floor plan' }, onclick: () => { show(!shown) } },
    planGlyph(), h('span', 'Plan'))
  const photos = h('div.rm-photos', { role: 'toolbar', 'aria-label': 'Photos of the room' })
  const strip = h('div.rm-strip', { hidden: true }, photos, toggle)
  const note = h('div.rm-note', { hidden: true, role: 'status' })
  shell.mounts.overlays.append(strip, note)

  // --- the floor plan ----------------------------------------------------------------------------------------------
  const canvas = h('canvas.rm-canvas', { dataset: { midstudy: 'floor-plan' }, 'aria-label': 'Floor plan of the room' })
  const alignBtn = h('button.rm-btn', { type: 'button', 'aria-pressed': 'false', dataset: { midstudy: 'align-photos', tip: 'Move and turn the photos by hand' }, onclick: () => { engine.setAlignPhotos(!engine.getRoomState()?.alignPhotos) } }, h('span', 'Align photos'))
  const fitBtn = h('button.rm-btn.is-quiet', { type: 'button', 'aria-label': 'Fit the plan', dataset: { tip: 'Fit every photo and piece' }, onclick: () => { fit(); draw() } }, h('span', 'Fit'))
  const closeBtn = h('button.rm-close', { type: 'button', 'aria-label': 'Close the floor plan', onclick: () => { show(false) } }, icon('close', { size: 16, stroke: 2 }))
  const resetBtn = h('button.rm-btn', { type: 'button', dataset: { midstudy: 'align-reset', tip: "Back to the alignment's answer" }, onclick: () => { quiet(resetSelected()) } }, h('span', 'Reset'))
  const againBtn = h('button.rm-btn.is-quiet', { type: 'button', dataset: { tip: 'Align the photos again (photos you placed by hand stay)' }, onclick: () => { quiet(alignAgain()) } }, h('span', 'Align again'))
  const alignLabel = h('span.rm-align-label')
  const alignRow = h('div.rm-align-row', { hidden: true }, alignLabel, h('span.rm-spacer'), resetBtn, againBtn)
  const hintEl = h('p.rm-hint')
  const status = h('span.rm-status')
  const plan = h('aside.rm-plan', { hidden: true, 'aria-label': 'Floor plan' },
    h('header.rm-plan-head', h('b', 'Floor plan'), status, h('span.rm-spacer'), alignBtn, fitBtn, closeBtn),
    alignRow, h('div.rm-canvas-wrap', canvas), hintEl)
  document.body.append(plan)

  let shown = store.get(STORE_KEY) !== '0' // shown by default in a room view (desktop); remembered per device
  let view: R.PlanView = { s: 60, ox: 180, oy: 180 }
  let fitted = false
  let alignSel: string | null = null // the photo Align photos works on (the last one grabbed, else the current one)
  let drag: Drag | null = null
  const pointers = new Map<number, { x: number; y: number }>()
  let pinch: { d0: number; s0: R.PlanView; cx: number; cy: number } | null = null

  // depth points per member: lifted once per (scene, camera, scale), binned per pose
  const lifted = new Map<string, Lifted>()
  const loading = new Set<string>()
  const sceneInfo = new Map<string, { readonly depthUrl: string | null; readonly calib: unknown; readonly w: number; readonly h: number }>()
  let grid: R.DensityGrid | null = null
  const counts = new Map<string, { readonly key: string; readonly cells: readonly number[] }>()
  let density: HTMLCanvasElement | null = null
  let densityKey = ''

  function show(on: boolean): void {
    shown = on
    store.set(STORE_KEY, on ? '1' : '0')
    if (on && phone() && shell.getOpenPanel()) shell.closePanel()
    sync()
  }
  const visible = (): boolean => inRoom() && shown && !shell.getOpenPage() && !(phone() && !!shell.getOpenPanel())

  // --- the room's members as the plan draws them -------------------------------------------------------------------
  interface PlanMember {
    readonly scene: string
    readonly index: number
    readonly pose: Pose | null
    readonly eff: Camera | null
    readonly aspect: number
    readonly current: boolean
  }
  function members(): PlanMember[] {
    const st = engine.getRoomState()
    if (!st) return []
    const live = engine.getRoom()
    return st.members.map((m, index) => {
      const lm = live?.members[index]
      const so = m.scene_object
      const w = so?.w ?? 4
      const hh = so?.h ?? 3
      return { scene: m.scene, index, pose: m.pose, eff: lm?.effective_camera ?? m.effective_camera, aspect: w && hh ? w / hh : 4 / 3, current: m.scene === st.photo }
    })
  }
  function wedges(ms: readonly PlanMember[]): R.PlanPhoto[] {
    return ms.flatMap((m) => (m.pose && m.eff ? [{ scene: m.scene, wedge: R.wedgeOf(m.pose, m.eff, m.aspect, Math.sqrt), current: m.scene === (alignSel ?? currentScene()) }] : []))
  }
  const currentScene = (): string | null => engine.getRoomState()?.photo ?? null
  function pieces(): (R.PlanPiece & { readonly at: Xz; readonly rot: number; readonly front: Xz })[] {
    return engine.getLayoutItems().flatMap((it) => {
      if (!it.box) return []
      const at: Xz = [it.at.x, it.at.z]
      const corners = R.footprintXz(at, it.at.rot, [it.box.min[0], it.box.min[2]], [it.box.max[0], it.box.max[2]])
      const fr = R.sinCosDeg(it.at.rot)
      const reach = it.box.max[2] + 0.25
      return [{ uid: it.uid, corners, at, rot: it.at.rot, front: [at[0] + fr.s * reach, at[1] + fr.c * reach] }]
    })
  }

  // --- sizes ------------------------------------------------------------------------------------------------------
  function planRect(): { w: number; h: number } {
    const r = canvas.getBoundingClientRect()
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) }
  }
  function sizeCanvas(): void {
    const { w, h: hh } = planRect()
    const k = Math.min(2, window.devicePixelRatio || 1)
    const W = Math.round(w * k), H = Math.round(hh * k)
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
  }
  function fit(): void {
    const { w, h: hh } = planRect()
    const pts: Xz[] = []
    for (const m of members()) if (m.pose) pts.push([m.pose.x_m, m.pose.z_m])
    for (const p of pieces()) pts.push(...p.corners)
    view = R.planFit(R.boxAround(pts, 1.6), w, hh)
    fitted = true
  }

  // --- depth: each member's points lifted through its effective camera, binned through its pose ------------------
  async function sceneOf(scene: string): Promise<{ depthUrl: string | null; calib: unknown; w: number; h: number }> {
    const have = sceneInfo.get(scene)
    if (have) return have
    const res = await fetch(`/api/scenes/${encodeURIComponent(scene)}`)
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
    const d: unknown = await res.json()
    const o = typeof d === 'object' && d !== null ? d : {}
    const depthUrl: unknown = Reflect.get(o, 'depth_url')
    const w: unknown = Reflect.get(o, 'w')
    const hh: unknown = Reflect.get(o, 'h')
    const calib: unknown = Reflect.get(o, 'calib')
    const info = { depthUrl: typeof depthUrl === 'string' ? depthUrl : null, calib, w: typeof w === 'number' ? w : 0, h: typeof hh === 'number' ? hh : 0 }
    sceneInfo.set(scene, info)
    return info
  }
  const liftSig = (m: PlanMember): string => (m.eff ? [m.eff.fov_y_deg, m.eff.height_m, m.eff.pitch_deg, m.eff.roll_deg].join(',') : '')
  function ensureLifted(m: PlanMember): Lifted | null {
    const sig = liftSig(m)
    const have = lifted.get(m.scene)
    if (have?.sig === sig) return have
    if (!m.eff || loading.has(`${m.scene}|${sig}`)) return have ?? null
    const eff = m.eff
    const key = `${m.scene}|${sig}`
    loading.add(key)
    quiet((async () => {
      try {
        const info = await sceneOf(m.scene)
        if (!info.depthUrl) { lifted.set(m.scene, { sig, points: [] }); return }
        const depth = await engine.loadDepthMap(info.depthUrl)
        const points = R.liftDepth(depth, eff, engine.depthScaleFor(info.calib, eff.height_m), LIFT_STEP)
        lifted.set(m.scene, { sig, points })
        counts.delete(m.scene)
        draw()
      } catch (e) { console.warn('[midstudy] no depth for the floor plan:', m.scene, e) } finally { loading.delete(key) }
    })())
    return have ?? null
  }
  function ensureGrid(ms: readonly PlanMember[]): R.DensityGrid {
    const pts: Xz[] = []
    for (const m of ms) if (m.pose) pts.push([m.pose.x_m, m.pose.z_m])
    const box = R.boxAround(pts, 7)
    const g = grid
    if (g && box.minX >= g.x0 && box.minZ >= g.z0 && box.maxX <= g.x0 + g.nx * g.cell && box.maxZ <= g.z0 + g.nz * g.cell) return g
    const next = R.gridOver(R.boxAround(pts, 9), DENSITY_CELL)
    grid = next
    counts.clear()
    return next
  }
  /** The density map as an image (one pixel per cell), remade when a photo's points or pose change. */
  function densityImage(ms: readonly PlanMember[]): { img: HTMLCanvasElement; g: R.DensityGrid } | null {
    const g = ensureGrid(ms)
    const parts: string[] = []
    for (const m of ms) {
      if (!m.pose) continue
      const l = ensureLifted(m)
      if (!l?.points.length) continue
      const key = `${l.sig}|${String(m.pose.x_m)},${String(m.pose.z_m)},${String(m.pose.yaw_deg)}|${String(g.x0)},${String(g.z0)},${String(g.cell)}`
      if (counts.get(m.scene)?.key !== key) counts.set(m.scene, { key, cells: R.cellsOf(l.points, m.pose, g) })
      parts.push(`${m.scene}:${key}`)
    }
    if (!parts.length) return null
    const dk = parts.join(';')
    if (density && dk === densityKey) return { img: density, g }
    const total = new Float32Array(g.nx * g.nz)
    for (const m of ms) {
      const c = m.pose ? counts.get(m.scene) : undefined
      if (!c) continue
      for (const i of c.cells) if (i >= 0) total[i] = (total[i] ?? 0) + 1
    }
    const knee = R.densityKnee([...total])
    const img = density ?? document.createElement('canvas')
    img.width = g.nx
    img.height = g.nz
    const cx = img.getContext('2d')
    if (!cx) return null
    const data = cx.createImageData(g.nx, g.nz)
    for (let i = 0; i < total.length; i++) {
      const a = R.densityAlpha(total[i] ?? 0, knee)
      data.data[i * 4] = 236
      data.data[i * 4 + 1] = 232
      data.data[i * 4 + 2] = 224
      data.data[i * 4 + 3] = Math.round(a * 255)
    }
    cx.putImageData(data, 0, 0)
    density = img
    densityKey = dk
    return { img, g }
  }

  // --- drawing ----------------------------------------------------------------------------------------------------
  let drawQueued = false
  function draw(): void {
    if (drawQueued) return
    drawQueued = true
    requestAnimationFrame(() => { drawQueued = false; paint() })
  }
  function paint(): void {
    if (plan.hidden) return
    sizeCanvas()
    const { w, h: hh } = planRect()
    if (!fitted) fit()
    const g = canvas.getContext('2d')
    if (!g) return
    const k = canvas.width / w
    g.setTransform(k, 0, 0, k, 0, 0)
    g.clearRect(0, 0, w, hh)
    g.fillStyle = '#16171b'
    g.fillRect(0, 0, w, hh)
    const ms = members()
    // the room's shape
    const dm = densityImage(ms)
    if (dm) {
      const [x0, y0] = R.planToCanvas(view, [dm.g.x0, dm.g.z0])
      g.imageSmoothingEnabled = true
      g.drawImage(dm.img, x0, y0, dm.g.nx * dm.g.cell * view.s, dm.g.nz * dm.g.cell * view.s)
    }
    // the 50 cm grid (whole meters a little stronger)
    const lines = R.gridLines(view, w, hh, 0.5)
    g.lineWidth = 1
    for (const x of lines.xs) {
      const cx = Math.round(view.ox + view.s * x) + 0.5
      g.strokeStyle = Math.abs(x - Math.round(x)) < 1e-6 ? '#ffffff1f' : '#ffffff0d'
      g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, hh); g.stroke()
    }
    for (const z of lines.zs) {
      const cy = Math.round(view.oy + view.s * z) + 0.5
      g.strokeStyle = Math.abs(z - Math.round(z)) < 1e-6 ? '#ffffff1f' : '#ffffff0d'
      g.beginPath(); g.moveTo(0, cy); g.lineTo(w, cy); g.stroke()
    }
    // the furniture
    const sel = new Set(engine.getSelection())
    for (const p of pieces()) {
      const pts = p.corners.map((c) => R.planToCanvas(view, c))
      g.beginPath()
      pts.forEach(([x, y], i) => { if (i) g.lineTo(x, y); else g.moveTo(x, y) })
      g.closePath()
      const on = sel.has(p.uid)
      g.fillStyle = on ? '#d9a44155' : '#ece8e026'
      g.strokeStyle = on ? '#d9a441' : '#ece8e0aa'
      g.lineWidth = on ? 2 : 1.25
      g.fill(); g.stroke()
      if (on && !engine.getRoomState()?.alignPhotos) {
        const [fx, fy] = R.planToCanvas(view, p.front)
        g.beginPath(); g.arc(fx, fy, 7, 0, Math.PI * 2)
        g.fillStyle = '#d9a441'; g.fill()
      }
    }
    // the photos: wedge, dot and number; the current one's turn handle
    const align = !!engine.getRoomState()?.alignPhotos
    const cur = currentScene()
    for (const m of ms) {
      if (!m.pose || !m.eff) continue
      const wd = R.wedgeOf(m.pose, m.eff, m.aspect, Math.sqrt)
      const isCur = m.scene === cur
      const isSel = align && m.scene === (alignSel ?? cur)
      const hue = photoHue(m.index)
      const col = isCur ? '217,164,65' : hslRgb(hue)
      const [ax, ay] = R.planToCanvas(view, wd.apex)
      const [lx, ly] = R.planToCanvas(view, wd.left)
      const [rx, ry] = R.planToCanvas(view, wd.right)
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(lx, ly); g.lineTo(rx, ry); g.closePath()
      g.fillStyle = `rgba(${col},${isCur ? '0.22' : '0.12'})`
      g.strokeStyle = `rgba(${col},${isSel || isCur ? '0.95' : '0.55'})`
      g.lineWidth = isSel ? 2 : 1.25
      g.fill(); g.stroke()
      if (isCur || isSel) {
        const [hx, hy] = R.planToCanvas(view, wd.handle)
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(hx, hy)
        g.strokeStyle = `rgba(${col},0.9)`; g.lineWidth = 1.5; g.stroke()
        g.beginPath(); g.arc(hx, hy, align ? 7 : 4.5, 0, Math.PI * 2)
        g.fillStyle = `rgb(${col})`; g.fill()
      }
      g.beginPath(); g.arc(ax, ay, 9, 0, Math.PI * 2)
      g.fillStyle = `rgb(${col})`; g.fill()
      g.fillStyle = '#16130c'
      g.font = '600 11px -apple-system, system-ui, sans-serif'
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(String(m.index + 1), ax, ay + 0.5)
    }
  }
  // --- pointer: pan, zoom, pieces, photos -------------------------------------------------------------------------
  function local(e: PointerEvent | WheelEvent): [number, number] {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const slop = (e: PointerEvent): number => (e.pointerType === 'touch' ? 22 : 10)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const [x, y] = local(e)
    view = R.planZoom(view, Math.exp(-e.deltaY * 0.0015), x, y)
    draw()
  }, { passive: false })
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    canvas.setPointerCapture(e.pointerId)
    const [x, y] = local(e)
    pointers.set(e.pointerId, { x, y })
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      if (a && b) pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), s0: view, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
      drag = null
      return
    }
    const p = R.canvasToPlan(view, x, y)
    const st = engine.getRoomState()
    const align = !!st?.alignPhotos
    const r = slop(e) / view.s
    // the selected piece's turn grip first (outside Align photos)
    if (!align) {
      const selUid = engine.getSelected()
      const sp = selUid ? pieces().find((q) => q.uid === selUid) : undefined
      if (sp && R.dist2(p, sp.front) <= r * r) { drag = { kind: 'turn', id: e.pointerId, uid: sp.uid, moved: false }; return }
    }
    const hit = R.planHit(p, r, wedges(members()), pieces(), align)
    if (hit.kind === 'handle') { drag = { kind: 'handle', id: e.pointerId, scene: hit.scene, moved: false }; return }
    if (hit.kind === 'photo') {
      const m = st?.members.find((q) => q.scene === hit.scene)
      if (m?.pose) { alignSel = hit.scene; drag = { kind: 'photo', id: e.pointerId, scene: hit.scene, from: p, pose0: m.pose, moved: false }; syncAlign(); draw(); return }
    }
    if (hit.kind === 'item') {
      engine.select(hit.uid)
      const pc = pieces().find((q) => q.uid === hit.uid)
      if (pc) drag = { kind: 'item', id: e.pointerId, uid: hit.uid, from: p, at0: pc.at, moved: false }
      draw()
      return
    }
    drag = { kind: 'pan', id: e.pointerId, x, y, moved: false }
  })
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e)
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y })
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      if (a && b) {
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        view = R.planZoom(pinch.s0, pinch.d0 > 0 ? d / pinch.d0 : 1, pinch.cx, pinch.cy)
        view = R.planPan(view, (a.x + b.x) / 2 - pinch.cx, (a.y + b.y) / 2 - pinch.cy)
        draw()
      }
      return
    }
    const d = drag
    if (d?.id !== e.pointerId) return
    const p = R.canvasToPlan(view, x, y)
    d.moved = true
    if (d.kind === 'pan') { view = R.planPan(view, x - d.x, y - d.y); d.x = x; d.y = y; draw(); return }
    if (d.kind === 'photo') {
      engine.previewPose(d.scene, R.movedPose(d.pose0, p[0] - d.from[0], p[1] - d.from[1]))
      draw()
      return
    }
    if (d.kind === 'handle') {
      const m = engine.getRoomState()?.members.find((q) => q.scene === d.scene)
      const yaw = m?.pose ? R.yawToward([m.pose.x_m, m.pose.z_m], p, Math.atan2) : null
      if (yaw !== null) engine.previewPose(d.scene, { yaw_deg: yaw })
      draw()
      return
    }
    if (d.kind === 'item') {
      engine.moveItemHook(d.uid, { position: [d.at0[0] + p[0] - d.from[0], Number.NaN, d.at0[1] + p[1] - d.from[1]] })
      draw()
      return
    }
    const pc = pieces().find((q) => q.uid === d.uid)
    if (pc) {
      // the piece's front (+Z of the item frame) turns toward the pointer; Shift snaps to 15°
      let deg = (Math.atan2(p[0] - pc.at[0], p[1] - pc.at[1]) * 180) / Math.PI
      if (e.shiftKey) deg = Math.round(deg / 15) * 15
      engine.moveItemHook(d.uid, { rotation_y_deg: R.wrapYaw(deg) })
      draw()
    }
  })
  const end = (e: PointerEvent): void => {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    const d = drag
    if (d?.id !== e.pointerId) return
    drag = null
    const st = engine.getRoomState()
    if ((d.kind === 'photo' || d.kind === 'handle') && d.moved) {
      const m = st?.members.find((q) => q.scene === d.scene)
      if (m?.pose) quiet(engine.setPose(d.scene, m.pose))
      return
    }
    if (d.kind === 'pan' && !d.moved) {
      const [x, y] = local(e)
      const p = R.canvasToPlan(view, x, y)
      // Align photos on an unplaced photo: a tap places it there (facing −Z; turn it with its handle)
      const target = alignSel ?? currentScene()
      const m = st?.members.find((q) => q.scene === target)
      if (st?.alignPhotos && m && !m.pose && target) { quiet(engine.setPose(target, { x_m: p[0], z_m: p[1], yaw_deg: 0 })); return }
      if (!st?.alignPhotos) engine.select(null)
    }
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)

  // --- Align photos ------------------------------------------------------------------------------------------------
  function syncAlign(): void {
    const st = engine.getRoomState()
    const on = !!st?.alignPhotos
    alignBtn.setAttribute('aria-pressed', String(on))
    alignRow.hidden = !on
    const target = alignSel ?? st?.photo ?? null
    const m = st?.members.find((q) => q.scene === target)
    const idx = st && m ? st.members.indexOf(m) : -1
    alignLabel.textContent = m ? photoLabel(idx + 1, sceneTitle(m.scene_object ?? { name: m.scene })) : ''
    const hasAlign = !!st?.info.align
    resetBtn.disabled = !m || !hasAlign || m.pose_source === 'origin'
    againBtn.disabled = !st || st.members.length < 2 || st.info.align_status === 'pending' || st.info.align_status === 'running'
    hintEl.textContent = on ? alignHint(!!m?.pose, phone()) : ''
    hintEl.hidden = !on
    const as = st?.info.align_status
    status.replaceChildren(...(as === 'pending' || as === 'running' ? [ring(null, { size: 12 }), document.createTextNode('Aligning…')] : []))
  }
  async function resetSelected(): Promise<void> {
    const target = alignSel ?? currentScene()
    if (!target) return
    try { await engine.resetPose(target) } catch { return }
    shell.toast("Back to the alignment's answer", { kind: 'ok', id: 'align-reset', ms: 2500 })
  }
  async function alignAgain(): Promise<void> {
    try { await engine.alignRoom(null) } catch { return }
    syncAlign()
  }

  // --- the strip and the note --------------------------------------------------------------------------------------
  let stripSig = ''
  function renderStrip(): void {
    const st = engine.getRoomState()
    if (!st) { stripSig = ''; photos.replaceChildren(); return }
    const sig = JSON.stringify([st.name, st.photo, st.members.map((m) => [m.scene, m.scene_object?.thumb_url ?? m.scene_object?.photo_url ?? '', !!m.pose]), phone()])
    if (sig === stripSig) return
    stripSig = sig
    photos.replaceChildren(...st.members.map((m, i) => {
      const src = (m.scene_object?.thumb_url ?? '') || m.scene_object?.photo_url
      const title = sceneTitle(m.scene_object ?? { name: m.scene })
      const on = m.scene === st.photo
      return h(`button.rm-photo${on ? '.is-current' : ''}${m.pose ? '' : '.is-unplaced'}`, {
        type: 'button', 'aria-pressed': String(on), 'aria-label': photoLabel(i + 1, title),
        dataset: { midstudy: 'room-photo', scene: m.scene, tip: `${photoLabel(i + 1, title)}${i < 9 ? ` (${String(i + 1)})` : ''}` },
        onclick: () => { quiet(switchTo(m.scene)) },
      }, src ? h('img', { src, alt: '', draggable: false, loading: 'lazy' }) : h('span.rm-photo-none', icon('image', { size: 16 })), h('span.rm-num', String(i + 1)))
    }))
  }
  function renderNote(): void {
    const st = engine.getRoomState()
    const m = st?.members.find((q) => q.scene === st.photo)
    const unplaced = !!st?.info.align?.unplaced?.includes(m?.scene ?? '')
    const text = m && !engine.getSceneLoad().loading ? photoNote(!!m.pose, m.pose_source, m.confidence, unplaced) : null
    note.hidden = !text
    note.textContent = text ?? ''
  }
  async function switchTo(scene: string): Promise<void> {
    if (scene === currentScene()) return
    if (engine.isSceneDirty()) {
      const ok = await shell.confirm({ title: 'Leave this photo?', icon: 'warning', body: "Its floor (Adjust floor) isn't saved. Switching photos drops the change.", confirm: 'Switch photos' })
      if (!ok) return
    }
    try { await engine.setRoomPhoto(scene) } catch { /* reported */ }
  }
  keys.register({
    id: 'room.photo', group: 'View', label: 'Photo 1–9 of the room', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], display: ['1'], repeat: false,
    when: () => inRoom() && !engine.getAdjustFloor(),
    run: (_e, combo) => {
      const st = engine.getRoomState()
      const scene = st ? R.photoForKey(combo, st.members.map((m) => m.scene)) : null
      if (!scene) return false
      quiet(switchTo(scene))
      return true
    },
  })

  // --- layout: where the strip and the plan sit, and what they cover -------------------------------------------------
  function insets(): { top: number; right: number; bottom: number } {
    if (!inRoom()) return { top: 0, right: 0, bottom: 0 }
    const top = strip.hidden ? 0 : strip.offsetHeight + 8
    if (plan.hidden) return { top, right: 0, bottom: 0 }
    return phone() ? { top, right: 0, bottom: Math.max(0, window.innerHeight - plan.getBoundingClientRect().top) + 8 } : { top, right: DESK_PLAN_W, bottom: 0 }
  }
  function sync(): void {
    const room = inRoom()
    strip.hidden = !room || !!shell.getOpenPage()
    const vis = visible()
    const changed = plan.hidden === vis
    plan.hidden = !vis
    if (engine.getRoomState()?.floorPlan !== vis && room) engine.setFloorPlanShown(vis)
    document.documentElement.dataset['rmPlan'] = vis ? (phone() ? 'phone' : 'desktop') : ''
    document.documentElement.style.setProperty('--rm-plan-h', vis && phone() ? `${String(plan.offsetHeight)}px` : '0px')
    toggle.setAttribute('aria-pressed', String(vis))
    plan.classList.toggle('is-phone', phone())
    plan.style.height = phone() ? `${String(Math.round(window.innerHeight * PHONE_PLAN_FRACTION))}px` : ''
    renderStrip()
    renderNote()
    syncAlign()
    if (!room) { alignSel = null; fitted = false; grid = null; counts.clear(); density = null; densityKey = '' }
    if (changed) { fitted = false; ctx.workspace?.syncStage() }
    if (vis) draw()
  }

  ctx.floorPlan = {
    pointOf: (p: unknown) => {
      if (plan.hidden || !Array.isArray(p)) return null
      const a: readonly unknown[] = p
      const [x, z] = a
      if (typeof x !== 'number' || typeof z !== 'number') return null
      const r = canvas.getBoundingClientRect()
      const [cx, cy] = R.planToCanvas(view, [x, z])
      return { x: r.left + cx, y: r.top + cy }
    },
    show,
    insets,
  }

  engine.events.addEventListener('room', (e) => {
    const ph = e.detail.phase
    if (ph === 'opened') { fitted = false; alignSel = null; lifted.clear(); sceneInfo.clear(); counts.clear(); grid = null; density = null; densityKey = '' }
    if (ph === 'photo') alignSel = null
    if (ph === 'floor-plan') return
    sync()
  })
  engine.events.addEventListener('scene', sync)
  engine.events.addEventListener('items', () => { if (visible()) draw() })
  engine.events.addEventListener('selection', () => { if (visible()) draw() })
  engine.events.addEventListener('camera', () => { if (visible()) draw() })
  shell.events.addEventListener('mode', sync)
  shell.events.addEventListener('page', sync)
  shell.events.addEventListener('panel', sync)
  window.addEventListener('resize', () => { if (visible()) { sync(); draw() } })
  sync()
}

/** "r,g,b" of hsl(hue, 45 %, 62 %): a photo's colour on the plan. */
function hslRgb(hue: number): string {
  const sat = 0.45, light = 0.62
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const hp = (((hue % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = light - c / 2
  return [r, g, b].map((v) => String(Math.round((v + m) * 255))).join(',')
}

function planGlyph(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(ns, 'path')
  p.setAttribute('d', 'M3 3.5h14v13H3zM3 10h6M12 3.5v6M9 10v6.5M12 13h5')
  svg.append(p)
  return svg
}
