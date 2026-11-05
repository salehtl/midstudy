// The Web Worker face (serveKernels / KernelWorker in core/js/web.ts) over a MessageChannel in Node: requests and
// replies, transfers (the caller's buffers are detached, results arrive as their own buffers), results equal to the
// direct calls, and errors (a bad PNG, a malformed request) as rejected promises.
// Usage (repo root): nix develop -c node core/crates/wasm-web/tests/worker.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as k from '../../../js/web.ts'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const wasmBytes = fs.readFileSync(path.join(REPO, 'build/wasm/web/midstudy_wasm_web_bg.wasm'))
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log(`ok   ${msg}`) }

const { port1, port2 } = new MessageChannel()
k.serveKernels(port2, new Uint8Array(wasmBytes))
const worker = new k.KernelWorker(port1) // both sides start their MessagePorts themselves

// depth.png: the worker's result equals the direct call, and the input buffer was transferred
const png = fs.readFileSync(path.join(REPO, 'fixtures/scenes/steep-roll/depth.png'))
const buf = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
const viaWorker = await worker.decodeDepth(buf)
ok(buf.byteLength === 0, 'decodeDepth transfers its input (the caller\'s buffer is detached)')
const direct = k.decodeDepth(new Uint8Array(png))
ok(viaWorker.width === 1024 && viaWorker.height === 768 && Buffer.compare(Buffer.from(viaWorker.data.buffer), Buffer.from(direct.data.buffer)) === 0, 'decodeDepth in the worker equals the direct call (1024 x 768)')

// the keep-room mask, with its PNG
const [w, h] = [320, 200]
const rgba = new Uint8Array(w * h * 4)
for (let y = 50; y < 80; y++) for (let x = 100; x < 140; x++) rgba[(y * w + x) * 4] = 255
const m = await worker.keepRoomMask(rgba.slice().buffer, w, h, { png: true })
const md = k.keepRoomMask(rgba, w, h, { png: true })
ok(m.coverage === md.coverage && m.coverage > 0 && Buffer.compare(Buffer.from(m.mask), Buffer.from(md.mask)) === 0, `keepRoomMask in the worker equals the direct call (coverage ${m.coverage.toFixed(4)})`)
ok(m.png instanceof Uint8Array && m.png[0] === 0x89 && m.png[1] === 0x50, 'keepRoomMask returns a PNG')
const back = k.decodeDepth(m.png) // 8-bit grayscale PNG: samples 0/255 read back (as mm / 1000)
ok(back.width === w && back.data.every((v, i) => v === (m.mask[i] ? Math.fround(0.255) : 0)), 'the mask PNG decodes back to the mask (255 on 0)')

// the environment map, half floats by default
const photo = new Uint8Array(64 * 48 * 4).map((_, i) => (i * 37) & 255)
const cam = new k.SceneCamera({ fov_y_deg: 60, height_m: 1.4, pitch_deg: -12, roll_deg: 2 }, 64, 48)
const rotation = cam.rotation()
const e = await worker.envMap(photo.slice().buffer, 64, 48, { rotation, fov_y_deg: 60 }, { width: 128, height: 64 })
const ed = k.envMap({ width: 64, height: 48, data: photo }, { rotation, fov_y_deg: 60 }, { width: 128, height: 64 })
ok(e.half && e.data instanceof Uint16Array && e.data.length === 128 * 64 * 4 && Buffer.compare(Buffer.from(e.data.buffer), Buffer.from(ed.data.buffer)) === 0, 'envMap in the worker equals the direct call (half floats)')
cam.dispose()

// errors come back as rejections
await assert.rejects(worker.decodeDepth(new Uint8Array([1, 2, 3]).buffer), /not a PNG/)
checks++; console.log('ok   a bad PNG rejects with the decoder\'s message')
const extra = new MessageChannel()
const reply = await new Promise((resolve) => {
  k.serveKernels(extra.port2)
  extra.port1.addEventListener('message', (ev) => resolve(ev.data))
  extra.port1.start()
  extra.port1.postMessage({ id: 9, op: 'nope' })
})
extra.port1.close(); extra.port2.close()
ok(reply.id === 9 && reply.ok === false && /malformed/.test(reply.error), 'a malformed request gets an error reply')

port1.close(); port2.close()
console.log(`${checks}/${checks} worker checks pass`)
