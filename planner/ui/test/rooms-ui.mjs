#!/usr/bin/env node
// The app track's room-view check (contract §4.9 Planner and Hook) in headless Chrome, against the real server plus
// planner/ui/test/rooms-fake.mjs (the §4.9 routes, until the server track's land): the golden room (living-wide, room-1 …
// room-6) aligned by the calib mock's true poses; a probe placed in the room frame lands where each photo's truth says
// (getScreenRect within 3 px of this file's own §4.1 projection through the true pose); the photo strip and keys 1–9
// switch photos; the floor plan drags a piece; Align photos moves a photo (saved manual) and Reset puts it back; a room
// layout round-trips and switching photos leaves it clean; an unplaced photo parks the pieces; Set scale for the room
// (room-scale); a render names the room; the Scenes page's room card, New room (room-files), delete and restore; a
// phone pass at 375 px; and the WebGL2 fallback (?webgpu=0). Expectations come from the truth files and this file's maths.
// Usage (repo root, through the lock): nix develop -c node scripts/eval-lock.mjs -- node planner/ui/test/rooms-ui.mjs
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, PROBE, createEval, startServer, seedScene, launchBrowser, openPlanner, hook, state, golden, fmt, project, control, sleep, waitFor, raw,
} from '../../../evals/lib/harness.mjs'
import { startFake } from './rooms-fake.mjs'

const ev = createEval('APP-ROOMS', 'rooms-app-ui', { timeoutS: 900 })
const IDS = ['living-wide', 'room-1', 'room-2', 'room-3', 'room-4', 'room-5', 'room-6']
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})
const DEG = Math.PI / 180
// §4.9 frames, written here from the contract (not the planner's code)
const toScene = (p, pose) => { const a = pose.yaw_deg * DEG, c = Math.cos(a), s = Math.sin(a); const x = p[0] - pose.x_m, z = p[2] - pose.z_m; return [c * x - s * z, p[1], s * x + c * z] }
const turn = (lx, lz, deg) => { const a = deg * DEG, c = Math.cos(a), s = Math.sin(a); return [c * lx + s * lz, -s * lx + c * lz] }
function expectedRect(cam, W, H, at, rotDeg, dims) {
  const [w, h, d] = [dims.w / 100, dims.h / 100, dims.d / 100]
  const pts = []
  for (const lx of [-w / 2, w / 2]) for (const ly of [0, h]) for (const lz of [-d / 2, d / 2]) { const [x, z] = turn(lx, lz, rotDeg); pts.push([at[0] + x, at[1] + ly, at[2] + z]) }
  return pts
}
function rectOf(cam, W, H, pts, pose) {
  const px = []
  for (const p of pts) { const q = project(cam, W, H, toScene(p, pose)); if (q.d > 1e-4) px.push(q) }
  if (px.length < pts.length) return null // a corner behind the camera: not compared (the planner leaves such corners out)
  const xs = px.map((q) => q.px), ys = px.map((q) => q.py)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
const rectDiff = (a, b) => (a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) : Infinity)

