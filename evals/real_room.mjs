// eval:real-room — the real room, end to end on this Mac (docs/ROOMS.md §5 Phase D; not in eval:all). The user's photos of
// one room go up as a room exactly as the planner's New room sends them (POST /api/scenes per photo, POST /api/rooms,
// POST /api/rooms/<room>/align) to a server with the real calibration (real MoGe-2, the real align-room solver, no calib
// mock; fal mocked, $0). Then, from a measurements file (below): Set scale with the one tape measurement
// (PUT /api/rooms/<room> {"rescale": k}, as the room's ruler does), and every measured spot, as seen in every photo
// that shows it, is taken to the room frame through that photo's effective camera and pose (contract §4.1, §4.9):
// its distance to each of the two walls must match the tape within 5 cm. Also: unplaced photos, the loop residual,
// the spread of each spot across photos, and the time from the first upload to the room being aligned.
//
//   node evals/real_room.mjs --photos <dir> --measurements <file.json> [--title T] [--calib "CMD"] [--max-loop-cm 5]
//                           [--max-aligned-s 180]
//   node evals/real_room.mjs --golden     a self-check of this eval on the golden room fixtures: writes the photos (copies
//                                         of fixtures/scenes/*/photo.jpg) and their measurements from truth.json into
//                                         evals/out/real-room-golden/, runs with the calib stub and its mock (true poses)
//
// The photos are read from <dir> (one room, JPEG/HEIC/PNG/WebP, uploaded in file-name order; the first is the room's
// frame) and only ever written to the server's scratch scenes dir under evals/out/ (git-ignored: checked before
// anything is uploaded). Never point it at fixtures/photos/private/. The uploads' source.* copies (camera EXIF, GPS)
// are deleted at the end; results.json there holds poses and distances, nothing from the photos' metadata.
//
// measurements.json (pixel positions as fractions of the photo's width and height, as the photo is shown upright):
//   { "scale": { "photo": "IMG_1.jpg", "a": [u, v], "b": [u, v], "length_m": 3.42 },          one tape measurement on the floor
//     "walls": { "window": [ {"photo": "IMG_1.jpg", "uv": [u, v]}, {"photo": "IMG_2.jpg", "uv": [u, v]} ],
//                "door":   [ ... two floor points on that wall's base line, in any photos ... ] },
//     "spots": [ { "name": "table, front left leg", "from": { "window": 1.20, "door": 0.85 },     metres, by tape
//                  "seen": { "IMG_1.jpg": [u, v], "IMG_3.jpg": [u, v], ... } } ] }               where it touches the floor
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { REPO, REAL_CALIB, STUB_CALIB, createEval, startServer, api, raw, fmt, clip } from './lib/harness.mjs'
import { guardRooms, waitJob, memberOf, fmtPose, goldenMeasurements, measureSpots } from './lib/rooms.mjs'

const argv = process.argv.slice(2)
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt }
const GOLDEN = argv.includes('--golden')
const MAX_LOOP = Number(opt('--max-loop-cm', '5'))
const MAX_ALIGNED_S = Number(opt('--max-aligned-s', '180'))
const TOL_M = 0.05

let PHOTOS = opt('--photos'), MEAS = opt('--measurements')
if (GOLDEN) ({ photos: PHOTOS, measurements: MEAS } = goldenMeasurements(path.join(REPO, 'evals/out/real-room-golden')))
if (!PHOTOS || !MEAS) {
  console.error('usage: node evals/real_room.mjs --photos <dir> --measurements <file.json>   (or --golden); see the header of evals/real_room.mjs')
  process.exit(2)
}
PHOTOS = path.resolve(PHOTOS); MEAS = path.resolve(MEAS)
if (PHOTOS.split(path.sep).includes('private')) { console.error('real-room: refusing a folder named private (fixtures/photos/private/ is never opened)'); process.exit(2) }
const ev = createEval('R2', GOLDEN ? 'real-room-check' : 'real-room', { timeoutS: 1800 })
guardRooms(ev)
const CALIB = opt('--calib', GOLDEN ? STUB_CALIB : REAL_CALIB)
ev.note(`photos: ${path.relative(REPO, PHOTOS) || PHOTOS}; measurements: ${path.relative(REPO, MEAS) || MEAS}; calib: ${CALIB}${GOLDEN ? ' with MIDSTUDY_CALIB_MOCK (self-check)' : ' (real MoGe-2 and align-room, no mock)'}`)

