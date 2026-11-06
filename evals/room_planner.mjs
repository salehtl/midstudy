// E19 eval:room-planner — the room view of the planner (contract §4.9 Planner and Hook; docs/ROOMS.md §5 Phase B), in
// headless Chrome on WebGPU and on the WebGL2 fallback (?webgpu=0, no WebGPU flags). Written from the contract only.
// The golden room (living-wide + room-1 … room-6) is uploaded and aligned through the calib mock, so every photo has
// its TRUE pose (truth.json pose_in_room). Then, on the desktop:
// - the hook's room methods (getRoom, roomToScene, sceneToRoom, floorToPhoto/photoToFloor in the room frame, setPose);
// - a magenta sofa probe (the golden sofa's size) placed once at the true sofa's spot in the room frame, from room-2;
// - keys 1–7 switch photos; in every photo getScreenRect matches the true sofa's projection (truth.json corner_px)
//   within 3 px; a render with occlusion off draws it over the sofa's id mask (IoU ≥ 0.95); with occlusion on, the
//   pixels the photo's depth puts in front of it (the table, in the photos where truth says so) show the photo (≥ 95 %);
// - the room layout saves (room frame, room_name) and comes back after a reload;
// - the floor plan: floorPlanPoint (+X right, −Z up, one scale), a drag of the sofa's footprint moves it in the room;
// - Align photos: dragging room-2's wedge moves it (pose_source manual, saved), its turn handle turns it, the photo
//   view follows the new pose, and Reset puts the solver's pose back;
// - a phone pass at 375 × 812 (strip taps, the floor plan sheet, 44 px targets, no sideways scroll).
// The WebGL2 pass repeats the projection, a render and occlusion on two photos. Expectations come from this eval's own
// §4.1/§4.9 code (evals/lib/harness.mjs, evals/lib/rooms.mjs) and truth.json, never from the planner.
// Usage: node evals/room_planner.mjs [--webgpu-only | --webgl-only]   (or npm run eval:room-planner). Output: evals/out/room-planner/.
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, createEval, startServer, api, project, hook, hookAll, control, sleep, fmt, clip, smallTargets, horizontalScroll, waitFor, itemOf, extents,
} from './lib/harness.mjs'
import {
  ROOM_IDS, SOFA_PROBE, goldenRoom, roomSofa, roomToScene, sceneToRoom, rotRoomToScene, boxCornersOriented, rectOf, rectDiff, sofaFullyInPhoto,
  guardRooms, writeRoomLibrary, seedGoldenScenes, waitJob, memberOf, poseEq, poseErr, yawDiff, viewDir, launchBackend, openRoomPage, waitPhoto,
  roomState, fmtPose, contractClient,
} from './lib/rooms.mjs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const PASSES = args.includes('--webgl-only') ? ['webgl'] : args.includes('--webgpu-only') ? ['webgpu'] : ['webgpu', 'webgl']
const ev = createEval('E19', 'room-planner', { timeoutS: 1500 })
guardRooms(ev)
const ROOMS = path.join(ev.out, 'data', 'rooms')
fs.mkdirSync(path.dirname(ROOMS), { recursive: true })
const GR = goldenRoom()
const byId = Object.fromEntries(GR.map((m) => [m.id, m]))
const SOFA = roomSofa()
const SOFA_CORNERS = boxCornersOriented(SOFA.center, SOFA.size, SOFA.rotation_y_deg)
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})
const py = (argv) => {
  try { return JSON.parse(execFileSync(path.join(REPO, 'evals/py'), [path.join(REPO, 'evals/lib/room_images.py'), ...argv], { cwd: REPO, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim().split('\n').at(-1)) } catch (e) { return { error: clip(`${e.stderr || ''}${e.message || e}`, 400) } }
}
// The sofa in a photo's own frame, as an oriented box for room_images.py.
const obbIn = (m, pose = m.pose) => JSON.stringify({ center: roomToScene(pose, SOFA.center), size: [SOFA.size.w, SOFA.size.h, SOFA.size.d], rotation_y_deg: rotRoomToScene(pose, SOFA.rotation_y_deg) })
// The sofa's projected rect in a photo through a pose: {rect (unclipped), clipped, inFront}.
function sofaRect(m, pose = m.pose) {
  const ps = SOFA_CORNERS.map((c) => project(m.cam, m.W, m.H, roomToScene(pose, c)))
  const rect = rectOf(ps.map((p) => [p.px, p.py]))
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y), x1 = Math.min(m.W, rect.x + rect.w), y1 = Math.min(m.H, rect.y + rect.h)
  return { rect, clipped: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, inFront: ps.every((p) => p.d > 0.05), inside: ps.every((p) => p.px >= 0 && p.px <= m.W && p.py >= 0 && p.py <= m.H) }
}
// getScreenRect against the truth: exact when the whole sofa is in the photo; otherwise the unclipped or the clipped
// projection (the contract says "projected bounds in photo pixels" and doesn't say whether it clips).
function judgeRect(got, exp) {
  if (!got) return { ok: false, d: Infinity, how: 'null' }
  if (exp.inside) { const d = rectDiff(got, exp.rect); return { ok: d <= 3, d, how: 'whole sofa in the photo' } }
  const d1 = rectDiff(got, exp.rect), d2 = rectDiff(got, exp.clipped)
  return { ok: Math.min(d1, d2) <= 3, d: Math.min(d1, d2), how: d1 <= d2 ? 'unclipped projection' : 'clipped to the photo' }
}
// Which photos the sofa shows in (all but room-6, where it is behind the camera), and where the photo's depth hides some
// of it (≥ 2000 pixels clearly in front of it: the table, in the photos where truth says so).
const plan = {}
for (const m of GR) {
  const r = sofaRect(m)
  const cl = r.inFront ? py(['obb-classify', '--photo', m.photo, '--camera', JSON.stringify(m.cam), '--obb', obbIn(m), '--depth', m.depth]) : { n_inside: 0, n_hidden: 0 }
  plan[m.id] = { ...r, shows: r.inFront && cl.n_inside > 5000, hides: cl.n_hidden >= 2000, cl }
}
ev.check('(harness) the true poses carry the room\'s sofa onto each photo\'s truth corner_px (≤ 0.01 px)', GR.every((m) => {
  if (!plan[m.id].inFront) return true
  return SOFA_CORNERS.every((c, i) => { const p = project(m.cam, m.W, m.H, roomToScene(m.pose, c)); const t = m.truth.objects.sofa.corner_px[i]; return Math.hypot(p.px - t[0], p.py - t[1]) < 0.01 })
}), fmt(Object.fromEntries(GR.map((m) => [m.id, { shows: plan[m.id].shows, hides: plan[m.id].hides, hidden_px: plan[m.id].cl.n_hidden }]))))

// --- server, scenes, the room ---------------------------------------------------------------------------------------------------
let srv = await startServer(ev, { library: 'rooms', args: ['--rooms-dir', ROOMS] })
ev.check('the server starts with --rooms-dir (calib stub + MIDSTUDY_CALIB_MOCK, a library with the sofa probe)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) {
  ev.note('retrying without --rooms-dir, so the checks below show what is missing')
  srv = await startServer(ev, { library: 'rooms' })
  if (!srv.up) { ev.check('the server starts without --rooms-dir', false, srv.why); await ev.finish() }
}
writeRoomLibrary(srv.dirs.library)
const B = srv.base
const C = contractClient(B)
const seeds = await seedGoldenScenes(srv, ROOM_IDS)
const S = Object.fromEntries(ROOM_IDS.map((id) => [id, seeds[id].name]))
ev.check('the seven golden room photos calibrate with their true cameras and depth (stub + mock)', ROOM_IDS.every((id) => seeds[id].name && !seeds[id].why && seeds[id].scene?.depth_url), fmt(Object.fromEntries(ROOM_IDS.map((id) => [id, seeds[id].why || 'ok']))))
let r = await C.send('POST', '/api/rooms', { title: 'Golden room', scenes: ROOM_IDS.map((id) => S[id]) })
const ROOM = r.json?.name || 'room-missing'
ev.check('POST /api/rooms with the seven photos (living-wide first) → 201', r.status === 201 && !!r.json?.name, `${r.status} ${clip(r.text, 200)}`)
r = await C.send('POST', `/api/rooms/${ROOM}/align`)
const job = r.json?.job?.id ? await waitJob(B, r.json.job.id) : null
let detail = (await C.get(`/api/rooms/${ROOM}`)).json
const poseOk = (id) => poseEq(memberOf(detail, S[id])?.pose, byId[id].pose, 1e-6, 1e-6)
ev.check('the align job (calib mock: golden-room) gives every photo its TRUE pose (1e-6), solver (living-wide origin), scale 1',
  job?.status === 'done' && ROOM_IDS.every(poseOk) && ROOM_IDS.slice(1).every((id) => memberOf(detail, S[id])?.pose_source === 'solver') && memberOf(detail, S['living-wide'])?.pose_source === 'origin' && detail?.members?.every((m) => m.scale === 1),
  `${job?.status || r.status} ${fmt(detail?.members?.map((m) => [m.pose_source, fmtPose(m.pose)]))}`)
const sceneOf = (id) => S[id]
const idOfScene = Object.fromEntries(ROOM_IDS.map((id) => [S[id], id]))

const HOOKS = ['listRooms', 'createRoom', 'waitForRoom', 'openRoom', 'setRoomPhoto', 'getRoom', 'setPose', 'roomToScene', 'sceneToRoom', 'floorPlanPoint']
const errorsOk = (P, tag) => {
  ev.check(`${tag}: no page errors`, P.errors.page.length === 0, P.errors.page.slice(0, 3).join(' | ') || 'none')
  ev.check(`${tag}: no console errors`, P.errors.console.length === 0, P.errors.console.slice(0, 3).join(' | ') || 'none')
  ev.check(`${tag}: no refused (403) requests`, P.errors.refused.length === 0, P.errors.refused.slice(0, 3).join(' | ') || 'none')
}
let photoWait = 30000 // shortened when the room hook isn't there, so a missing feature fails fast
const switchKey = async (page, i) => { await page.keyboard.press(String(i + 1)); return waitPhoto(page, sceneOf(ROOM_IDS[i]), photoWait) }
const pressed = (page, scene) => page.evaluate((scene) => [...document.querySelectorAll('[data-midstudy="room-photo"]')].map((el) => ({ scene: el.dataset.scene, on: el.getAttribute('aria-pressed') === 'true' })), scene).catch(() => [])
const rectNow = async (page, uid) => (await hook(page, 'getScreenRect', [uid])).value ?? null
// Renders the current photo and returns the composite's path (renderView in mock mode writes <render>-input.jpg).
const render = async (page) => {
  const m = await hook(page, 'renderView', [{ model: 'nano-banana' }], 180000)
  const input = m.value?.name ? path.join(srv.dirs.renders, `${m.value.name}-input.jpg`) : ''
  return { meta: m.value, error: m.error, input: input && fs.existsSync(input) ? input : '' }
}
const judgeIds = (m, input, tag) => py(['ids-overlap', '--composite', input, '--ids', path.join(m.dir, 'ids.png'), '--debug', path.join(ev.out, `ids-${tag}.png`)])
const judgeOcc = (m, input, tag, pose = m.pose) => py(['obb-occlusion', '--composite', input, '--photo', m.photo, '--camera', JSON.stringify(m.cam), '--obb', obbIn(m, pose), '--depth', m.depth, '--debug', path.join(ev.out, `occ-${tag}.png`)])
const pct = (v) => (v == null ? 'n/a' : `${(100 * v).toFixed(1)} %`)

// ======================================================================================================================================
async function desktopPass(browser, backend) {
  const T = backend
  const full = backend === 'webgpu'
  ev.section(`${T}: the room view (desktop 1280 × 800${full ? '' : ', ?webgpu=0'})`)
  const startPhoto = full ? 'room-2' : 'room-1'
  const P = await openRoomPage(browser, B, { room: ROOM, photo: sceneOf(startPhoto), webgpu: backend === 'webgpu' })
  ev.check(`${T}: the planner opens ?room=<room>&photo=<${startPhoto}>`, P.hookOk, P.why || P.url)
  const { page } = P
  const missing = await page.evaluate((names) => names.filter((n) => typeof window.midstudy?.[n] !== 'function'), HOOKS).catch(() => HOOKS)
  ev.check(`${T}: the room hook methods exist (§4.9 Hook)`, missing.length === 0, missing.length ? `hook missing: ${missing.join(', ')}` : 'all there')
  photoWait = missing.length ? 3000 : 30000
  let st = await roomState(page)
  if (st?.room?.name !== ROOM) { const o = await hook(page, 'openRoom', [ROOM, sceneOf(startPhoto)], 90000); st = await roomState(page); if (o.error) ev.note(`openRoom: ${o.error}`) }
  ev.check(`${T}: getState().room = {name, photo: <${startPhoto}>}, getState().scene is that photo's scene`, st?.room?.name === ROOM && st?.room?.photo === sceneOf(startPhoto) && st?.scene?.name === sceneOf(startPhoto), fmt({ room: st?.room, scene: st?.scene?.name }))
  await shot(page, `${T}-open`)

  if (full) {
    ev.section(`${T}: the hook in a room view`)
    const gr = (await hook(page, 'getRoom')).value
    const okMembers = gr?.members?.length === 7 && ROOM_IDS.every((id, i) => {
      const m = gr.members[i]
      return m?.scene === S[id] && poseEq(m.pose, byId[id].pose, 1e-6, 1e-6) && m.scale === 1 && Math.abs(m.effective_camera?.height_m - byId[id].cam.height_m) < 1e-9 && Math.abs(m.camera?.pitch_deg - byId[id].cam.pitch_deg) < 1e-9
    })
    ev.check(`${T}: getRoom(): name, photo, the seven members in order with their true poses, scale 1, camera and effective camera`, gr?.name === ROOM && gr?.photo === sceneOf(startPhoto) && okMembers,
      gr ? fmt({ name: gr.name, photo: gr.photo, members: gr.members?.map((m) => [m.scene === S[idOfScene[m.scene]] ? idOfScene[m.scene] : m.scene, fmtPose(m.pose), m.scale, m.effective_camera?.height_m]) }) : 'getRoom() missing or null')
    const pts = [[0.3, 0, -2.1], [-1.2, 0.8, -3.4], [2.5, 1.3, 0.7]]
    let worst = 0, err = ''
    for (const id of ROOM_IDS) {
      const a = await hookAll(page, 'roomToScene', pts.map((p) => [p, S[id]]))
      const b = await hookAll(page, 'sceneToRoom', pts.map((p) => [p, S[id]]))
      if (a.error || b.error) { err = a.error || b.error; break }
      pts.forEach((p, i) => {
        const e1 = roomToScene(byId[id].pose, p), e2 = sceneToRoom(byId[id].pose, p)
        worst = Math.max(worst, ...[0, 1, 2].map((k) => Math.abs(a.value[i][k] - e1[k])), ...[0, 1, 2].map((k) => Math.abs(b.value[i][k] - e2[k])))
      })
    }
    ev.check(`${T}: roomToScene / sceneToRoom (with a scene) are §4.9's maps for every member (1e-6 m)`, !err && worst < 1e-6, err || `worst ${worst.toExponential(2)} m`)
    const cur = byId[startPhoto]
    const ftp = await hookAll(page, 'floorToPhoto', SOFA_CORNERS.map((c) => [c]))
    const dpx = ftp.value ? Math.max(...ftp.value.map((q, i) => Math.hypot(q[0] - cur.truth.objects.sofa.corner_px[i][0], q[1] - cur.truth.objects.sofa.corner_px[i][1]))) : Infinity
    ev.check(`${T}: floorToPhoto takes room-frame points into the current photo (the sofa's room corners land on ${startPhoto}'s corner_px, ≤ 3 px)`, dpx <= 3, ftp.error || `max ${dpx.toFixed(2)} px`)
    const fps = cur.truth.floor_points.slice(0, 8)
    const ptf = await hookAll(page, 'photoToFloor', fps.map((f) => [f.px[0], f.px[1]]))
    const dm = ptf.value ? Math.max(...ptf.value.map((q, i) => (q ? Math.hypot(q[0] - sceneToRoom(cur.pose, fps[i].world)[0], q[2] - sceneToRoom(cur.pose, fps[i].world)[2]) : Infinity))) : Infinity
    ev.check(`${T}: photoToFloor gives room-frame floor points (${startPhoto}'s floor_points through its pose, ≤ 1 cm)`, dm <= 0.01, ptf.error || `max ${(100 * dm).toFixed(2)} cm`)
  }

  // --- the sofa probe -------------------------------------------------------------------------------------------------------------------
  ev.section(`${T}: the sofa probe at the true sofa's spot`)
  st = await roomState(page)
  let uid = st?.items?.find((i) => i.id === SOFA_PROBE.id)?.uid
  if (full) {
    if (uid) await hook(page, 'removeItem', [uid])
    const add = await hook(page, 'addItem', [SOFA_PROBE.id, { position: SOFA.center, rotation_y_deg: SOFA.rotation_y_deg }])
    uid = add.value
    const it = itemOf(await roomState(page), uid)
    ev.check(`${T}: addItem from ${startPhoto} with a room-frame position: getState().items keeps it in the room frame (1 mm, 0.1°)`, it && Math.hypot(it.position[0] - SOFA.center[0], it.position[2] - SOFA.center[2]) < 0.001 && it.position[1] === 0 && yawDiff(it.rotation_y_deg, SOFA.rotation_y_deg) < 0.1,
      add.error || fmt(it && { position: it.position, rotation_y_deg: it.rotation_y_deg }))
    const ext = extents(it?.worldBounds), eExt = [0, 1, 2].map((k) => Math.max(...SOFA_CORNERS.map((c) => c[k])) - Math.min(...SOFA_CORNERS.map((c) => c[k])))
    ev.check(`${T}: its worldBounds are the turned sofa box's in the room frame (±2 %)`, ext && ext.every((v, k) => Math.abs(v / eExt[k] - 1) <= 0.02), fmt({ got: ext, want: eExt }))
  } else {
    ev.check(`${T}: a new device opens the room with its latest layout (the sofa probe, room frame, 1 mm)`, !!uid && Math.hypot(itemOf(st, uid).position[0] - SOFA.center[0], itemOf(st, uid).position[2] - SOFA.center[2]) < 0.001, fmt({ layout: st?.layout, items: st?.items?.map((i) => [i.id, i.position]) }))
  }

  // --- every photo -------------------------------------------------------------------------------------------------------------------
  ev.section(`${T}: switching photos with keys; the sofa in every photo`)
  const order = full ? ROOM_IDS.map((_, i) => i) : [0, 1, 2]
  for (const i of order) {
    const id = ROOM_IDS[i], m = byId[id]
    const ok = await switchKey(page, i)
    const strip = await pressed(page, S[id])
    ev.check(`${T}: key ${i + 1} shows photo ${i + 1} (${id}); its strip thumbnail is aria-pressed, the others not`, ok && strip.length === 7 && strip.every((s) => s.on === (s.scene === S[id])),
      `${ok ? 'switched' : `still ${fmt((await roomState(page))?.room?.photo)}`}; strip ${fmt(strip.map((s) => (s.on ? `[${idOfScene[s.scene] || s.scene}]` : idOfScene[s.scene] || s.scene)))}`)
    const it = itemOf(await roomState(page), uid)
    const rect = await rectNow(page, uid)
    if (!plan[id].inFront) {
      ev.check(`${T}: ${id}: the sofa is behind this camera, so it isn't drawn (getScreenRect null or off the photo)`, ok && it && (!rect || rect.x > m.W || rect.y > m.H || rect.x + rect.w < 0 || rect.y + rect.h < 0 || rect.w * rect.h === 0), fmt(rect))
      continue
    }
    const j = judgeRect(rect, plan[id])
    ev.check(`${T}: ${id}: getScreenRect matches the true sofa's projection within 3 px (${j.how})`, j.ok && it && Math.hypot(it.position[0] - SOFA.center[0], it.position[2] - SOFA.center[2]) < 0.001,
      `rect ${fmt(rect)} want ${fmt(plan[id].inside ? plan[id].rect : { unclipped: plan[id].rect, clipped: plan[id].clipped })}, off by ${j.d.toFixed(2)} px; position ${fmt(it?.position)}`)
    if (!plan[id].shows || (!full && i === 2)) continue
    await hook(page, 'setOcclusion', [false])
    await sleep(300)
    const off = await render(page)
    const ov = off.input ? judgeIds(m, off.input, `${T}-${id}`) : { error: off.error || 'no composite' }
    if (full && i === 1) ev.check(`${T}: renderView in a room view captures that photo: meta scene = the photo, room = the room`, off.meta?.scene === S[id] && off.meta?.room === ROOM, fmt(off.meta && { scene: off.meta.scene, room: off.meta.room, layout: off.meta.layout }))
    ev.check(`${T}: ${id}: occlusion off, the probe covers the sofa's id mask (IoU ≥ 0.95; the composite at the photo's size)`, ov.iou >= 0.95 && fmt(ov.composite_size) === fmt([m.W, m.H]),
      ov.error || fmt({ iou: ov.iou, precision: ov.precision, recall: ov.recall, size: ov.composite_size }))
    if (plan[id].hides) {
      await hook(page, 'setOcclusion', [true])
      await sleep(300)
      const on = await render(page)
      const oc = on.input ? judgeOcc(m, on.input, `${T}-${id}`) : { error: on.error || 'no composite' }
      ev.check(`${T}: ${id}: occlusion on, what the photo's depth puts in front of the sofa (the table) hides it (≥ 95 % of ${plan[id].cl.n_hidden} px match the photo)`, oc.hidden_match >= 0.95 && oc.n_hidden >= 2000,
        oc.error || `${pct(oc.hidden_match)} match, ${pct(oc.hidden_magenta)} show the probe (${oc.n_hidden} px)`)
    }
    await hook(page, 'setOcclusion', [true])
  }
  await shot(page, `${T}-photos`)
  if (!full) { errorsOk(P, T); await P.context.close(); return }

  // --- layouts --------------------------------------------------------------------------------------------------------------------
  ev.section(`${T}: the room layout`)
  const sv = await hook(page, 'saveLayout', ['golden', { title: 'Golden' }])
  r = await C.get(`/api/layouts/golden?room=${ROOM}`)
  const li = r.json?.items?.find((i) => i.id === SOFA_PROBE.id)
  ev.check(`${T}: saveLayout() writes a room layout (?room=): room_name, the sofa in the room frame (1 mm, 0.1°)`, !sv.error && r.status === 200 && r.json?.room_name === ROOM && li && Math.hypot(li.position[0] - SOFA.center[0], li.position[2] - SOFA.center[2]) < 0.001 && yawDiff(li.rotation_y_deg, SOFA.rotation_y_deg) < 0.1,
    sv.error || `${r.status} ${fmt(li)}`)
  const ll = await hook(page, 'listLayouts')
  ev.check(`${T}: listLayouts() lists room layouts in a room view`, (ll.value || []).includes('golden'), ll.error || fmt(ll.value))
  await setPhoto(page, 'room-2')
  await page.reload({ waitUntil: 'load' }).catch(() => {})
  await page.waitForFunction(() => !!window.midstudy, null, { timeout: 30000 }).catch(() => {})
  await page.evaluate(() => window.midstudy?.ready).catch(() => {})
  await sleep(500)
  st = await roomState(page)
  const back = st?.items?.find((i) => i.id === SOFA_PROBE.id)
  uid = back?.uid || uid
  ev.check(`${T}: after a reload the room reopens with its layout (the sofa at its room position, 1 mm)`, st?.room?.name === ROOM && st?.layout === 'golden' && back && Math.hypot(back.position[0] - SOFA.center[0], back.position[2] - SOFA.center[2]) < 0.001,
    fmt({ room: st?.room?.name, layout: st?.layout, item: back?.position }))

  // --- the floor plan -------------------------------------------------------------------------------------------------------------
  ev.section(`${T}: the floor plan`)
  st = await roomState(page)
  if (!st?.room?.floorPlan) {
    const t = await control(page, 'floor-plan-toggle', [/floor plan/i, /plan/i])
    if (t.loc) await t.loc.click().catch(() => {})
    await sleep(400)
  }
  st = await roomState(page)
  const canvas = await page.locator('[data-midstudy="floor-plan"]').first().boundingBox().catch(() => null)
  ev.check(`${T}: the floor plan is shown (floor-plan-toggle; getState().room.floorPlan; a visible [data-midstudy=floor-plan] canvas)`, st?.room?.floorPlan === true && canvas && canvas.width > 100 && canvas.height > 100, fmt({ floorPlan: st?.room?.floorPlan, canvas }))
  const fpp = async (x, z) => (await hook(page, 'floorPlanPoint', [[x, z]])).value ?? null
  const [sx, , sz] = SOFA.center
  const p0 = await fpp(sx, sz), px1 = await fpp(sx + 1, sz), pz1 = await fpp(sx, sz - 1)
  const inside = (p) => p && canvas && p.x >= canvas.x && p.x <= canvas.x + canvas.width && p.y >= canvas.y && p.y <= canvas.y + canvas.height
  ev.check(`${T}: floorPlanPoint: the sofa is on the plan; +X goes right and −Z goes up, at one scale`, inside(p0) && px1 && pz1 && px1.x > p0.x + 5 && Math.abs(px1.y - p0.y) < 1 && pz1.y < p0.y - 5 && Math.abs(pz1.x - p0.x) < 1 && Math.abs((px1.x - p0.x) / (p0.y - pz1.y) - 1) < 0.02,
    fmt({ p0, px1, pz1, canvas }))
  await hook(page, 'selectItem', [uid])
  if (p0) {
    const to = await fpp(sx + 0.5, sz)
    await page.mouse.move(p0.x, p0.y)
    await page.mouse.down()
    for (let k = 1; k <= 10; k++) { await page.mouse.move(p0.x + ((to.x - p0.x) * k) / 10, p0.y + ((to.y - p0.y) * k) / 10); await sleep(16) }
    await page.mouse.up()
    await sleep(400)
  }
  let it = itemOf(await roomState(page), uid)
  ev.check(`${T}: dragging the sofa's footprint on the plan 0.5 m along +X moves it there in the room (±5 cm), turn and height kept`, it && Math.abs(it.position[0] - (sx + 0.5)) <= 0.05 && Math.abs(it.position[2] - sz) <= 0.05 && it.position[1] === 0 && yawDiff(it.rotation_y_deg, SOFA.rotation_y_deg) < 0.1,
    fmt(it && { position: it.position, rotation_y_deg: it.rotation_y_deg }))
  await hook(page, 'moveItem', [uid, { position: SOFA.center, rotation_y_deg: SOFA.rotation_y_deg }])
  await shot(page, `${T}-floor-plan`)

  // --- Align photos ----------------------------------------------------------------------------------------------------------------
  ev.section(`${T}: Align photos`)
  const tog = await control(page, 'align-photos', [/align photos/i])
  if (tog.loc) await tog.loc.click().catch(() => {})
  await sleep(300)
  st = await roomState(page)
  const ap = tog.loc ? await tog.loc.getAttribute('aria-pressed').catch(() => null) : null
  ev.check(`${T}: the Align photos toggle (align-photos) turns it on: aria-pressed, getState().room.alignPhotos`, !!tog.loc && ap === 'true' && st?.room?.alignPhotos === true, `${tog.how}; aria-pressed ${ap}; ${fmt(st?.room)}`)
  await setPhoto(page, 'room-2')
  const m2 = byId['room-2'], P2 = m2.pose
  const dir = viewDir(P2.yaw_deg)
  const grab = [P2.x_m + 0.4 * dir[0], P2.z_m + 0.4 * dir[1]]
  const g0 = await fpp(...grab), g1 = await fpp(grab[0] + 0.3, grab[1])
  if (g0 && g1) {
    await page.mouse.move(g0.x, g0.y); await page.mouse.down()
    for (let k = 1; k <= 12; k++) { await page.mouse.move(g0.x + ((g1.x - g0.x) * k) / 12, g0.y + ((g1.y - g0.y) * k) / 12); await sleep(16) }
    await page.mouse.up()
  }
  const moved = { x_m: P2.x_m + 0.3, z_m: P2.z_m, yaw_deg: P2.yaw_deg }
  let srvM = await waitFor(async () => { const d = (await C.get(`/api/rooms/${ROOM}`)).json; const mm = memberOf(d, S['room-2']); return mm?.pose_source === 'manual' ? mm : null }, { timeoutMs: photoWait > 3000 ? 8000 : 1500 })
  let e = poseErr(srvM?.pose, moved)
  ev.check(`${T}: dragging room-2's wedge 0.3 m along +X moves the photo (±3 cm, yaw ±0.5°) and saves it: pose_source manual (PUT members)`, srvM && e.pos_m <= 0.03 && e.yaw_deg <= 0.5, `server ${fmt(srvM && { pose: srvM.pose, pose_source: srvM.pose_source })} want ${fmtPose(moved)}`)
  const grM = (await hook(page, 'getRoom')).value?.members?.find((m) => m.scene === S['room-2'])
  ev.check(`${T}: getRoom() shows the saved pose`, grM && srvM && poseEq(grM.pose, srvM.pose, 1e-6, 1e-6) && grM.pose_source === 'manual', fmt(grM))
  it = itemOf(await roomState(page), uid)
  ev.check(`${T}: moving a photo doesn't move the furniture in the room frame`, it && Math.hypot(it.position[0] - SOFA.center[0], it.position[2] - SOFA.center[2]) < 0.001, fmt(it?.position))
  if (srvM?.pose) {
    await sleep(300)
    const exp = sofaRect(m2, srvM.pose), got = await rectNow(page, uid), j = judgeRect(got, exp)
    ev.check(`${T}: the photo view follows the new pose (getScreenRect = the sofa through room-2's moved pose, 3 px)`, j.ok, `rect ${fmt(got)} want ${fmt(exp.rect)} (${j.d.toFixed(2)} px)`)
  }
  if (srvM?.pose) {
    const Q = srvM.pose
    const handle = (yaw) => { const v = viewDir(yaw); return [Q.x_m + 0.75 * v[0], Q.z_m + 0.75 * v[1]] }
    const h0 = await fpp(...handle(Q.yaw_deg))
    if (h0) {
      await page.mouse.move(h0.x, h0.y); await page.mouse.down()
      for (let k = 1; k <= 10; k++) { const p = await fpp(...handle(Q.yaw_deg + 2 * k)); if (p) await page.mouse.move(p.x, p.y); await sleep(16) }
      await page.mouse.up()
    }
    const turned = await waitFor(async () => { const mm = memberOf((await C.get(`/api/rooms/${ROOM}`)).json, S['room-2']); return mm && yawDiff(mm.pose?.yaw_deg ?? 0, Q.yaw_deg) > 5 ? mm : null }, { timeoutMs: photoWait > 3000 ? 8000 : 1500 })
    ev.check(`${T}: dragging room-2's turn handle (0.75 m along its view) 20° around it turns the photo (yaw ±2°, position ±2 cm), manual`, turned && yawDiff(turned.pose.yaw_deg, Q.yaw_deg + 20) <= 2 && Math.hypot(turned.pose.x_m - Q.x_m, turned.pose.z_m - Q.z_m) <= 0.02 && turned.pose_source === 'manual',
      fmt(turned && { pose: turned.pose, pose_source: turned.pose_source }) + ` want yaw ${(Q.yaw_deg + 20).toFixed(1)}`)
  }
  const rs = await control(page, 'align-reset', [/^reset$/i])
  if (rs.loc) await rs.loc.click().catch(() => {})
  srvM = await waitFor(async () => { const mm = memberOf((await C.get(`/api/rooms/${ROOM}`)).json, S['room-2']); return mm?.pose_source === 'solver' ? mm : null }, { timeoutMs: photoWait > 3000 ? 8000 : 1500 })
  ev.check(`${T}: Reset (align-reset) puts room-2 back to the solver's pose (pose_source solver, 1e-6)`, !!rs.loc && srvM && poseEq(srvM.pose, P2, 1e-6, 1e-6), `${rs.how}; ${fmt(srvM && { pose: srvM.pose, pose_source: srvM.pose_source })}`)
  await sleep(300)
  const back2 = judgeRect(await rectNow(page, uid), plan['room-2'])
  ev.check(`${T}: …and the photo view is back on the true projection (3 px)`, back2.ok, `${back2.d.toFixed(2)} px`)
  if (tog.loc) await tog.loc.click().catch(() => {})
  await sleep(200)
  ev.check(`${T}: the toggle turns Align photos off again`, (await roomState(page))?.room?.alignPhotos === false, fmt((await roomState(page))?.room))
  await shot(page, `${T}-aligned`)

  const sp = await hook(page, 'setPose', [S['room-3'], { x_m: -1.8 }])
  const m3 = memberOf((await C.get(`/api/rooms/${ROOM}`)).json, S['room-3'])
  ev.check(`${T}: setPose(scene, {x_m}) saves that photo's pose (the other numbers kept), pose_source manual`, !sp.error && m3 && Math.abs(m3.pose.x_m + 1.8) < 1e-6 && Math.abs(m3.pose.z_m - byId['room-3'].pose.z_m) < 1e-6 && yawDiff(m3.pose.yaw_deg, byId['room-3'].pose.yaw_deg) < 1e-6 && m3.pose_source === 'manual',
    sp.error || fmt(m3))
  await C.send('PUT', `/api/rooms/${ROOM}`, { reset: [S['room-3']] })
  errorsOk(P, T)
  await P.context.close()
}
async function setPhoto(page, id) {
  const r1 = await hook(page, 'setRoomPhoto', [S[id]], 60000)
  if (r1.error) ev.note(`setRoomPhoto: ${r1.error}`)
  return waitPhoto(page, S[id], 5000)
}

// ======================================================================================================================================
async function phonePass(browser) {
  const T = 'phone 375'
  ev.section(`${T}: the room view on a phone (375 × 812, touch)`)
  const P = await openRoomPage(browser, B, { room: ROOM, photo: S['room-1'], device: 'phone', viewport: { width: 375, height: 812 } })
  ev.check(`${T}: the planner opens the room`, P.hookOk, P.why || P.url)
  const { page } = P
  let st = await roomState(page)
  const uid = st?.items?.find((i) => i.id === SOFA_PROBE.id)?.uid
  ev.check(`${T}: on room-1 with the room's latest layout`, st?.room?.photo === S['room-1'] && !!uid, fmt({ photo: st?.room?.photo, layout: st?.layout, items: st?.items?.length }))
  const thumbs = page.locator(`[data-midstudy="room-photo"][data-scene="${S['room-3']}"]`)
  const vis = await thumbs.first().isVisible().catch(() => false)
  if (vis) await thumbs.first().tap().catch(() => {})
  const ok = await waitPhoto(page, S['room-3'], photoWait)
  ev.check(`${T}: a tap on photo 4's thumbnail (room-photo) shows room-3`, vis && ok, `${vis ? 'visible' : 'no visible thumbnail'}; photo ${fmt((await roomState(page))?.room?.photo)}`)
  const j = judgeRect(await rectNow(page, uid), plan['room-3'])
  ev.check(`${T}: room-3: getScreenRect matches the true sofa's projection within 3 px (${j.how})`, j.ok, `${j.d.toFixed(2)} px`)
  let small = await smallTargets(page)
  let hs = await horizontalScroll(page)
  const inRoom = (await roomState(page))?.room?.name === ROOM
  ev.check(`${T}: with the photo strip: every visible target ≥ 44 × 44 px`, inRoom && small.length === 0, small.slice(0, 8).join('; ') || 'none')
  ev.check(`${T}: no horizontal page scroll`, inRoom && hs.scrollWidth <= hs.innerWidth && hs.bodyScrollWidth <= hs.innerWidth, fmt(hs))
  await shot(page, 'phone-strip')
  const t = await control(page, 'floor-plan-toggle', [/floor plan/i, /plan/i])
  if (t.loc) await t.loc.tap().catch(() => {})
  await sleep(500)
  st = await roomState(page)
  const p0 = (await hook(page, 'floorPlanPoint', [[SOFA.center[0], SOFA.center[2]]])).value
  ev.check(`${T}: floor-plan-toggle opens the floor plan sheet (floorPlan true, floorPlanPoint inside the screen)`, !!t.loc && st?.room?.floorPlan === true && p0 && p0.x >= 0 && p0.x <= 375 && p0.y >= 0 && p0.y <= 812, `${t.how}; ${fmt({ floorPlan: st?.room?.floorPlan, p0 })}`)
  small = await smallTargets(page)
  hs = await horizontalScroll(page)
  ev.check(`${T}: with the floor plan open: every visible target ≥ 44 × 44 px, no sideways scroll`, st?.room?.floorPlan === true && small.length === 0 && hs.scrollWidth <= hs.innerWidth, `${small.slice(0, 8).join('; ') || 'none'} ${fmt(hs)}`)
  await shot(page, 'phone-plan')
  errorsOk(P, T)
  await P.context.close()
}

// ======================================================================================================================================
for (const pass of PASSES) {
  let browser = null
  try { browser = await launchBackend(ev, { webgpu: pass === 'webgpu' }) } catch (e) { ev.check(`${pass}: headless Chrome starts`, false, String(e).split('\n')[0]); continue }
  await desktopPass(browser, pass)
  if (pass === 'webgpu') await phonePass(browser)
  await browser.close().catch(() => {})
}
ev.section('the contract')
ev.check('every /api answer this eval read matched contract/api/routes.json', C.violations.length === 0 && C.fiveXX.length === 0, [...C.violations, ...C.fiveXX].slice(0, 5).join(' | ') || 'all conform')
await ev.finish()