const srv = await startServer(ev)
ev.check('the server starts (calib stub + MIDSTUDY_CALIB_MOCK, scratch dirs, probe library)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const fake = await startFake({ upstream: srv.base, scenesDir: srv.dirs.scenes, calibMock: path.join(REPO, 'fixtures/calib'), port: 8860 })
ev.onCleanup(() => fake.close())
ev.note(`rooms fake on ${fake.base} in front of ${srv.base}`)
const names = {}
for (const id of IDS) {
  const s = await seedScene(srv, id)
  names[id] = s.name
  if (s.why) ev.check(`seed ${id}`, false, s.why)
}
const truth = Object.fromEntries(IDS.map((id) => [id, golden(id).truth]))
const poseTrue = (id) => truth[id].pose_in_room ?? { x_m: 0, z_m: 0, yaw_deg: 0 }
const api = async (method, p, body) => { const r = await raw(fake.base, method, p, { headers: { 'X-Midstudy': '1', 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) }); return { status: r.status, json: r.json } }
const made = await api('POST', '/api/rooms', { title: 'Golden room', scenes: IDS.map((id) => names[id]) })
const ROOM = made.json?.name
ev.check('POST /api/rooms (fake) makes the golden room', made.status === 201 && !!ROOM, `${made.status} ${ROOM}`)
const al = await api('POST', `/api/rooms/${ROOM}/align`, {})
ev.check('POST …/align queues an align job', al.status === 202, `${al.status}`)
await waitFor(async () => (await api('GET', `/api/rooms/${ROOM}`)).json?.align_status === 'done', { timeoutMs: 30000 })
const det = (await api('GET', `/api/rooms/${ROOM}`)).json
const poseErr = Math.max(...IDS.map((id) => { const m = det.members.find((x) => x.scene === names[id]); const t = poseTrue(id); return m?.pose ? Math.max(Math.abs(m.pose.x_m - t.x_m), Math.abs(m.pose.z_m - t.z_m), Math.abs(m.pose.yaw_deg - t.yaw_deg)) : Infinity }))
ev.check('the mock alignment gives every photo its true pose', poseErr < 1e-6, `max error ${poseErr}`)

const browser = await launchBrowser(ev)
const errsOf = (P) => [...P.errors.page, ...P.errors.console]

async function roomChecks(P, label) {
  const { page } = P
  const st0 = await state(page)
  ev.check(`${label}: ?room= opens the room view on its first placed photo`, st0?.room?.name === ROOM && st0?.room?.photo === names['living-wide'], fmt(st0?.room))
  const missing = await page.evaluate(() => ['listRooms', 'createRoom', 'waitForRoom', 'openRoom', 'setRoomPhoto', 'getRoom', 'setPose', 'roomToScene', 'sceneToRoom', 'floorPlanPoint'].filter((n) => typeof window.midstudy[n] !== 'function'))
  ev.check(`${label}: the §4.9 hook methods are there`, missing.length === 0, missing.join(', ') || 'all')
  const gr = (await hook(page, 'getRoom')).value
  ev.check(`${label}: getRoom() lists the members with poses and effective cameras`, gr?.members?.length === IDS.length && gr.members.every((m) => m.effective_camera && 'confidence' in m), `${gr?.members?.length} members`)
  // a probe placed in the room frame
  await hook(page, 'clearItems')
  const AT = [0.35, 0, -2.6], ROT = 30
  const add = await hook(page, 'addItem', [PROBE.id, { position: AT, rotation_y_deg: ROT }])
  const uid = add.value
  const it = (await state(page))?.items?.find((i) => i.uid === uid)
  ev.check(`${label}: addItem takes a room-frame place and getState gives it back`, !!it && Math.max(...it.position.map((v, i) => Math.abs(v - AT[i]))) < 1e-9 && Math.abs(it.rotation_y_deg - ROT) < 1e-9, fmt(it?.position) + ` ${it?.rotation_y_deg}`)
  const pts = expectedRect(null, 0, 0, AT, ROT, PROBE.dims_cm)
  const diffs = []
  for (const id of IDS) {
    const r = await hook(page, 'setRoomPhoto', [names[id]])
    if (r.error) { diffs.push(`${id}: ${r.error}`); continue }
    const t = truth[id]
    const want = rectOf(t.camera, t.image.w, t.image.h, pts, poseTrue(id))
    const got = (await hook(page, 'getScreenRect', [uid])).value
    if (!want) { diffs.push(`${id}: a corner is behind the camera (skipped)`); continue }
    const d = got ? rectDiff(want, got) : Infinity
    diffs.push(`${id}: ${d === Infinity ? `got ${fmt(got)} want ${fmt(want)}` : d.toFixed(2)}`)
    const s = await state(page)
    const pos = s?.items?.find((i) => i.uid === uid)?.position
    if (!pos || Math.max(...pos.map((v, i) => Math.abs(v - AT[i]))) > 1e-9) diffs.push(`${id}: room position drifted to ${fmt(pos)}`)
  }
  const compared = diffs.filter((d) => /: \d+\.\d+$/.test(d))
  ev.check(`${label}: in every photo the probe's getScreenRect matches the true pose's projection within 3 px`, compared.length >= 5 && diffs.every((d) => /skipped/.test(d) || (/: \d+\.\d+$/.test(d) && Number(d.split(': ')[1]) <= 3)), diffs.join(' · '))
  await hook(page, 'setRoomPhoto', [names['living-wide']])
  return uid
}

// --- desktop, WebGPU (or the fallback when MIDSTUDY_WEBGPU=0) ------------------------------------------------------------
let P = await openPlanner(browser, fake.base, { viewport: { width: 1280, height: 800 } })
await P.page.goto(`${fake.base}/planner/?room=${ROOM}`, { waitUntil: 'load' })
await P.page.waitForFunction(() => window.midstudy?.getState?.().room !== undefined && window.midstudy.getState().room !== null, null, { timeout: 60000 }).catch(() => {})
const page = P.page
const uid = await roomChecks(P, 'desktop')
await shot(page, 'desktop-room')

// the photo strip: one room-photo per member, aria-pressed on the current one; a tap switches
const strip = await page.evaluate(() => [...document.querySelectorAll('[data-midstudy="room-photo"]')].map((b) => ({ scene: b.dataset.scene, pressed: b.getAttribute('aria-pressed') })))
ev.check('the photo strip has a room-photo per member in order, the current one pressed', strip.length === IDS.length && strip.every((s, i) => s.scene === names[IDS[i]]) && strip[0].pressed === 'true' && strip.slice(1).every((s) => s.pressed === 'false'), fmt(strip.map((s) => s.pressed)))
await page.locator(`[data-midstudy="room-photo"][data-scene="${names['room-2']}"]`).click()
await waitFor(async () => (await state(page))?.room?.photo === names['room-2'], { timeoutMs: 15000 })
ev.check('tapping a room-photo switches to that photo', (await state(page))?.room?.photo === names['room-2'], (await state(page))?.room?.photo)
await page.mouse.click(640, 500) // focus the view, not an input
await page.keyboard.press('4')
await waitFor(async () => (await state(page))?.room?.photo === names['room-3'], { timeoutMs: 15000 })
ev.check('key 4 switches to photo 4', (await state(page))?.room?.photo === names['room-3'], (await state(page))?.room?.photo)
await page.keyboard.press('1')
await waitFor(async () => (await state(page))?.room?.photo === names['living-wide'], { timeoutMs: 15000 })

// the floor plan: shown beside the view; floorPlanPoint; a drag moves the piece in the room frame
const fpVis = await page.locator('[data-midstudy="floor-plan"]').isVisible()
ev.check('the floor plan canvas shows beside the view (desktop)', fpVis && (await state(page))?.room?.floorPlan === true, `visible ${fpVis}`)
const before = (await state(page)).items.find((i) => i.uid === uid)
const p0 = (await hook(page, 'floorPlanPoint', [[before.position[0], before.position[2]]])).value
const p1 = (await hook(page, 'floorPlanPoint', [[before.position[0] + 0.5, before.position[2]]])).value
if (p0 && p1) {
  await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move((p0.x + p1.x) / 2, p0.y, { steps: 4 }); await page.mouse.move(p1.x, p1.y, { steps: 4 }); await page.mouse.up()
}
const after = (await state(page)).items.find((i) => i.uid === uid)
ev.check('dragging a footprint on the floor plan moves the piece 0.5 m along +X in the room frame (±2 cm)', !!p0 && !!after && Math.abs(after.position[0] - before.position[0] - 0.5) < 0.02 && Math.abs(after.position[2] - before.position[2]) < 0.02, `${fmt(before.position)} → ${fmt(after?.position)}`)
await hook(page, 'moveItem', [uid, { position: before.position }])

// Align photos: drag room-1's dot 0.3 m along +X; saved as manual; Reset puts it back
await page.locator('[data-midstudy="align-photos"]').click()
ev.check('align-photos turns Align photos on (aria-pressed, getState().room.alignPhotos)', (await page.locator('[data-midstudy="align-photos"]').getAttribute('aria-pressed')) === 'true' && (await state(page))?.room?.alignPhotos === true, '')
const t1 = poseTrue('room-1')
const a0 = (await hook(page, 'floorPlanPoint', [[t1.x_m, t1.z_m]])).value
const a1 = (await hook(page, 'floorPlanPoint', [[t1.x_m + 0.3, t1.z_m]])).value
if (a0 && a1) { await page.mouse.move(a0.x, a0.y); await page.mouse.down(); await page.mouse.move(a1.x, a1.y, { steps: 6 }); await page.mouse.up() }
await waitFor(async () => (await api('GET', `/api/rooms/${ROOM}`)).json?.members?.find((m) => m.scene === names['room-1'])?.pose_source === 'manual', { timeoutMs: 10000 })
const m1 = (await api('GET', `/api/rooms/${ROOM}`)).json.members.find((m) => m.scene === names['room-1'])
ev.check('dragging a photo in Align photos saves its new pose with pose_source manual', m1.pose_source === 'manual' && Math.abs(m1.pose.x_m - t1.x_m - 0.3) < 0.03 && Math.abs(m1.pose.z_m - t1.z_m) < 0.03, fmt(m1))
await page.locator('[data-midstudy="align-reset"]').click()
await waitFor(async () => (await api('GET', `/api/rooms/${ROOM}`)).json?.members?.find((m) => m.scene === names['room-1'])?.pose_source === 'solver', { timeoutMs: 10000 })
const m1b = (await api('GET', `/api/rooms/${ROOM}`)).json.members.find((m) => m.scene === names['room-1'])
ev.check('align-reset puts the photo back to the solver\'s answer', m1b.pose_source === 'solver' && Math.abs(m1b.pose.x_m - t1.x_m) < 1e-6, fmt(m1b))
// the turn handle of the current photo (living-wide is the origin: turn room-1 by making it current)
await hook(page, 'setRoomPhoto', [names['room-1']])
const hd = { x: t1.x_m - 0.75 * Math.sin(t1.yaw_deg * DEG), z: t1.z_m - 0.75 * Math.cos(t1.yaw_deg * DEG) }
const h0 = (await hook(page, 'floorPlanPoint', [[hd.x, hd.z]])).value
const yawTo = t1.yaw_deg - 20
const h1 = (await hook(page, 'floorPlanPoint', [[t1.x_m - 0.75 * Math.sin(yawTo * DEG), t1.z_m - 0.75 * Math.cos(yawTo * DEG)]])).value
if (h0 && h1) { await page.mouse.move(h0.x, h0.y); await page.mouse.down(); await page.mouse.move(h1.x, h1.y, { steps: 8 }); await page.mouse.up() }
await sleep(800)
const m1c = (await api('GET', `/api/rooms/${ROOM}`)).json.members.find((m) => m.scene === names['room-1'])
ev.check('dragging the current photo\'s turn handle turns it (−20°, saved manual)', m1c.pose_source === 'manual' && Math.abs(m1c.pose.yaw_deg - yawTo) < 1.5, fmt(m1c.pose))
await page.locator('[data-midstudy="align-reset"]').click()
await sleep(800)
await page.locator('[data-midstudy="align-photos"]').click()
await hook(page, 'setRoomPhoto', [names['living-wide']])

// room layouts: save, switch photos (still clean), load back
await hook(page, 'moveItem', [uid, { position: [0.35, 0, -2.6], rotation_y_deg: 30 }])
const sv = await hook(page, 'saveLayout', ['room-test'])
await hook(page, 'setRoomPhoto', [names['room-5']])
const st5 = await state(page)
ev.check('saveLayout saves a room layout; switching photos leaves it clean', !sv.error && st5?.layout === 'room-test' && st5?.dirty === false, sv.error || `layout ${st5?.layout} dirty ${st5?.dirty}`)
const doc = (await api('GET', `/api/layouts/room-test?room=${ROOM}`)).json
ev.check('the room layout names the room and holds room-frame positions', doc?.room_name === ROOM && !('scene_name' in doc) && Math.abs(doc.items[0].position[0] - 0.35) < 1e-6 && Math.abs(doc.items[0].rotation_y_deg - 30) < 1e-6, fmt(doc?.items?.[0]))
await hook(page, 'clearItems')
await hook(page, 'loadLayout', ['room-test'])
const lst = await state(page)
ev.check('loadLayout in another photo puts the piece back at its room place (1 mm, 0.1°)', lst.items.length === 1 && Math.abs(lst.items[0].position[0] - 0.35) < 1e-3 && Math.abs(lst.items[0].position[2] + 2.6) < 1e-3 && Math.abs(lst.items[0].rotation_y_deg - 30) < 0.1, fmt(lst.items[0]))
const ls = (await hook(page, 'listLayouts')).value
ev.check('listLayouts lists the room\'s layouts', Array.isArray(ls) && ls.includes('room-test'), fmt(ls))
const uid2 = lst.items[0]?.uid

// an unplaced photo: no room furniture, a note; back on a placed one the furniture is there
await hook(page, 'setPose', [names['room-6'], null])
await hook(page, 'setRoomPhoto', [names['room-6']])
const s6 = await state(page)
const noteText = await page.locator('.rm-note').textContent().catch(() => '')
ev.check('an unplaced photo shows no room furniture and the note', s6.items.length === 0 && /Place this photo/.test(noteText ?? ''), `${s6.items.length} items, note "${noteText}"`)
await hook(page, 'setRoomPhoto', [names['living-wide']])
const s6b = await state(page)
ev.check('back on a placed photo the furniture is where it was (and the layout clean)', s6b.items.length === 1 && Math.abs(s6b.items[0].position[0] - 0.35) < 1e-6 && s6b.dirty === false, fmt(s6b.items[0]?.position) + ` dirty ${s6b.dirty}`)
await api('PUT', `/api/rooms/${ROOM}`, { reset: [names['room-6']] })

// room-frame conversions on the hook
const rs = (await hook(page, 'roomToScene', [[1, 0.5, -2], names['room-2']])).value
const want = toScene([1, 0.5, -2], poseTrue('room-2'))
const back = (await hook(page, 'sceneToRoom', [rs, names['room-2']])).value
ev.check('roomToScene / sceneToRoom (named photo) follow §4.9 and invert each other', rs && Math.max(...rs.map((v, i) => Math.abs(v - want[i]))) < 1e-9 && Math.max(...back.map((v, i) => Math.abs(v - [1, 0.5, -2][i]))) < 1e-9, `${fmt(rs)} vs ${fmt(want)}`)
const fl = (await hook(page, 'floorToPhoto', [[0.35, 0, -2.6]])).value
const pf = fl ? (await hook(page, 'photoToFloor', fl)).value : null
ev.check('floorToPhoto and photoToFloor take and give room-frame points', !!pf && Math.abs(pf[0] - 0.35) < 1e-6 && Math.abs(pf[2] + 2.6) < 1e-6, fmt(pf))

// Set scale for the room (room-scale): the ruler in Adjust floor; every scale and position × k
await hook(page, 'setRoomPhoto', [names['living-wide']])
await hook(page, 'setAdjustFloor', [true])
const tp = truth['living-wide']
const fpA = (await hook(page, 'floorToPhoto', [[-0.5, 0, -2.0]])).value, fpB = (await hook(page, 'floorToPhoto', [[0.5, 0, -2.0]])).value
await page.evaluate(([a, b]) => {
  const e = window.midstudyCtx.engine
  e.setRulerActive(true)
  for (const p of [a, b]) { const [x, y] = e.photoToClient(p[0], p[1]); e.tap(x, y) }
}, [fpA, fpB])
const trueIn = await control(page, 'ruler-true')
const rsBtn = await control(page, 'room-scale')
let scaled = null
if (trueIn.loc && rsBtn.loc) {
  await trueIn.loc.fill('110')
  await rsBtn.loc.click()
  await waitFor(async () => (await api('GET', `/api/rooms/${ROOM}`)).json?.members?.[1]?.scale > 1.05, { timeoutMs: 10000 })
  scaled = (await api('GET', `/api/rooms/${ROOM}`)).json
}
const k = scaled ? scaled.members[1].scale : null
ev.check('room-scale (Adjust floor\'s ruler in a room view) rescales the room by true/measured (1.10), the scene camera untouched', !!k && Math.abs(k - 1.1) < 0.01 && Math.abs(scaled.members[1].pose.x_m - poseTrue('room-1').x_m * 1.1) < 0.01 && Math.abs((await hook(page, 'getCamera')).value.height_m - tp.camera.height_m) < 1e-9, `${trueIn.how}; ${rsBtn.how}; scale ${k}`)
// with scale 1.1 the photo is drawn through its effective camera (height × 1.1) and the scaled pose
await page.evaluate(() => { window.midstudyCtx.engine.setRulerActive(false) })
await hook(page, 'setAdjustFloor', [false])
await hook(page, 'setRoomPhoto', [names['room-2']])
const effCam = { ...truth['room-2'].camera, height_m: truth['room-2'].camera.height_m * 1.1 }
const pose2 = scaled?.members?.find((m) => m.scene === names['room-2'])?.pose
const rs2 = pose2 ? rectOf(effCam, truth['room-2'].image.w, truth['room-2'].image.h, expectedRect(null, 0, 0, [0.35, 0, -2.6], 30, PROBE.dims_cm), pose2) : null
const got2 = (await hook(page, 'getScreenRect', [s6b.items[0]?.uid])).value
const eff2 = (await hook(page, 'getRoom')).value?.members?.find((m) => m.scene === names['room-2'])?.effective_camera
ev.check('after Set scale a photo is drawn through its effective camera (height × scale) and scaled pose (getScreenRect within 3 px)', !!rs2 && rectDiff(rs2, got2) <= 3 && Math.abs((eff2?.height_m ?? 0) - effCam.height_m) < 1e-6, `${rectDiff(rs2, got2).toFixed(2)} px; effective height ${eff2?.height_m}`)
await api('PUT', `/api/rooms/${ROOM}`, { rescale: 1 / 1.1 })
await page.evaluate(() => { window.midstudyCtx.engine.setRulerActive(false) })
await hook(page, 'setAdjustFloor', [false])
await hook(page, 'openRoom', [ROOM, names['living-wide']])

// render in a room view names the room
const rv = await hook(page, 'renderView', [{}])
const lr = (await hook(page, 'listRenders')).value
ev.check('renderView in a room view sends room (the meta names it) and listRenders lists the room\'s renders', rv.value?.room === ROOM && rv.value?.scene === names['living-wide'] && Array.isArray(lr) && lr.some((r) => r.name === rv.value?.name), rv.error || fmt({ room: rv.value?.room, scene: rv.value?.scene, n: lr?.length }))
await shot(page, 'desktop-after')

// the Scenes page: one card per room, its scenes not shown again; New room; delete and restore
await page.evaluate(() => window.midstudyCtx.shell.openPage('scenes'))
await waitFor(async () => (await page.locator(`[data-midstudy="room-card"][data-room="${ROOM}"]`).count()) === 1, { timeoutMs: 10000 })
const cards = await page.evaluate(() => ({ rooms: [...document.querySelectorAll('[data-midstudy="room-card"]')].map((c) => c.dataset.room), scenes: [...document.querySelectorAll('[data-midstudy="scene-card"]')].map((c) => c.dataset.scene) }))
ev.check('the Scenes page shows the room as one card and none of its photos as scene cards', cards.rooms.includes(ROOM) && !IDS.some((id) => cards.scenes.includes(names[id])), fmt(cards))
await shot(page, 'scenes-page')
const nr = await control(page, 'room-new')
await nr.loc?.click()
await sleep(300)
await page.setInputFiles('[data-midstudy="room-files"]', [golden('living-wide').photo, golden('room-1').photo])
const newRoom = await waitFor(async () => {
  const rooms = (await hook(page, 'listRooms')).value ?? []
  return rooms.find((r) => r.name !== ROOM && r.members.length === 2 && r.align_status === 'done') ?? null
}, { timeoutMs: 60000 })
ev.check('New room (room-new, room-files with two photos) uploads both, makes the room and aligns it (the golden pair\'s true poses)', !!newRoom && Math.abs(newRoom.members[1].pose?.x_m - poseTrue('room-1').x_m) < 1e-6, fmt(newRoom?.members?.map((m) => m.pose)))
if (newRoom) {
  await page.locator(`[data-midstudy="room-card"][data-room="${newRoom.name}"] .sc-act`).click()
  await page.locator('[data-midstudy="room-delete"]').click()
  await page.locator('.dialog [data-value], .dialog button.btn-danger, [role="dialog"] .btn-danger').first().click().catch(() => {})
  await waitFor(async () => (await page.locator(`[data-midstudy="room-restore"][data-room="${newRoom.name}"]`).count()) === 1, { timeoutMs: 10000 })
  const del = (await hook(page, 'listRooms')).value ?? []
  ev.check('room-delete moves the room to Recently deleted (room-restore shows)', !del.some((r) => r.name === newRoom.name), `${del.length} rooms`)
  await page.locator(`[data-midstudy="room-restore"][data-room="${newRoom.name}"]`).click()
  await waitFor(async () => ((await hook(page, 'listRooms')).value ?? []).some((r) => r.name === newRoom.name), { timeoutMs: 10000 })
  ev.check('room-restore brings it back', ((await hook(page, 'listRooms')).value ?? []).some((r) => r.name === newRoom.name), '')
}
// a photo removed from the room through the card's menu (room-remove, data-scene), then added back (room-add)
await page.locator(`[data-midstudy="room-card"][data-room="${ROOM}"] .sc-act`).click()
const rmBtn = page.locator(`[data-midstudy="room-remove"][data-scene="${names['room-5']}"]`)
const hasRm = (await rmBtn.count()) === 1
if (hasRm) await rmBtn.click()
await waitFor(async () => !(await api('GET', `/api/rooms/${ROOM}`)).json?.members?.some((m) => m.scene === names['room-5']), { timeoutMs: 10000 })
const out5 = !(await api('GET', `/api/rooms/${ROOM}`)).json.members.some((m) => m.scene === names['room-5'])
ev.check('room-remove (data-scene) takes that photo out of the room', hasRm && out5, `button ${hasRm}`)
await page.locator(`[data-midstudy="room-card"][data-room="${ROOM}"] .sc-act`).click()
await page.locator('[data-midstudy="room-add"]').click()
await page.locator(`[data-midstudy="room-add-scene"][data-scene="${names['room-5']}"]`).click().catch(() => {})
await waitFor(async () => (await api('GET', `/api/rooms/${ROOM}`)).json?.members?.some((m) => m.scene === names['room-5']), { timeoutMs: 10000 })
ev.check('room-add adds a scene back to the room (unplaced until aligned)', (await api('GET', `/api/rooms/${ROOM}`)).json.members.some((m) => m.scene === names['room-5'] && m.pose_source === 'unplaced'), '')
await page.evaluate(() => window.midstudyCtx.shell.closePage())
ev.check('desktop: no page errors or console errors', errsOf(P).length === 0, errsOf(P).slice(0, 3).join(' | ') || 'none')
await P.context.close()

// --- phone, 375 px -----------------------------------------------------------------------------------------------------
await api('POST', `/api/rooms/${ROOM}/align`, {})
await waitFor(async () => (await api('GET', `/api/rooms/${ROOM}`)).json?.align_status === 'done', { timeoutMs: 30000 })
const Ph = await openPlanner(browser, fake.base, { device: 'phone' })
await Ph.page.setViewportSize({ width: 375, height: 812 })
await Ph.page.goto(`${fake.base}/planner/?room=${ROOM}`, { waitUntil: 'load' })
await Ph.page.waitForFunction(() => !!window.midstudy?.getState?.().room, null, { timeout: 60000 }).catch(() => {})
const pp = Ph.page
const ph0 = await state(pp)
ev.check('phone: the room opens', ph0?.room?.name === ROOM, fmt(ph0?.room))
const sizes = await pp.evaluate(() => [...document.querySelectorAll('[data-midstudy="room-photo"], [data-midstudy="floor-plan-toggle"]')].filter((e) => e.checkVisibility()).map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.midstudy, Math.round(r.width), Math.round(r.height)] }))
ev.check('phone: the strip and its plan toggle are touch targets (≥ 44 px tall)', sizes.length >= 2 && sizes.every(([, , hh]) => hh >= 44), fmt(sizes.slice(0, 4)))
const plan = await pp.locator('[data-midstudy="floor-plan"]').isVisible()
if (!plan) await pp.locator('[data-midstudy="floor-plan-toggle"]').tap()
await sleep(400)
ev.check('phone: floor-plan-toggle shows the plan as a sheet', await pp.locator('[data-midstudy="floor-plan"]').isVisible(), '')
const sw = await pp.evaluate(() => [document.documentElement.scrollWidth, innerWidth])
ev.check('phone: no sideways scroll', sw[0] <= sw[1], fmt(sw))
await shot(pp, 'phone-room')
await pp.locator(`[data-midstudy="room-photo"][data-scene="${names['room-3']}"]`).tap()
await waitFor(async () => (await state(pp))?.room?.photo === names['room-3'], { timeoutMs: 15000 })
ev.check('phone: tapping a photo in the strip switches to it', (await state(pp))?.room?.photo === names['room-3'], (await state(pp))?.room?.photo)
await pp.locator('[data-midstudy="floor-plan-toggle"]').tap()
await sleep(300)
ev.check('phone: floor-plan-toggle hides the plan again', !(await pp.locator('[data-midstudy="floor-plan"]').isVisible()) && (await state(pp))?.room?.floorPlan === false, '')
await shot(pp, 'phone-room-noplan')
ev.check('phone: no page errors or console errors', errsOf(Ph).length === 0, errsOf(Ph).slice(0, 3).join(' | ') || 'none')
await Ph.context.close()

// --- the WebGL2 fallback (?webgpu=0) ---------------------------------------------------------------------------------------
const G = await openPlanner(browser, fake.base, { viewport: { width: 1280, height: 800 } })
await G.page.goto(`${fake.base}/planner/?room=${ROOM}&webgpu=0`, { waitUntil: 'load' })
await G.page.waitForFunction(() => !!window.midstudy?.getState?.().room, null, { timeout: 60000 }).catch(() => {})
await roomChecks(G, 'webgl2 (?webgpu=0)')
await shot(G.page, 'webgl2-room')
ev.check('webgl2: no page errors or console errors', errsOf(G).length === 0, errsOf(G).slice(0, 3).join(' | ') || 'none')
await G.context.close()
fs.writeFileSync(path.join(ev.out, 'room.json'), JSON.stringify((await api('GET', `/api/rooms/${ROOM}`)).json, null, 2))
await ev.finish()