// --- privacy: the scratch dirs must be git-ignored before a photo goes anywhere ------------------------------------------------------
const ignored = spawnSync('git', ['check-ignore', '-q', path.join(ev.out, 'server-1', 'scenes', 'x', 'photo.jpg')], { cwd: REPO })
if (!ev.check('the server\'s scratch dirs are git-ignored (evals/out/), so no photo can be committed', ignored.status === 0, `git check-ignore → ${ignored.status}`)) await ev.finish(1)
const files = fs.readdirSync(PHOTOS).filter((f) => /\.(jpe?g|png|heic|heif|webp)$/i.test(f) && !f.startsWith('.')).sort()
let meas = null
try { meas = JSON.parse(fs.readFileSync(MEAS, 'utf8')) } catch (e) { meas = null; ev.check('the measurements file reads as JSON', false, String(e)) }
const known = new Set(files)
const named = meas ? [meas.scale?.photo, ...Object.values(meas.walls || {}).flat().map((p) => p.photo), ...(meas.spots || []).flatMap((s) => Object.keys(s.seen || {}))] : []
ev.check('measurements: a scale, two walls with two floor points each, spots with tape distances to both walls; every photo named is in the folder',
  meas && meas.scale?.length_m > 0 && Object.keys(meas.walls || {}).length === 2 && Object.values(meas.walls).every((w) => w.length === 2) && meas.spots?.length > 0
  && meas.spots.every((s) => Object.keys(meas.walls).every((k) => typeof s.from?.[k] === 'number')) && named.every((n) => known.has(n)),
  `${files.length} photos; ${fmt({ walls: Object.keys(meas?.walls || {}), spots: meas?.spots?.length, unknown: named.filter((n) => !known.has(n)) })}`)
if (files.length < 2 || !meas) await ev.finish(1)

