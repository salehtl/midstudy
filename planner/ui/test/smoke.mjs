// A smoke test of the UI's flows the evals do not drive: a runner over planner/ui/test/sections/*.mjs, one file per
// package (planner-ui-shell made it one; docs/notes/state-machines-plan.md), so packages add checks without sharing a
// file. sections/base.mjs holds the cases written with the TypeScript port (ui track), unchanged. Each section exports
// `async function run(ctx)` and opens its own pages; ctx carries:
//   ev, srv, browser   the eval (createEval), the server (startServer: strict, fal mocked, $0) and the headless Chrome
//   H                  evals/lib/harness.mjs (openPlanner, hook, waitFor, …); waiting states come from playwright's
//                      page.route (hold, abort or answer 500 on a route), never from evals/ changes
//   scene              a seeded golden scene's name (living-wide; base renames it "Den")
//   seedScene(id, t)   another golden scene, seeded
//   open(opts)         a desktop planner ({ viewport = 1440 × 900, scene, setup(context) }), closed at the end
//   phone(opts)        a phone planner (touch, coarse pointer) of any size ({ viewport = 390 × 844, scene, setup })
//   goldenRoom()       the golden room (living-wide, room-1 … room-6) made and aligned by the calib mock, once:
//                      { room, names: { id → scene } }
// Sections run in file-name order; one that throws fails its own check and the rest still run.
// Usage (repo root): nix develop -c node scripts/eval-lock.mjs -- npm run eval:ui-smoke   (output: evals/out/ui-smoke/)
//   -- --only shell[,base]   runs just those sections
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as H from '../../../evals/lib/harness.mjs'

const { createEval, startServer, launchBrowser, openPlanner, seedScene, raw, waitFor, PHONE } = H

const onlyArg = process.argv.indexOf('--only')
const only = onlyArg >= 0 ? (process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean) : null
const ev = createEval('UI', 'ui-smoke', { timeoutS: 900 })
const srv = await startServer(ev)
ev.check('server up', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const S = await seedScene(srv, 'living-wide', 'Living room')
ev.check('scene seeded', S.name && !S.why, S.why || S.name)
const browser = await launchBrowser(ev)

// A planner page in its own context: desktop ({ viewport = 1440 × 900 }) or the harness's phone (touch, a coarse
// pointer) at any size; `setup(context)` runs before the page loads (page.route holds go there), the context closes at the end.
async function openIn(device, { viewport, scene = null, setup = null }) {
  const context = await browser.newContext(device === 'phone' ? { ...PHONE, viewport } : { viewport })
  ev.onCleanup(() => context.close().catch(() => {}))
  if (setup) await setup(context)
  return openPlanner({ newContext: async () => context }, srv.base, { device, scene })
}
const open = ({ viewport = { width: 1440, height: 900 }, ...o } = {}) => openIn('desktop', { viewport, ...o })
const phone = ({ viewport = PHONE.viewport, ...o } = {}) => openIn('phone', { viewport, ...o })
let room = null
async function makeRoom() {
  const IDS = ['living-wide', 'room-1', 'room-2', 'room-3', 'room-4', 'room-5', 'room-6']
  const names = {}
  for (const id of IDS) names[id] = (await seedScene(srv, id, id)).name
  const call = async (method, p, body) => { const r = await raw(srv.base, method, p, { headers: { 'X-Midstudy': '1', 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) }); return { status: r.status, json: r.json } }
  const made = await call('POST', '/api/rooms', { title: 'Golden room', scenes: IDS.map((id) => names[id]) })
  const name = made.json?.name ?? null
  if (name) {
    await call('POST', `/api/rooms/${name}/align`, {})
    await waitFor(async () => ((await call('GET', `/api/rooms/${name}`)).json?.align_status === 'done' ? true : null), { timeoutMs: 30000 }).catch(() => null)
  }
  return { room: name, names }
}
const ctx = {
  ev, srv, browser, H, scene: S.name,
  seedScene: async (id, title) => (await seedScene(srv, id, title)).name,
  open, phone,
  goldenRoom: () => { room ??= makeRoom(); return room },
}

const dir = path.join(import.meta.dirname, 'sections')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort().filter((f) => !only || only.includes(f.replace(/\.mjs$/, '')))
for (const f of files) {
  const t0 = Date.now()
  try {
    const mod = await import(pathToFileURL(path.join(dir, f)).href)
    await mod.run(ctx)
    console.log(`section ${f}: ${String(Math.round((Date.now() - t0) / 1000))} s`)
  } catch (e) {
    ev.check(`section ${f} runs to its end`, false, String(e?.stack ?? e).split('\n').slice(0, 4).join(' / '))
  }
}
await ev.finish()
