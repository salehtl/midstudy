// A small fake of the contract's §4.9 routes (rooms, align jobs, room layouts, render's `room`, the scene object's
// `room`), in front of the real server (node server/src/main.ts), for the app track's own UI tests until the server
// track's rooms land (docs/notes/rooms-app.md). Everything it doesn't own is proxied unchanged. Rooms live in memory.
// The align job applies the calib mock's answer (fixtures/calib/rooms/<key>/align.json, contract §4.9 Mock): the
// members' photo.jpg SHA-256s sorted, joined with "\n", hashed; re-expressed relative to the anchor and composed with
// its room pose (§4.9 Align). Not a conformance reference: it follows the contract as the app track read it.
//
// startFake({ upstream, scenesDir, calibMock, port }) → { base, port, rooms, close() }
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEG = Math.PI / 180
const wrap = (d) => { let y = (((d + 180) % 360) + 360) % 360 - 180; if (y === -180) y = 180; return y }
const clampPose = (p) => ({ x_m: Math.min(50, Math.max(-50, p.x_m)), z_m: Math.min(50, Math.max(-50, p.z_m)), yaw_deg: wrap(p.yaw_deg) })
const clampScale = (k) => Math.min(4, Math.max(0.25, k))
const clampH = (h) => Math.min(3, Math.max(0.2, h))
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function startFake({ upstream, scenesDir, calibMock, port = 8860 }) {
  const rooms = new Map() // name -> room.json-like { version, name, title, created, saved, members, aligned, align, trash }
  const trash = [] // { room, deleted, layouts }
  const jobs = []
  const layouts = new Map() // room -> Map(layout -> doc)
  const roomRenders = new Map() // render name -> room

  async function up(method, p, { headers = {}, body = null } = {}) {
    const res = await fetch(upstream + p, { method, headers, body, redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    let json = null
    try { json = JSON.parse(buf.toString('utf8')) } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, buf, json }
  }
  const roomOf = (scene) => { for (const r of rooms.values()) if (r.members.some((m) => m.scene === scene)) return r.name; return null }
  async function sceneObj(name) {
    const r = await up('GET', `/api/scenes/${encodeURIComponent(name)}`)
    return r.status === 200 ? r.json : null
  }
  function strip(scene) {
    const keep = ['name', 'title', 'created', 'saved', 'photo_url', 'thumb_url', 'depth_url', 'w', 'h', 'camera_source', 'floor_found', 'layouts', 'calib_status', 'calib_error']
    const o = {}
    for (const k of keep) if (k in scene) o[k] = scene[k]
    o.room = roomOf(scene.name)
    return o
  }
  async function memberDetail(m) {
    const s = await sceneObj(m.scene)
    const camera = s?.camera ?? { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
    return { ...m, scene_object: s ? strip(s) : { name: m.scene, title: null, created: now(), saved: null, photo_url: null, thumb_url: null, depth_url: null, w: null, h: null, camera_source: 'default', floor_found: null, layouts: 0, calib_status: 'failed', calib_error: 'gone', room: null }, camera, effective_camera: { ...camera, height_m: clampH(camera.height_m * m.scale) } }
  }
  function alignStatus(r) {
    const j = jobs.find((x) => x.room === r.name)
    if (j) return j.status === 'queued' ? 'pending' : j.status === 'running' ? 'running' : j.status === 'failed' ? 'failed' : 'done'
    return r.align ? 'done' : 'none'
  }
  async function roomObject(r, detail = false) {
    const members = await Promise.all(r.members.map(async (m) => {
      const d = await memberDetail(m)
      return detail ? d : { scene: d.scene, pose: d.pose, scale: d.scale, pose_source: d.pose_source, scene_object: d.scene_object }
    }))
    const j = jobs.find((x) => x.room === r.name)
    const o = { name: r.name, title: r.title, created: r.created, saved: r.saved, aligned: r.aligned, members, layouts: (layouts.get(r.name)?.size ?? 0), align_status: alignStatus(r), align_error: j?.status === 'failed' ? j.message : null }
    return detail ? { version: 1, ...o, align: r.align ?? null } : o
  }
  const send = (res, status, body) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b) }
  const err = (res, status, error) => send(res, status, { error })
  const mutating = (req) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const Ry = (a, x, z) => { const c = Math.cos(a * DEG), s = Math.sin(a * DEG); return [c * x + s * z, -s * x + c * z] }

  // §4.9 Align: the mock's answer for these members, re-expressed relative to the anchor, composed with its room pose
  async function runAlign(r, job, overwrite) {
    for (;;) {
      const busy = []
      for (const m of r.members) { const s = await sceneObj(m.scene); if (s && (s.calib_status === 'pending' || s.calib_status === 'running')) busy.push(m.scene) }
      job.waiting_for = busy
      if (!busy.length) break
      await new Promise((ok) => setTimeout(ok, 300))
      if (!rooms.has(r.name)) return
    }
    job.status = 'running'; job.started = now(); job.message = 'aligning'
    await new Promise((ok) => setTimeout(ok, 200))
    const withPhoto = r.members.filter((m) => fs.existsSync(path.join(scenesDir, m.scene, 'photo.jpg')))
    if (withPhoto.length < 2) { job.status = 'failed'; job.finished = now(); job.message = 'fewer than two photos'; return }
    const anchor = withPhoto.find((m) => m.pose && (m.pose_source === 'origin' || m.pose_source === 'manual' || (overwrite && m.pose))) ?? withPhoto.find((m) => m.pose) ?? withPhoto[0]
    const order = [anchor, ...withPhoto.filter((m) => m !== anchor)]
    const shas = new Map(order.map((m) => [m.scene, sha(path.join(scenesDir, m.scene, 'photo.jpg'))]))
    const key = crypto.createHash('sha256').update([...shas.values()].sort().join('\n')).digest('hex')
    const file = path.join(calibMock, 'rooms', key, 'align.json')
    let align
    if (fs.existsSync(file)) {
      const a = JSON.parse(fs.readFileSync(file, 'utf8'))
      const bySha = new Map(a.members.map((m) => [m.photo_sha256, m]))
      const am = bySha.get(shas.get(anchor.scene))
      const members = order.map((m) => {
        const x = bySha.get(shas.get(m.scene))
        if (!x?.pose || !am?.pose) return { scene: m.scene, photo_sha256: shas.get(m.scene), pose: null, scale: null, confidence: 0, residual_cm: null }
        const [dx, dz] = Ry(-am.pose.yaw_deg, x.pose.x_m - am.pose.x_m, x.pose.z_m - am.pose.z_m)
        return { scene: m.scene, photo_sha256: shas.get(m.scene), pose: { x_m: dx / am.scale, z_m: dz / am.scale, yaw_deg: wrap(x.pose.yaw_deg - am.pose.yaw_deg) }, scale: x.scale / am.scale, confidence: x.confidence, residual_cm: m === anchor ? null : x.residual_cm }
      })
      align = { version: 1, solver: a.solver, created: now(), elapsed_s: 0.2, device: null, loop_residual_cm: a.loop_residual_cm, members, unplaced: members.filter((m) => !m.pose).map((m) => m.scene) }
    } else {
      const members = order.map((m, i) => ({ scene: m.scene, photo_sha256: shas.get(m.scene), pose: i ? null : { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: i ? null : 1, confidence: i ? 0 : 1, residual_cm: null }))
      align = { version: 1, solver: 'none', created: now(), elapsed_s: 0.1, device: null, loop_residual_cm: null, members, unplaced: members.slice(1).map((m) => m.scene) }
    }
    if (!rooms.has(r.name)) return
    r.align = align
    applyAlign(r, align, overwrite, anchor)
    r.aligned = { solver: align.solver, finished: now() }
    r.saved = now()
    job.status = 'done'; job.finished = now(); job.message = 'aligned'; job.align = align
  }
  function applyAlign(r, align, overwrite, anchorIn, only = null) {
    const anchor = r.members.find((m) => m.scene === (anchorIn?.scene ?? align.members[0]?.scene))
    const A = anchor?.pose ?? { x_m: 0, z_m: 0, yaw_deg: 0 }
    const sa = anchor?.scale ?? 1
    for (const am of align.members) {
      const m = r.members.find((x) => x.scene === am.scene)
      if (!m || (only && !only.includes(m.scene))) continue
      if (m.pose_source === 'origin') continue
      if (m.pose_source === 'manual' && !overwrite) continue
      const file = path.join(scenesDir, m.scene, 'photo.jpg')
      if (!fs.existsSync(file) || sha(file) !== am.photo_sha256) { if (only) { m.pose = null; m.pose_source = 'unplaced' } continue }
      if (!am.pose) { m.pose = null; m.pose_source = 'unplaced'; continue }
      const [dx, dz] = Ry(A.yaw_deg, am.pose.x_m, am.pose.z_m)
      m.pose = clampPose({ x_m: A.x_m + sa * dx, z_m: A.z_m + sa * dz, yaw_deg: A.yaw_deg + am.pose.yaw_deg })
      m.scale = clampScale(sa * am.scale)
      m.pose_source = 'solver'
    }
    if (only) for (const s of only) { const m = r.members.find((x) => x.scene === s); if (m && m.pose_source !== 'origin' && !align.members.some((a) => a.scene === s)) { m.pose = null; m.pose_source = 'unplaced' } }
  }

  async function handle(req, res, body, u) {
    const p = u.pathname
    const json = () => { try { return body.length ? JSON.parse(body.toString('utf8')) : {} } catch { return undefined } }
    if (mutating(req) && req.headers['x-midstudy'] !== '1') return err(res, 403, 'cross-site request refused')
    if (p === '/api/rooms' && req.method === 'GET') {
      const list = [...rooms.values()].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : b.name.localeCompare(a.name)))
      return send(res, 200, { rooms: await Promise.all(list.map((r) => roomObject(r))), trash: trash.map((t) => ({ name: t.room.name, title: t.room.title, created: t.room.created, deleted: t.deleted })).reverse() })
    }
    if (p === '/api/rooms' && req.method === 'POST') {
      const b = json()
      if (!b || !Array.isArray(b.scenes) || !b.scenes.length || b.scenes.length > 32 || new Set(b.scenes).size !== b.scenes.length) return err(res, 400, 'scenes must be 1–32 scene names, no repeats')
      for (const s of b.scenes) { if (!(await sceneObj(s))) return err(res, 404, `no scene ${s}`); if (roomOf(s)) return err(res, 409, `${s} is in another room`) }
      let name = `room-${stamp()}`
      for (let i = 2; rooms.has(name); i++) name = `room-${stamp()}-${i}`
      const r = { version: 1, name, title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : null, created: now(), saved: null, aligned: null, align: null,
        members: b.scenes.map((s, i) => ({ scene: s, pose: i ? null : { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, pose_source: i ? 'unplaced' : 'origin' })) }
      rooms.set(name, r)
      return send(res, 201, await roomObject(r, true))
    }
    if (p === '/api/rooms/jobs') return send(res, 200, { jobs: [...jobs].reverse() })
    let m = /^\/api\/rooms\/jobs\/([^/]+)$/.exec(p)
    if (m) { const j = jobs.find((x) => x.id === m[1]); return j ? send(res, 200, j) : err(res, 404, 'no such job') }
    m = /^\/api\/rooms\/([^/]+)(\/align|\/restore)?$/.exec(p)
    if (m) {
      const name = decodeURIComponent(m[1])
      const r = rooms.get(name)
      if (m[2] === '/restore' && req.method === 'POST') {
        const i = trash.map((t) => t.room.name).lastIndexOf(name)
        if (i < 0) return err(res, 404, 'not in the trash')
        if (rooms.has(name)) return err(res, 409, 'a room by that name exists')
        const t = trash.splice(i, 1)[0]
        t.room.members = t.room.members.filter((x) => !roomOf(x.scene))
        rooms.set(name, t.room)
        if (t.layouts) layouts.set(name, t.layouts)
        return send(res, 200, await roomObject(t.room))
      }
      if (!r) return err(res, 404, `no room ${name}`)
      if (m[2] === '/align' && req.method === 'POST') {
        const b = json() ?? {}
        if (jobs.some((j) => j.room === name && (j.status === 'queued' || j.status === 'running'))) return err(res, 409, 'an alignment is queued or running')
        if (r.members.filter((x) => fs.existsSync(path.join(scenesDir, x.scene, 'photo.jpg'))).length < 2) return err(res, 409, 'fewer than two members have a photo')
        const job = { id: `a-${stamp()}-${crypto.randomBytes(2).toString('hex')}`, kind: 'align', room: name, status: 'queued', created: now(), started: null, finished: null, message: 'queued', waiting_for: [], align: null }
        for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].room === name) jobs.splice(i, 1)
        jobs.push(job)
        runAlign(r, job, !!b.overwrite_manual).catch((e) => { job.status = 'failed'; job.message = String(e); job.finished = now() })
        return send(res, 202, { job })
      }
      if (req.method === 'GET') return send(res, 200, await roomObject(r, true))
      if (req.method === 'DELETE') {
        rooms.delete(name)
        for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].room === name && jobs[i].status === 'queued') jobs.splice(i, 1)
        trash.push({ room: r, deleted: now(), layouts: layouts.get(name) })
        layouts.delete(name)
        return send(res, 200, { ok: true, trash: `rooms/.trash/${name}-${stamp()}` })
      }
      if (req.method === 'PUT') {
        const b = json()
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !['title', 'members', 'reset', 'rescale'].includes(k))) return err(res, 400, 'unknown keys')
        if ('title' in b) r.title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : null
        if (Array.isArray(b.members)) {
          const next = []
          for (const e of b.members) {
            if (!e || typeof e.scene !== 'string') return err(res, 400, 'bad member')
            const old = r.members.find((x) => x.scene === e.scene)
            if (!old) { if (!(await sceneObj(e.scene))) return err(res, 404, `no scene ${e.scene}`); if (roomOf(e.scene)) return err(res, 409, `${e.scene} is in another room`) }
            const cur = old ? { ...old } : { scene: e.scene, pose: null, scale: 1, pose_source: 'unplaced' }
            if (e.pose === null) { cur.pose = null; cur.pose_source = 'unplaced' } else if (e.pose) {
              const np = clampPose(e.pose)
              const same = cur.pose && Math.abs(cur.pose.x_m - np.x_m) < 1e-9 && Math.abs(cur.pose.z_m - np.z_m) < 1e-9 && Math.abs(wrap(cur.pose.yaw_deg - np.yaw_deg)) < 1e-9
              if (!same) { cur.pose = np; cur.pose_source = 'manual' }
            }
            if (typeof e.scale === 'number') cur.scale = clampScale(e.scale)
            next.push(cur)
          }
          r.members = next
          r.saved = now()
        }
        if (Array.isArray(b.reset)) {
          if (b.reset.some((s) => !r.members.some((x) => x.scene === s))) return err(res, 400, 'not a member')
          if (!r.align) return err(res, 409, 'no align.json yet')
          applyAlign(r, r.align, true, null, b.reset)
          for (const s of b.reset) { const x = r.members.find((q) => q.scene === s); if (x && x.pose_source === 'manual') x.pose_source = 'solver' }
          r.saved = now()
        }
        if (typeof b.rescale === 'number') {
          if (!(b.rescale > 0)) return err(res, 400, 'rescale must be > 0')
          for (const x of r.members) { x.scale = clampScale(x.scale * b.rescale); if (x.pose) x.pose = clampPose({ ...x.pose, x_m: x.pose.x_m * b.rescale, z_m: x.pose.z_m * b.rescale }) }
          r.saved = now()
        }
        return send(res, 200, await roomObject(r, true))
      }
    }
    // room layouts (§2.7 with ?room=)
    const lr = u.searchParams.get('room')
    m = /^\/api\/layouts(?:\/([^/]+))?$/.exec(p)
    if (m && lr !== null) {
      if (u.searchParams.has('scene')) return err(res, 400, 'exactly one of scene and room')
      if (!rooms.has(lr)) return err(res, 404, `no room ${lr}`)
      const map = layouts.get(lr) ?? new Map()
      layouts.set(lr, map)
      if (!m[1]) {
        const names = [...map.keys()].sort()
        return send(res, 200, { layouts: names, details: names.map((n) => ({ name: n, items: map.get(n).items.length, updated: map.get(n).updated, ...(map.get(n).title ? { title: map.get(n).title } : {}) })) })
      }
      const ln = decodeURIComponent(m[1])
      if (!SLUG.test(ln)) return err(res, 400, 'bad layout name')
      if (req.method === 'GET') return map.has(ln) ? send(res, 200, map.get(ln)) : err(res, 404, 'no such layout')
      if (req.method === 'PUT') {
        const b = json()
        if (!b || !Array.isArray(b.items)) return err(res, 400, 'bad layout')
        if ('scene_name' in b) delete b.scene_name
        const doc = { ...b, name: ln, room_name: lr, updated: now() }
        map.set(ln, doc)
        return send(res, 200, doc)
      }
      if (req.method === 'DELETE') {
        if (!map.has(ln)) return err(res, 404, 'no such layout')
        map.delete(ln)
        return send(res, 200, { ok: true, name: ln, room: lr, trash: `layouts/@${lr}/.trash/${ln}-${stamp()}.json` })
      }
    }
    return null
  }

  async function proxy(req, res, body, u) {
    // render: `room` is the fake's (the capture is the photo's as without a room)
    if (u.pathname === '/api/render' && req.method === 'POST') {
      let b = null
      try { b = JSON.parse(body.toString('utf8')) } catch { /* the server says */ }
      if (b && typeof b.room === 'string') {
        const r = rooms.get(b.room)
        if (!r) return err(res, 404, `no room ${b.room}`)
        if (!r.members.some((x) => x.scene === b.scene)) return err(res, 400, 'scene is not a member of that room')
        const room = b.room
        delete b.room
        const x = await up('POST', '/api/render', { headers: fwd(req), body: JSON.stringify(b) })
        if (x.status === 200 && x.json) { roomRenders.set(x.json.name, room); return send(res, 200, { ...x.json, room }) }
        return pass(res, x)
      }
    }
    if (u.pathname === '/api/renders' && req.method === 'GET' && u.searchParams.has('room')) {
      const room = u.searchParams.get('room')
      const x = await up('GET', '/api/renders')
      const list = (x.json?.renders ?? []).filter((r) => roomRenders.get(r.name) === room).map((r) => ({ ...r, room }))
      return send(res, 200, { ...x.json, renders: list })
    }
    const x = await up(req.method, u.pathname + u.search, { headers: fwd(req), body: ['GET', 'HEAD'].includes(req.method) ? null : body })
    // the scene object's `room` (§4.4, added with §4.9)
    if (x.status === 200 && x.json && u.pathname === '/api/scenes' && req.method === 'GET') return send(res, 200, { ...x.json, scenes: x.json.scenes.map((s) => ({ ...s, room: roomOf(s.name) })) })
    if (x.status === 200 && x.json && /^\/api\/scenes\/[^/]+$/.test(u.pathname) && req.method === 'GET') return send(res, 200, { ...x.json, room: roomOf(x.json.name) })
    if (x.status === 200 && x.json && /^\/api\/renders$/.test(u.pathname)) return send(res, 200, { ...x.json, renders: x.json.renders.map((r) => (roomRenders.has(r.name) ? { ...r, room: roomRenders.get(r.name) } : r)) })
    // a deleted scene leaves its room (§4.9 Membership)
    const del = /^\/api\/scenes\/([^/]+)$/.exec(u.pathname)
    if (del && req.method === 'DELETE' && x.status === 200) for (const r of rooms.values()) r.members = r.members.filter((q) => q.scene !== decodeURIComponent(del[1]))
    return pass(res, x)
  }
  function fwd(req) {
    const h = {}
    for (const k of ['content-type', 'x-midstudy', 'x-midstudy-filename', 'x-midstudy-meta', 'x-midstudy-kind']) if (req.headers[k]) h[k] = req.headers[k]
    return h
  }
  function pass(res, x) {
    const h = {}
    x.headers.forEach((v, k) => { if (!['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k)) h[k] = v })
    h['content-length'] = x.buf.length
    res.writeHead(x.status, h)
    res.end(x.buf)
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const u = new URL(req.url, 'http://x')
      try {
        const done = await handle(req, res, body, u)
        if (done === null && !res.headersSent) await proxy(req, res, body, u)
      } catch (e) { if (!res.headersSent) err(res, 500, String(e?.stack ?? e)) }
    })
  })
  let p = port
  for (;; p++) {
    const ok = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(p, '127.0.0.1', () => resolve(true)) })
    if (ok) break
    if (p > port + 100) throw new Error('no free port for the rooms fake')
  }
  return { base: `http://127.0.0.1:${p}`, port: p, rooms, close: () => new Promise((ok) => server.close(() => ok())) }
}