// --- upload, room, align ------------------------------------------------------------------------------------------------------------
const ROOMS = path.join(ev.out, 'data', 'rooms')
fs.mkdirSync(path.dirname(ROOMS), { recursive: true })
const srv = await startServer(ev, { calib: CALIB, calibMock: GOLDEN, library: 'none', args: ['--rooms-dir', ROOMS] })
ev.check('the server starts with the calibration under test and --rooms-dir (fal mocked, $0 cap)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish(1)
const B = srv.base
ev.onCleanup(() => {  // the uploads as given carry camera EXIF and GPS: never keep them
  for (const d of fs.existsSync(srv.dirs.scenes) ? fs.readdirSync(srv.dirs.scenes) : []) {
    for (const f of fs.existsSync(path.join(srv.dirs.scenes, d)) && fs.statSync(path.join(srv.dirs.scenes, d)).isDirectory() ? fs.readdirSync(path.join(srv.dirs.scenes, d)) : []) if (f.startsWith('source.')) fs.rmSync(path.join(srv.dirs.scenes, d, f), { force: true })
  }
})
const t0 = Date.now()
const names = {}
for (const f of files) {
  const r = await raw(B, 'POST', '/api/scenes', { headers: { 'Content-Type': 'application/octet-stream', 'X-Midstudy': '1', 'X-Midstudy-Filename': f }, body: fs.readFileSync(path.join(PHOTOS, f)) })
  names[f] = r.status === 202 ? r.json?.scene : null
  if (!names[f]) ev.note(`upload ${f}: ${r.status} ${clip(r.text, 160)}`)
}
ev.check(`all ${files.length} photos are accepted (POST /api/scenes → 202)`, files.every((f) => names[f]), fmt(Object.values(names)))
let r = await api.send(B, 'POST', '/api/rooms', { title: opt('--title', GOLDEN ? 'Golden room (real-room self-check)' : 'Real room'), scenes: files.map((f) => names[f]).filter(Boolean) })
const ROOM = r.json?.name
ev.check('POST /api/rooms → 201 (the photos in file-name order; the first is the frame)', r.status === 201 && !!ROOM, `${r.status} ${clip(r.text, 200)}`)
r = ROOM ? await api.send(B, 'POST', `/api/rooms/${ROOM}/align`) : { status: 0 }
const job = r.json?.job?.id ? await waitJob(B, r.json.job.id, 1500000) : null
const alignedS = (Date.now() - t0) / 1000
let d = ROOM ? (await api.get(B, `/api/rooms/${ROOM}`)).json : null
const calib = d?.members?.map((m) => m.scene_object?.calib_status) || []
ev.check('every photo calibrated (calib_status done) and the align job ended done', calib.length === files.length && calib.every((s) => s === 'done') && job?.status === 'done', fmt({ calib, job: job && { status: job.status, message: job.message } }))
ev.check(`upload to aligned within ${MAX_ALIGNED_S} s (ROOMS §1: "within a minute or two")`, job?.status === 'done' && alignedS <= MAX_ALIGNED_S, `${alignedS.toFixed(1)} s for ${files.length} photos (solver ${d?.align?.solver}, align-room ${d?.align?.elapsed_s} s on ${d?.align?.device})`)
const unplaced = d?.members?.filter((m) => !m.pose).map((m) => Object.keys(names).find((f) => names[f] === m.scene)) || []
ev.check('at most one photo unplaced', d && unplaced.length <= 1, fmt({ unplaced, low_confidence: d?.align?.members?.filter((m) => m.pose && m.confidence < 0.5).map((m) => [Object.keys(names).find((f) => names[f] === m.scene), m.confidence]) }))
ev.check(`loop residual ≤ ${MAX_LOOP} cm`, d?.align && d.align.loop_residual_cm !== null && d.align.loop_residual_cm <= MAX_LOOP, fmt({ loop_residual_cm: d?.align?.loop_residual_cm, residuals: d?.align?.members?.map((m) => m.residual_cm) }))

// --- Set scale --------------------------------------------------------------------------------------------------------------------------
// Each member as the measurements need it: its pose, scale, scene.json camera and photo size (contract §4.9: the effective camera).
const membersOf = (detail) => Object.fromEntries(files.map((f) => { const m = memberOf(detail, names[f]); return [f, m && { pose: m.pose, scale: m.scale, camera: m.camera, w: m.scene_object?.w, h: m.scene_object?.h }] }))
let res = d ? measureSpots(meas, membersOf(d)) : null
const k = res?.scale_measured_m ? meas.scale.length_m / res.scale_measured_m : null
r = k ? await api.send(B, 'PUT', `/api/rooms/${ROOM}`, { rescale: k }) : { status: 0 }
d = r.status === 200 ? r.json : d
ev.check('Set scale: the tape length over the measured one rescales the room (PUT {"rescale": k} → 200)', r.status === 200, `measured ${res?.scale_measured_m?.toFixed(3)} m, tape ${meas.scale.length_m} m, k = ${k?.toFixed(4)} (${k ? ((k - 1) * 100).toFixed(1) : '?'} %)`)

// --- the spots ----------------------------------------------------------------------------------------------------------------------------
res = d ? measureSpots(meas, membersOf(d)) : { walls: {}, spots: [] }
ev.check('both walls are on the floor plan (each from two floor points in placed photos)', Object.keys(meas.walls).every((n) => res.walls[n]), fmt(res.walls))
const report = res.spots
for (const s of report) {
  ev.check(`${s.name}: in every photo that shows it (${s.rows.length}), its distances to ${Object.keys(s.from).join(' and ')} match the tape within ${TOL_M * 100} cm`,
    s.rows.length > 0 && s.rows.every((x) => x.err_cm <= TOL_M * 100), `${s.rows.map((x) => `${x.photo}: ${Number.isFinite(x.err_cm) ? `${x.err_cm.toFixed(1)} cm` : x.room ? 'a wall is not on the plan' : 'unplaced'}`).join(', ')}; spread ${s.spread_cm} cm`)
}
fs.writeFileSync(path.join(ev.out, 'real-room.json'), JSON.stringify({ room: ROOM, photos: files, aligned_s: alignedS, scale_k: k, align: d?.align && { solver: d.align.solver, device: d.align.device, elapsed_s: d.align.elapsed_s, loop_residual_cm: d.align.loop_residual_cm }, poses: d?.members?.map((m) => ({ photo: Object.keys(names).find((f) => names[f] === m.scene), pose: m.pose, scale: m.scale, pose_source: m.pose_source })), spots: report }, null, 2))
ev.note(`poses: ${d?.members?.map((m) => `${Object.keys(names).find((f) => names[f] === m.scene)} ${fmtPose(m.pose)} ×${m.scale?.toFixed(3)}`).join('; ')}`)
ev.note(`open the room: ${B}/planner/?room=${ROOM} (the server stops when this eval ends; evals/out/${ev.slug}/real-room.json has the numbers)`)
await ev.finish()
