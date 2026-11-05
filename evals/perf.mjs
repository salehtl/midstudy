#!/usr/bin/env node
// E17 eval:perf — where the time goes (docs/REFACTOR.md §4): the planner, the server and the furniture CLI, measured
// the same way on v1 and v2. Written before the v2 code changes; it only uses what every eval uses (the contract's
// HTTP API, the window.midstudy hook, the CLIs) and the target's own evals/lib/harness.mjs, so it measures any worktree.
//
// Each metric: N runs (default 5) after W warm-ups (default 1), median and p95, os.loadavg() before and after. Suites,
// in order (each one's runs are interleaved across targets, ABBA, when there are several):
//   server   server_start: spawn → first 200 on /planner/ (polled every 5 ms)
//   api      api_{scenes,library,layouts}_{p50,p95}: 200 sequential GETs per route per run
//   product  product_read_{p50,p95,max}: POST /api/library/product (llm false) for every page in
//            fixtures/product-pages/manifest.json except the two whose answer is the 20 s read limit (--product-all)
//   cli      add_cli_{idol,sam3d,glb,rug}: the furniture CLI end to end against the fal mock, wall time
//   load     planner_load_{desktop,desktop_warm,phone}: fresh context → /planner/?scene=<living-wide> → midstudy.ready
//            and two frames (the photo checked on a screenshot), from navigation start; requests, bytes, heap
//   scene    scene_open: openScene(living-wide) from the Scenes page of a loaded planner; long tasks
//   edit     one fresh copy of living-wide per run, in a fresh page: add_item_glb (probe box), add_item_glb_textured
//            (SheenChair), drag_frames_{p50,p95} (rAF intervals during a 2 s mouse drag), render_capture and
//            render_keep_room (+ _client and _server: the page's and the POST's share), add_item_splat (the Idol fixture
//            item: Spark and splat.spz), splat_first_frame (then until the view is idle), drag_splat (a 5-move drag with
//            the splat in view, ms per move: the splat pass every frame), render_capture_splat (renderView with the splat: Spark's sort)
//   calib    calib_{first,second} (--with-calib): real MoGe-2, two calibrations of one golden photo in a row on a fresh
//            server, POST → job done ($0, minutes)
//
// Usage:
//   node evals/perf.mjs [--runs 5] [--warmup 1] [--only a,b] [--skip a,b] [--with-calib] [--product-all]
//                       [--repo <worktree>] [--label name] [--out <file>] [--baseline] [--compare <file>] [--profile]
//   node evals/perf.mjs --target v1:<worktree> --target v2:<worktree>[:MIDSTUDY_SERVER=next,MIDSTUDY_ADD=next] ...
//        A/B interleaved: every later target is compared with the first (ratio of medians, allowance below)
//   node evals/perf.mjs --make-baseline run1.json run2.json run3.json   quietest run + run-to-run noise → evals/perf/baseline.json
//   node evals/perf.mjs --results <results.json> --compare <base.json>   compare two result files, measure nothing
// --only/--skip take suite or metric names. Output: evals/out/perf/results.json (every sample, machine, commits, load),
// evals/out/perf/table.txt, --profile → evals/out/perf/profiles/. Exit 1 when --compare finds a regression or a metric
// has no valid sample. Always $0: fal mocked (MIDSTUDY_FAL_MOCK=fixtures/fal, MIDSTUDY_NO_DOTENV=1), spend cap 0.
//
// Compare allowance: a metric fails when now > base × (1 + 10 % + noise) and now − base > 1 ms. noise is the metric's
// measured run-to-run noise: the relative range of the per-run medians over the baseline's runs (--make-baseline), or,
// for a single run, the median's own uncertainty from its samples (2 × 1.25 × 1.4826 × MAD / √n, both medians: ×√2).
// MIDSTUDY_SERVER and MIDSTUDY_ADD pass through to the target's harness (and choose the commands spawned here, see
// serverCommand/addCommand); MIDSTUDY_PERF_SERVER_CMD and MIDSTUDY_PERF_ADD_CMD override those commands.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SELF = path.resolve(import.meta.dirname, '..')
const OUT = path.join(SELF, 'evals/out/perf')
const BASELINE = path.join(SELF, 'evals/perf/baseline.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.now()
const round = (v, n = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : v)
const clip = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s }

// --- arguments -------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const opt = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const opts = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []))
const listOpt = (k) => (opt(k) ? opt(k).split(',').map((s) => s.trim()).filter(Boolean) : null)
const A = {
  runs: Number(opt('--runs', 5)), warmup: Number(opt('--warmup', 1)), only: listOpt('--only'), skip: listOpt('--skip') || [],
  withCalib: flag('--with-calib'), productAll: flag('--product-all'), out: opt('--out'), baseline: flag('--baseline'),
  compare: opt('--compare'), results: opt('--results'), profile: flag('--profile'), label: opt('--label'),
  makeBaseline: flag('--make-baseline') ? argv.slice(argv.indexOf('--make-baseline') + 1).filter((a) => !a.startsWith('--')) : null,
  targets: opts('--target'), repo: opt('--repo'),
}

// --- statistics ------------------------------------------------------------------------------------------------------
function quantile(xs, q) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return null
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const median = (xs) => quantile(xs, 0.5)
const mad = (xs) => { const m = median(xs); return m == null ? null : median(xs.map((x) => Math.abs(x - m))) }
// Uncertainty of a difference of two medians of n samples each, relative: 2σ of the difference, σ_median ≈ 1.2533 σ/√n,
// σ ≈ 1.4826 MAD (normal approximation; robust to the odd slow run).
const withinNoise = (xs) => { const m = median(xs), d = mad(xs); return m > 0 && xs.length > 1 ? (2 * Math.SQRT2 * 1.2533 * 1.4826 * d) / Math.sqrt(xs.length) / m : null }
function summarize(samples) {
  const ok = samples.filter((s) => !s.warmup && s.ok && Number.isFinite(s.value))
  const v = ok.map((s) => s.value)
  const ex = {}
  for (const s of ok) for (const [k, x] of Object.entries(s.extra || {})) if (typeof x === 'number') (ex[k] ||= []).push(x)
  return {
    n: v.length, failed: samples.filter((s) => !s.warmup && !s.ok).length, median: median(v), p95: quantile(v, 0.95),
    min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, mad: mad(v), noise_within: withinNoise(v),
    load_before: samples.find((s) => !s.warmup)?.load?.[0] ?? null, load_after: samples.filter((s) => !s.warmup).at(-1)?.load?.[1] ?? null,
    extra: Object.fromEntries(Object.entries(ex).map(([k, xs]) => [k, round(median(xs), 3)])),
    errors: [...new Set(samples.filter((s) => !s.ok).map((s) => s.error))].slice(0, 3),
  }
}

// --- metrics ---------------------------------------------------------------------------------------------------------
const M = (suite, what, unit = 'ms') => ({ suite, what, unit })
const METRICS = {
  server_start: M('server', 'spawn → first 200 on /planner/'),
  api_scenes_p50: M('api', 'GET /api/scenes, p50 of 200 sequential'), api_scenes_p95: M('api', 'GET /api/scenes, p95 of 200'),
  api_library_p50: M('api', 'GET /api/library, p50 of 200 sequential'), api_library_p95: M('api', 'GET /api/library, p95 of 200'),
  api_layouts_p50: M('api', 'GET /api/layouts?scene=, p50 of 200 sequential'), api_layouts_p95: M('api', 'GET /api/layouts?scene=, p95 of 200'),
  product_read_p50: M('product', 'POST /api/library/product, llm false: p50 over the pages'),
  product_read_p95: M('product', '… p95 over the pages'), product_read_max: M('product', '… the slowest page'),
  add_cli_idol: M('cli', 'midstudy-add idol (262k splats), fal mock'), add_cli_sam3d: M('cli', 'midstudy-add sam3d, fal mock'),
  add_cli_glb: M('cli', 'midstudy-add glb (SheenChair, 7 textures)'), add_cli_rug: M('cli', 'midstudy-add rug (800 px picture)'),
  planner_load_desktop: M('load', 'cold load to ready + 2 frames, 1280×800'), planner_load_desktop_warm: M('load', 'the same, reloaded (warm HTTP cache)'),
  planner_load_phone: M('load', 'cold load to ready + 2 frames, 390×844 touch'),
  scene_open: M('scene', 'openScene(living-wide) from the Scenes page'),
  add_item_glb: M('edit', 'addItem(probe box), first in the page'), add_item_glb_textured: M('edit', 'addItem(SheenChair, 4 MB, textures)'),
  drag_frames_p50: M('edit', 'rAF interval p50 during a 2 s mouse drag'), drag_frames_p95: M('edit', 'rAF interval p95 during the drag'),
  render_capture: M('edit', 'renderView() nano-banana, mock'), render_capture_client: M('edit', '… the page (capture, encode)'), render_capture_server: M('edit', '… the POST /api/render'),
  render_keep_room: M('edit', 'renderView({keepRoom}), mock'), render_keep_room_client: M('edit', '… the page (capture + mask)'), render_keep_room_server: M('edit', '… the POST (stub align)'),
  add_item_splat: M('edit', 'addItem(Idol chair): Spark + splat.spz, first splat'), splat_first_frame: M('edit', '… then until the view is idle (first draw)'),
  drag_splat: M('edit', 'a 5-move mouse drag with the splat in view, ms per move drawn'),
  render_capture_splat: M('edit', 'renderView() with the splat (sort + capture)'),
  calib_first: M('calib', 'real MoGe-2: 1st photo on a fresh server, POST → done'), calib_second: M('calib', 'the 2nd photo, right after'),
}
const SUITES = ['server', 'api', 'product', 'cli', 'load', 'scene', 'edit', 'calib']
const wanted = (s) => {
  const names = [s, ...Object.keys(METRICS).filter((m) => METRICS[m].suite === s)]
  if (s === 'calib' && !A.withCalib && !A.only?.some((x) => names.includes(x))) return false
  if (A.skip.some((x) => x === s)) return false
  return !A.only || A.only.some((x) => names.includes(x))
}

// --- machine, git ----------------------------------------------------------------------------------------------------
const loadavg = () => os.loadavg().map((v) => round(v, 2))
const sh = (cmd, args, cwd, timeout = 30000) => { try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim() } catch { return null } }
function gitInfo(repo) {
  return { commit: sh('git', ['rev-parse', 'HEAD'], repo), branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo),
    dirty: !!sh('git', ['status', '--porcelain', '--untracked-files=no'], repo) }
}
function machine() {
  return { host: os.hostname(), platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, ncpu: os.cpus().length,
    mem_gb: round(os.totalmem() / 2 ** 30, 1), node: process.version, python: sh('python3', ['--version'], SELF), uv: sh('uv', ['--version'], SELF) }
}

// --- targets ---------------------------------------------------------------------------------------------------------
// A target is a worktree measured with its own harness (and so its own server, CLI, fixtures), plus optional env
// (MIDSTUDY_SERVER=next …) applied around every call into it. Calls are sequential, so swapping process.env is safe.
async function withEnv(env, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
function parseTarget(spec, i) {
  // label:path[:K=V,K=V] (a path may hold ':' only if a label is given; good enough for worktree paths)
  const parts = spec.split(':')
  let label = parts.length > 1 ? parts[0] : null, p = parts.length > 1 ? parts[1] : parts[0], envs = parts.slice(2).join(':')
  const env = Object.fromEntries(envs.split(',').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
  p = path.resolve(p)
  return { label: label || (i === 0 && A.label) || path.basename(p), repo: p, env }
}
async function loadTarget(t) {
  if (!fs.existsSync(path.join(t.repo, 'evals/lib/harness.mjs'))) throw new Error(`${t.repo}: no evals/lib/harness.mjs`)
  // a query string gives each target its own module instance (and module-level env reads), even for the same repo
  t.H = await withEnv(t.env, () => import(`${pathToFileURL(path.join(t.repo, 'evals/lib/harness.mjs')).href}?perf=${encodeURIComponent(t.label)}`))
  t.out = path.join(OUT, 'targets', t.label)
  fs.rmSync(t.out, { recursive: true, force: true })
  fs.mkdirSync(t.out, { recursive: true })
  t.cleanups = []
  t.ev = { out: t.out, onCleanup: (fn) => t.cleanups.push(fn) }
  t.git = gitInfo(t.repo)
  t.mode = { server: t.env.MIDSTUDY_SERVER ?? process.env.MIDSTUDY_SERVER ?? null, add: t.env.MIDSTUDY_ADD ?? process.env.MIDSTUDY_ADD ?? null }
  t.metrics = {}
  t.shared = {}
  t.info = {}
  return t
}
const call = (t, fn) => withEnv(t.env, fn)
async function cleanupTarget(t) { for (const fn of t.cleanups.splice(0).reverse()) { try { await fn() } catch { /* best effort */ } } }

// What a target's server and CLI are. The harness may export serverCommand()/addCommand() (requested of f-contract);
// otherwise: legacy = what v1's harness and serve.py run; next = docs/REFACTOR.md §1's commands.
const words = (s) => s.match(/"[^"]*"|'[^']*'|\S+/g).map((w) => w.replace(/^["']|["']$/g, ''))
function serverCommand(t) {
  if (process.env.MIDSTUDY_PERF_SERVER_CMD) return words(process.env.MIDSTUDY_PERF_SERVER_CMD)
  if (typeof t.H.serverCommand === 'function') { try { const c = t.H.serverCommand(); if (Array.isArray(c) && c.length) return c } catch { /* fall back */ } }
  const mode = t.mode.server || (fs.existsSync(path.join(t.repo, 'planner/serve.py')) ? 'legacy' : 'next')
  return mode === 'next' ? ['node', 'server/src/main.ts'] : ['python3', 'planner/serve.py']
}
function addCommand(t) {
  if (process.env.MIDSTUDY_PERF_ADD_CMD) return words(process.env.MIDSTUDY_PERF_ADD_CMD)
  if (typeof t.H.addCommand === 'function') { try { const c = t.H.addCommand(); if (Array.isArray(c) && c.length) return c } catch { /* fall back */ } }
  const mode = t.mode.add || (fs.existsSync(path.join(t.repo, 'pipeline/pyproject.toml')) ? 'legacy' : 'next')
  return mode === 'next' ? ['node', 'pipeline/src/cli.ts'] : ['uv', 'run', '--project', 'pipeline', 'midstudy-add']
}
// The environment every server and CLI run gets (the harness's rules): fal mocked, no .env, no FAL_KEY.
function mockEnv(t, extra = {}) {
  const e = { ...process.env, ...t.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(t.repo, 'fixtures/fal'), NOOK_FAL_MOCK: path.join(t.repo, 'fixtures/fal'), ...extra }
  delete e.FAL_KEY
  delete e.MIDSTUDY_FAL_MOCK_COST
  for (const [k, v] of Object.entries(e)) if (v == null) delete e[k]
  return e
}

// The CLI's environment: the mock, any network request failing loudly (as E8 does), and each language's compile cache,
// as an installed CLI has it (the dev shell sets PYTHONDONTWRITEBYTECODE=1, which recompiles ~280 modules, ~0.3 s, on
// every run; the Nix package ships bytecode). Node gets NODE_COMPILE_CACHE for the same reason.
function cliEnv(t) {
  return mockEnv(t, { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
    PYTHONDONTWRITEBYTECODE: null, NODE_COMPILE_CACHE: path.join(OUT, 'node-compile-cache', t.label) })
}

// --- recording -------------------------------------------------------------------------------------------------------
let RUN = { i: 0, warmup: false }
function record(t, name, value, extra = {}, error = null) {
  const m = (t.metrics[name] ||= { ...METRICS[name], samples: [] })
  const ok = !error && Number.isFinite(value)
  m.samples.push({ run: RUN.i, warmup: RUN.warmup, ok, value: ok ? round(value, 3) : null, error: ok ? undefined : clip(error || `no value (${value})`, 300),
    load: [RUN.load, null], at: new Date().toISOString(), extra })
  return ok
}
const fail = (t, names, e) => { for (const n of names) record(t, n, null, {}, String(e?.message || e)) }
function stampLoadAfter(t, names) { const l = loadavg(); for (const n of names) { const s = t.metrics[n]?.samples.at(-1); if (s && s.load[1] == null) s.load[1] = l } }

// --- shared fixtures per target ----------------------------------------------------------------------------------------
const LW = 'living-wide'
const CHAIR = { id: 'sheen-chair', name: 'Sheen Chair', dims_cm: { w: 82.66, d: 57.03, h: 68.62 } }
const IDOL = { id: 'idol-chair', name: 'Idol Chair', dims_cm: { w: 80, d: 90, h: 95 } }

// The main server: the probe library plus SheenChair and the Idol chair (made through the library API, fal mock), golden
// living-wide (the browser suites), steep-roll with three layouts (api), and the pages server (product).
async function mainServer(t) {
  if (t.shared.srv) return t.shared.srv
  const { startPagesServer, syntheticPages } = await import(pathToFileURL(path.join(SELF, 'evals/lib/pages_server.mjs')).href)
  const synth = syntheticPages()
  const pages = await startPagesServer({ routes: synth.routes, dir: synth.dir })
  t.cleanups.push(() => pages.stop())
  const srv = await call(t, () => t.H.startServer(t.ev, { env: { MIDSTUDY_FETCH_ALLOW: `127.0.0.1:${pages.port}` } }))
  if (!srv.up) throw new Error(`the server did not start: ${srv.why}`)
  // SheenChair, as the fixture library has it (no thumbnail: the planner makes one on the first page load)
  const lib = JSON.parse(fs.readFileSync(path.join(srv.dirs.library, 'library.json'), 'utf8'))
  const fx = JSON.parse(fs.readFileSync(path.join(t.repo, 'fixtures/library/library.json'), 'utf8')).items.find((i) => i.id === CHAIR.id)
  fs.mkdirSync(path.join(srv.dirs.library, CHAIR.id), { recursive: true })
  fs.copyFileSync(path.join(t.repo, 'fixtures/library', fx.assets.glb), path.join(srv.dirs.library, CHAIR.id, 'model.glb'))
  lib.items.push({ ...fx, assets: { glb: `${CHAIR.id}/model.glb`, splat: null, thumb: null } })
  fs.writeFileSync(path.join(srv.dirs.library, 'library.json'), JSON.stringify(lib, null, 2))
  // the Idol chair through POST /api/library/items (no engine: Idol is the default), as E13 makes it
  const chairJpg = fs.readFileSync(path.join(t.repo, 'fixtures/fal/speridlabs-idol/input.jpg'))
  const r = await t.H.raw(srv.base, 'POST', '/api/library/items', { headers: { 'X-Midstudy': '1', 'Content-Type': 'application/octet-stream', 'X-Midstudy-Kind': 'image',
    'X-Midstudy-Filename': 'morris-chair.jpg', 'X-Midstudy-Meta': t.H.b64json({ name: IDOL.name, id: IDOL.id, dims_cm: IDOL.dims_cm, category: 'armchair' }) }, body: chairJpg })
  const job = r.json?.job?.id && await t.H.waitFor(async () => { const j = (await t.H.api.get(srv.base, `/api/library/jobs/${r.json.job.id}`)).json; return ['done', 'failed'].includes(j?.status) ? j : null }, { timeoutMs: 300000, intervalMs: 250 })
  if (job?.status !== 'done') throw new Error(`the Idol fixture item was not made: ${r.status} ${clip(r.text, 120)} ${job?.message || ''}`)
  const scene = {}
  for (const id of [LW, 'steep-roll']) {
    const s = await t.H.seedScene(srv, id, id)
    if (!s.name || s.why) throw new Error(`could not seed ${id}: ${s.why}`)
    scene[id] = s
  }
  for (const [k, name] of ['one', 'two', 'three'].entries()) {
    const items = Array.from({ length: k + 1 }, (_, j) => ({ uid: `u${k}${j}`, id: 'probe-box', render: 'glb', position: [j * 0.6 - 0.6, 0, -2.5 - k * 0.3], rotation_y_deg: 15 * j, dims_cm: { w: 80, d: 50, h: 120 } }))
    const pr = await t.H.api.send(srv.base, 'PUT', `/api/layouts/${name}?scene=${scene['steep-roll'].name}`, { version: 1, name, items })
    if (pr.status !== 200) throw new Error(`PUT layout ${name}: ${pr.status} ${clip(pr.text, 120)}`)
  }
  t.shared.srv = { ...srv, pages, synth, scene, photo: { w: scene[LW].scene.w, h: scene[LW].scene.h } }
  t.info.scene_photo = `${scene[LW].scene.w}×${scene[LW].scene.h}`
  return t.shared.srv
}
async function browserOf(t) {
  if (!t.shared.browser) {
    t.shared.browser = await call(t, () => t.H.launchBrowser(t.ev))
    t.info.chrome = t.shared.browser.version()
  }
  return t.shared.browser
}

// --- the page --------------------------------------------------------------------------------------------------------
// Installed before any page script: long tasks, and the moment window.midstudy appears, its ready resolves, and the
// second animation frame after that (the photo drawn and presented).
function pageInit() {
  const P = (window.__perf = { lt: [], marks: {} })
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true }) } catch { /* no long tasks */ }
  const seen = (m) => {
    if (P.hooked || !m || !m.ready) return
    P.hooked = true
    P.marks.hook = performance.now()
    Promise.resolve(m.ready).then(() => {
      P.marks.ready = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => { P.marks.shown = performance.now() }))
    }, (e) => { P.marks.error = String(e) })
  }
  let v
  try { Object.defineProperty(window, 'midstudy', { configurable: true, enumerable: true, get: () => v, set: (x) => { v = x; seen(x) } }) } catch { /* poll below */ }
  const iv = setInterval(() => { seen(window.midstudy); if (P.hooked) clearInterval(iv) }, 5)
  addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style')
    s.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;animation-delay:0s!important;transition-delay:0s!important}'
    document.head.append(s)
  })
}
async function newPage(t, device = 'desktop') {
  const browser = await browserOf(t)
  const context = await browser.newContext(device === 'phone' ? t.H.PHONE : t.H.DESKTOP)
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  const errors = []
  page.on('pageerror', (e) => errors.push(clip(e.message, 200)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(clip(m.text(), 200)) })
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.addInitScript(pageInit)
  const cdp = await context.newCDPSession(page)
  const reqs = new Map()
  cdp.on('Network.requestWillBeSent', (e) => { if (!reqs.has(e.requestId)) reqs.set(e.requestId, { url: e.request.url, wall: e.wallTime * 1000, bytes: 0 }) })
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) r.bytes = e.encodedDataLength })
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) r.failed = e.errorText })
  cdp.on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) r.cached = true })
  await cdp.send('Network.enable')
  await cdp.send('Performance.enable')
  return { page, context, cdp, reqs, errors, device, close: () => context.close().catch(() => {}) }
}
// Requests started in [t0, t1] (epoch ms): count, bytes, and the part from other origins (the CDN, in v1).
function netStats(P, base, t0, t1) {
  const list = [...P.reqs.values()].filter((r) => r.wall >= t0 - 1 && r.wall <= t1 && !r.url.startsWith('data:') && !r.url.startsWith('blob:'))
  const ext = list.filter((r) => !r.url.startsWith(base))
  const sum = (a) => a.reduce((s, r) => s + (r.bytes || 0), 0)
  return { requests: list.length, kb: round(sum(list) / 1024, 1), ext_requests: ext.length, ext_kb: round(sum(ext) / 1024, 1), cached: list.filter((r) => r.cached).length, failed: list.filter((r) => r.failed).length }
}
async function heap(P) {
  try {
    await P.cdp.send('HeapProfiler.collectGarbage')
    const h = await P.cdp.send('Runtime.getHeapUsage')
    return { heap_mb: round(h.usedSize / 2 ** 20, 2), ...(Number.isFinite(h.backingStorageSize) ? { buffers_mb: round(h.backingStorageSize / 2 ** 20, 2) } : {}) }
  } catch { return {} }
}
async function perfMetrics(P) {
  try { return Object.fromEntries((await P.cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])) } catch { return {} }
}
// Navigates and waits for the shown mark. → {shown (navigation start → shown, ms), ready, hook, origin (epoch ms of
// navigation start), lt (long tasks), cpu (the main thread's script/compile/layout/style time over the load, ms)}
async function loadPlanner(P, url) {
  await P.page.goto(url, { waitUntil: 'commit', timeout: 60000 })
  await P.page.waitForFunction(() => window.__perf?.marks?.shown || window.__perf?.marks?.error, null, { timeout: 120000, polling: 50 })
  const m = await P.page.evaluate(() => ({ ...window.__perf.marks, origin: performance.timeOrigin, lt: window.__perf.lt }))
  return { ...m, cpu: cpuDelta({}, await perfMetrics(P)) } // Chrome's counters start again with each document
}
// The main thread's time in script, layout, style and all tasks (TaskOther: tasks outside those, e.g. waiting on the GPU
// process for a synchronous WebGL call), between two Performance.getMetrics readings of one document.
const cpuDelta = (a, b) => Object.fromEntries([['script_ms', 'ScriptDuration'], ['layout_ms', 'LayoutDuration'], ['style_ms', 'RecalcStyleDuration'],
  ['task_ms', 'TaskDuration'], ['task_other_ms', 'TaskOtherDuration']].filter(([, k]) => Number.isFinite(b[k])).map(([n, k]) => [n, round(((b[k] ?? 0) - (a[k] ?? 0)) * 1000, 1)]))
const ltIn = (lt, t0, t1) => { const xs = lt.filter(([s, d]) => s + d > t0 && s < t1); return { longtasks: xs.length, longtask_ms: round(xs.reduce((a, [, d]) => a + d, 0), 1) } }
// Calls window.midstudy[method](...args) timed inside the page. → {ms, value, error, longtasks, longtask_ms, t0, t1}
async function timedHook(P, method, args = [], timeoutMs = 180000) {
  return P.page.evaluate(async ({ method, args, timeoutMs }) => {
    const m = window.midstudy
    if (!m || typeof m[method] !== 'function') return { error: `hook missing: ${method}` }
    performance.clearResourceTimings()
    const t0 = performance.now()
    let value, error
    try { value = await Promise.race([m[method](...args), new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs))]) } catch (e) { error = `${method}() failed: ${e?.message || e}` }
    const t1 = performance.now()
    const lt = window.__perf.lt.filter(([s, d]) => s + d > t0 && s < t1)
    const res = performance.getEntriesByType('resource').filter((e) => e.startTime >= t0 - 1).map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd, req: e.requestStart, resp: e.responseStart }))
    return { ms: t1 - t0, t0, t1, value: value === undefined ? null : JSON.parse(JSON.stringify(value)), error, longtasks: lt.length, longtask_ms: lt.reduce((a, [, d]) => a + d, 0), res, origin: performance.timeOrigin }
  }, { method, args, timeoutMs })
}
const frames = (P, n = 2) => P.page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) }), n)

// Where the photo is drawn (CSS px), found once per target and device by the harness (screenshot registration), then
// reused: the layout at Fit doesn't change between runs. Each load is checked against a screenshot at that rect.
async function photoRect(t, P, sceneName) {
  const key = `rect-${P.device}`
  if (!t.shared[key]) {
    const s = t.shared.srv
    const m = await t.H.findPhotoOnScreen(P.page, `${s.base}/scenes/${sceneName}/photo.jpg`, s.photo.w, s.photo.h)
    if (!m?.rect || !(m.median <= 12)) throw new Error(`the photo isn't on screen (${m?.how}, median ${m?.median})`)
    t.shared[key] = { rect: m.rect, scale: m.scale, how: m.how, median: m.median }
  }
  return t.shared[key]
}
async function photoShown(t, P, sceneName) {
  const s = t.shared.srv, r = await photoRect(t, P, sceneName)
  const shot = await P.page.screenshot({ scale: 'css' })
  return P.page.evaluate(async ({ b64, url, W, H, rect }) => {
    const data = async (blob, w, h) => { const b = await createImageBitmap(blob); const c = new OffscreenCanvas(w ?? b.width, h ?? b.height), g = c.getContext('2d'); g.drawImage(b, 0, 0, c.width, c.height); return g.getImageData(0, 0, c.width, c.height) }
    const shot = await data(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const photo = await data(await (await fetch(url)).blob(), W, H)
    const sx = shot.width / innerWidth, d = []
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
      const u = (i + 0.5) / 16, v = (j + 0.5) / 16
      const X = Math.round((rect.x + u * rect.w) * sx), Y = Math.round((rect.y + v * rect.h) * sx)
      const a = (Y * shot.width + X) * 4, b = (Math.floor(v * H) * W + Math.floor(u * W)) * 4
      d.push(Math.max(...[0, 1, 2].map((c) => Math.abs(shot.data[a + c] - photo.data[b + c]))))
    }
    d.sort((p, q) => p - q)
    return d[d.length >> 1]
  }, { b64: shot.toString('base64'), url: `${s.base}/scenes/${sceneName}/photo.jpg`, W: s.photo.w, H: s.photo.h, rect: r.rect })
}

// --- suites ----------------------------------------------------------------------------------------------------------
const get = (url, timeoutMs = 1000) => new Promise((resolve) => {
  const req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', () => resolve(0))
})
const suites = {
  // spawn → first 200 on /planner/, a fresh probe library and empty scenes each time
  async server(t) {
    const port = await t.H.freePort()
    const d = path.join(t.out, `server-start-${RUN.i}`)
    const dirs = { scenes: `${d}/scenes`, layouts: `${d}/layouts`, renders: `${d}/renders`, library: `${d}/library` }
    for (const p of Object.values(dirs)) fs.mkdirSync(p, { recursive: true })
    t.H.writeProbeLibrary(dirs.library)
    fs.writeFileSync(`${dirs.library}/costs.csv`, 'date,id,engine,cost_usd,mock,input\n')
    const cmd = serverCommand(t)
    const args = ['--port', String(port), '--host', '127.0.0.1', '--scenes-dir', dirs.scenes, '--layouts-dir', dirs.layouts, '--renders-dir', dirs.renders,
      '--library-dir', dirs.library, '--costs-file', `${dirs.library}/costs.csv`, '--calib', t.H.STUB_CALIB, '--daily-spend-usd', '0']
    const env = mockEnv(t, { MIDSTUDY_CALIB_MOCK: path.join(t.repo, 'fixtures/calib') })
    let log = ''
    const t0 = now()
    const proc = spawn(cmd[0], [...cmd.slice(1), ...args], { cwd: t.repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let exited = null
    proc.on('exit', (c, s) => { exited = c ?? s })
    proc.stdout.on('data', (b) => { log += b }); proc.stderr.on('data', (b) => { log += b })
    let ms = null
    while (exited == null && now() - t0 < 30000) {
      if (await get(`http://127.0.0.1:${port}/planner/`) === 200) { ms = now() - t0; break }
      await sleep(5)
    }
    proc.kill('SIGTERM')
    for (let i = 0; i < 50 && exited == null; i++) await sleep(50)
    if (exited == null) proc.kill('SIGKILL')
    fs.rmSync(d, { recursive: true, force: true })
    record(t, 'server_start', ms, { cmd: cmd.slice(0, 2).join(' ') }, ms == null ? `no 200 on /planner/ (exit ${exited}): ${clip(log.trim().split('\n').slice(-3).join(' | '), 200)}` : null)
  },

  async api(t) {
    const s = await mainServer(t)
    const routes = { scenes: '/api/scenes', library: '/api/library', layouts: `/api/layouts?scene=${s.scene['steep-roll'].name}` }
    for (const [k, p] of Object.entries(routes)) {
      const xs = []
      let bad = null
      for (let i = 0; i < 200; i++) {
        const t0 = now()
        const r = await t.H.api.get(s.base, p)
        xs.push(now() - t0)
        if (r.status !== 200 && !bad) bad = `${p}: ${r.status || r.error}`
      }
      record(t, `api_${k}_p50`, quantile(xs, 0.5), { max: round(Math.max(...xs), 2) }, bad)
      record(t, `api_${k}_p95`, quantile(xs, 0.95), {}, bad)
    }
  },

  async product(t) {
    const s = await mainServer(t)
    const cases = Object.entries(s.synth.cases).filter(([, c]) => A.productAll || !(c.expect?.max_s >= 20 && /20 s/.test(c.expect?.error || '')))
    t.info.product_cases = cases.length
    const per = {}
    let bad = null
    for (const [id, c] of cases) {
      const t0 = now()
      const r = await t.H.api.send(s.base, 'POST', '/api/library/product', { url: `${s.pages.base}${c.path}`, llm: false }, { timeoutMs: 90000 })
      per[id] = round(now() - t0, 1)
      if (r.status !== (c.expect?.status ?? 200) && !bad) bad = `${id}: ${r.status || r.error} (expected ${c.expect?.status})`
    }
    const xs = Object.values(per)
    const worst = Object.entries(per).sort((a, b) => b[1] - a[1])[0]
    for (const [n, v] of [['product_read_p50', quantile(xs, 0.5)], ['product_read_p95', quantile(xs, 0.95)], ['product_read_max', Math.max(...xs)]]) {
      record(t, n, v, n === 'product_read_max' ? { pages: xs.length } : {}, null)
    }
    const last = t.metrics.product_read_max.samples.at(-1)
    last.extra.slowest = worst?.[0]
    last.per_page = per
    if (bad) last.extra.unexpected = bad // an unexpected status is reported, not counted as a failure: E14 judges answers
  },

  async cli(t) {
    if (!t.shared.cliReady) {
      const cmd = addCommand(t)
      if (cmd[0] === 'uv') sh('uv', ['sync', '-q', '--project', 'pipeline'], t.repo, 900000)
      // the rug: a plain picture of a rug from above, as E13 makes it
      const rug = path.join(t.out, 'rug-picture.jpg')
      execFileSync(path.join(SELF, 'evals/py'), ['-c', `from PIL import Image, ImageDraw
im = Image.new('RGB', (800, 800), (255, 255, 255)); d = ImageDraw.Draw(im)
d.rectangle([150, 250, 649, 549], fill=(40, 70, 150))
for x in range(170, 640, 40): d.rectangle([x, 270, x + 15, 529], fill=(230, 220, 200))
im.save(${JSON.stringify(rug)}, quality=92)`], { stdio: 'ignore' })
      t.shared.cliReady = { cmd, rug }
    }
    const { cmd, rug } = t.shared.cliReady
    const jobs = {
      idol: [path.join(t.repo, 'fixtures/fal/speridlabs-idol/input.jpg'), '--engine', 'idol', '--name', 'Idol Chair', '--id', 'idol-chair', '--dims', '80x90x95'],
      sam3d: [path.join(t.repo, 'fixtures/fal/sam-3-3d-objects/input.jpg'), '--engine', 'sam3d', '--prompt', 'chair', '--name', 'SAM Chair', '--id', 'sam-chair', '--dims', '75x80x95'],
      glb: [path.join(t.repo, 'fixtures/models/SheenChair.glb'), '--engine', 'glb', '--name', 'Sheen', '--id', 'sheen', '--dims', '60x65x85'],
      rug: [rug, '--engine', 'rug', '--name', 'Flat Rug', '--id', 'flat-rug', '--dims', '100x70x1'],
    }
    const env = cliEnv(t)
    for (const [engine, args] of Object.entries(jobs)) {
      const lib = path.join(t.out, `cli-${RUN.i}-${engine}`)
      fs.rmSync(lib, { recursive: true, force: true })
      const r = await timedSpawn(cmd, [...args, '--library', lib], { cwd: t.repo, env, timeoutMs: 600000 })
      let summary = null
      try { summary = JSON.parse(r.stdout.trim().split('\n').at(-1)) } catch { /* below */ }
      const err = r.code !== 0 ? `exit ${r.code}: ${clip(r.stderr.trim().split('\n').at(-1), 200)}` : summary?.engine !== engine ? `no JSON summary: ${clip(r.stdout.trim().split('\n').at(-1), 120)}` : null
      record(t, `add_cli_${engine}`, r.ms, {}, err)
      fs.rmSync(lib, { recursive: true, force: true })
    }
  },

  async load(t) {
    const s = await mainServer(t)
    const name = s.scene[LW].name
    const url = `${s.base}/planner/?scene=${encodeURIComponent(name)}`
    for (const device of ['desktop', 'phone']) {
      const metric = `planner_load_${device}`
      const P = await newPage(t, device)
      try {
        try { await measuredLoad(t, P, await loadPlanner(P, url), metric, name) } catch (e) { fail(t, [metric], e) }
        // the same page again in the same context: what a returning user waits for (the CDN files cached, ours not)
        if (device === 'desktop') { try { await measuredLoad(t, P, await loadPlanner(P, url), 'planner_load_desktop_warm', name) } catch (e) { fail(t, ['planner_load_desktop_warm'], e) } }
      } finally { await P.close() }
    }
  },

  async scene(t) {
    const s = await mainServer(t)
    const name = s.scene[LW].name
    const P = await newPage(t, 'desktop')
    try {
      const m = await loadPlanner(P, `${s.base}/planner/`)
      if (m.error) throw new Error(`midstudy.ready: ${m.error}`)
      const st = await P.page.evaluate(() => window.midstudy.getState()?.scene?.name ?? null)
      if (st) throw new Error(`the planner opened ${st}, not the Scenes page`)
      await frames(P, 3)
      const before = await perfMetrics(P)
      const r = await timedHook(P, 'openScene', [name])
      const cpu = cpuDelta(before, await perfMetrics(P))
      const opened = await P.page.evaluate(() => window.midstudy.getState()?.scene?.name ?? null)
      const net = netStats(P, s.base, r.origin + r.t0, r.origin + r.t1)
      record(t, 'scene_open', r.ms, { longtasks: r.longtasks, longtask_ms: round(r.longtask_ms, 1), ...cpu, requests: net.requests, kb: net.kb },
        r.error || (opened !== name ? `getState().scene is ${opened}` : null))
    } catch (e) { fail(t, ['scene_open'], e) } finally { await P.close() }
  },

  // One fresh scene per run (a copy of living-wide: no renders, no layouts), in a fresh page; the steps share the page.
  async edit(t) {
    const s = await mainServer(t)
    const seeded = await t.H.seedScene(s, LW, `edit ${RUN.i}`)
    const names = Object.keys(METRICS).filter((n) => METRICS[n].suite === 'edit')
    if (!seeded.name || seeded.why) return fail(t, names, `could not seed the scene: ${seeded.why}`)
    const name = seeded.name
    const P = await newPage(t, 'desktop')
    const done = new Set()
    const rec = (n, v, extra, err) => { done.add(n); record(t, n, v, extra, err) }
    try {
      const m = await loadPlanner(P, `${s.base}/planner/?scene=${encodeURIComponent(name)}`)
      if (m.error) throw new Error(`midstudy.ready: ${m.error}`)
      // the first open saves the scene's thumbnail in the background: let it finish so it doesn't land in a measurement
      await t.H.waitFor(async () => (await t.H.api.get(s.base, `/api/scenes/${name}`)).json?.thumb_url, { timeoutMs: 15000, intervalMs: 100 })
      await settle(P)

      const a = await timedHook(P, 'addItem', ['probe-box'])
      rec('add_item_glb', a.ms, { longtask_ms: round(a.longtask_ms, 1) }, a.error)
      const uid = a.value
      const st0 = await P.page.evaluate(() => window.midstudy.getState())
      const box = st0.items.find((i) => i.uid === uid)
      const c = await timedHook(P, 'addItem', [CHAIR.id, { position: [box.position[0] + 1.1, 0, box.position[2] - 0.6], rotation_y_deg: -20 }])
      rec('add_item_glb_textured', c.ms, { longtask_ms: round(c.longtask_ms, 1) }, c.error)
      await settle(P)

      const dr = await drag(t, P, name, uid)
      rec('drag_frames_p50', dr.p50, { frames: dr.frames, moves: dr.moves, drag_ms: dr.ms, moved_cm: dr.moved_cm, longtask_ms: dr.longtask_ms }, dr.error)
      rec('drag_frames_p95', dr.p95, { max: dr.max }, dr.error)
      await settle(P)

      for (const [key, o] of [['render_capture', {}], ['render_keep_room', { keepRoom: true }]]) {
        const r = await timedHook(P, 'renderView', [{ model: 'nano-banana', ...o }])
        const post = r.res?.find((e) => /\/api\/render(\?|$)/.test(new URL(e.name).pathname + new URL(e.name).search))
        const server = post ? post.end - post.start : null
        const err = r.error || (r.value?.mock !== true ? `not a mock render: ${clip(JSON.stringify(r.value), 120)}` : post ? null : 'no POST /api/render seen')
        rec(key, r.ms, { longtask_ms: round(r.longtask_ms, 1), keep_room: !!r.value?.keep_room, aligned: r.value?.aligned?.applied ?? null }, err)
        rec(`${key}_client`, server == null ? null : r.ms - server, {}, err)
        rec(`${key}_server`, server, { ttfb: post ? round(post.resp - post.req, 1) : null }, err)
        await settle(P)
      }

      // the first splat piece: addItem's answer, then until the view is idle again (Spark generates and sorts the splats
      // and the splat pass draws them: three 2-frame round trips in a row under 150 ms), from the end of the add
      const before = Date.now()
      const sp = await P.page.evaluate(async (id) => {
        const t0 = performance.now()
        let uid = null, error = null
        try { uid = await window.midstudy.addItem(id) } catch (e) { error = String(e?.message || e) }
        const t1 = performance.now()
        let quiet = 0, quietFrom = t1
        while (quiet < 3 && performance.now() - t1 < 120000) {
          const a = performance.now()
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          if (performance.now() - a < 150) { if (!quiet++) quietFrom = a } else quiet = 0
        }
        const lt = window.__perf.lt.filter(([s, d]) => s + d > t0 && s < t1)
        const lt2 = window.__perf.lt.filter(([s, d]) => s + d > t1 && s < quietFrom)
        return { add: t1 - t0, first: quiet >= 3 ? quietFrom - t1 : null, uid, error, lt: lt.reduce((a, [, d]) => a + d, 0), lt2: lt2.reduce((a, [, d]) => a + d, 0) }
      }, IDOL.id)
      const net = netStats(P, s.base, before - 5, Date.now())
      const st1 = await P.page.evaluate(() => window.midstudy.getState())
      const idol = st1.items.find((i) => i.uid === sp.uid)
      const noSplat = idol?.render !== 'splat' ? `drawn as ${idol?.render}` : null
      rec('add_item_splat', sp.add, { longtask_ms: round(sp.lt, 1), splats: idol?.splats ?? null, requests: net.requests, kb: net.kb, ext_kb: net.ext_kb }, sp.error || noSplat)
      rec('splat_first_frame', sp.first, { longtask_ms: round(sp.lt2, 1) }, sp.error || noSplat || (sp.first == null ? 'the view never went idle in 120 s' : null))
      await settle(P, 300)

      // a drag with the splat in view: every frame redraws the splat pass (meshes hide splats), seconds a frame in the GPU
      // process on SwiftShader. A time-boxed drag gets two moves in, so this one is a fixed 5 moves (paced at 16 ms, each
      // waiting for the page to take it), timed until the last one is drawn: ms per move.
      const ds = await dragMoves(t, P, name, uid, 5)
      rec('drag_splat', ds.ms / 5, { total_ms: ds.ms, frames: ds.frames, frame_p50: ds.p50, max_frame: ds.max, moved_cm: ds.moved_cm, longtask_ms: ds.longtask_ms }, ds.error || noSplat)
      await settle(P, 300)

      const rs = await timedHook(P, 'renderView', [{ model: 'nano-banana' }], 300000)
      rec('render_capture_splat', rs.ms, { longtask_ms: round(rs.longtask_ms, 1) }, rs.error || (idol?.render !== 'splat' ? 'no splat in view' : null))
      if (P.errors.length) t.info[`page_errors_edit_${RUN.i}`] = P.errors.slice(0, 5)
    } catch (e) {
      fail(t, names.filter((n) => !done.has(n)), e)
    } finally { await P.close() }
  },

  // A fresh server with the real calibration each run: two uploads of the same golden photo, one after the other.
  // Without PYTHONDONTWRITEBYTECODE (the dev shell sets it): torch's ~2,500 modules would be compiled from source on
  // every calibration, which an installed midstudy-calib (the Nix package ships bytecode) never does.
  async calib(t) {
    if (!t.shared.calibReady) { sh('uv', ['sync', '-q', '--project', 'calib'], t.repo, 1800000); t.shared.calibReady = true }
    const srv = await withEnv({ PYTHONDONTWRITEBYTECODE: null }, () => call(t, () => t.H.startServer(t.ev, { calib: t.H.REAL_CALIB, calibMock: false })))
    try {
      if (!srv.up) throw new Error(`the server did not start: ${srv.why}`)
      const bytes = fs.readFileSync(path.join(t.repo, 'fixtures/scenes', LW, 'photo.jpg'))
      for (const n of ['calib_first', 'calib_second']) try {
        const t0 = now()
        const r = await t.H.uploadScene(srv.base, bytes, { filename: `${LW}.jpg`, title: n })
        const id = r.json?.job?.id ?? r.json?.job
        const job = id && await t.H.waitFor(async () => { const j = (await t.H.api.get(srv.base, `/api/scenes/jobs/${id}`)).json; return ['done', 'failed'].includes(j?.status) ? j : null }, { timeoutMs: 900000, intervalMs: 50 })
        const ms = now() - t0
        const sc = job ? (await t.H.api.get(srv.base, `/api/scenes/${r.json.scene}`)).json : null
        // the tool's own timings (calib.json): MoGe's load and inference, the floor fit, and its total
        const mg = sc?.calib?.moge || {}
        const sec = (v) => (Number.isFinite(v) ? round(v * 1000, 0) : null)
        record(t, n, ms, { load_ms: sec(mg.load_s), infer_ms: sec(mg.infer_s), floor_fit_ms: sec(mg.floor_fit_s), tool_ms: sec(sc?.calib?.elapsed_s) },
          r.status !== 202 ? `POST /api/scenes: ${r.status} ${clip(r.text, 120)}` : job?.status !== 'done' ? `job ${job?.status ?? 'timed out'}: ${job?.message ?? ''}`
          : sc?.calib?.source !== 'moge-2' ? `calib.source is ${sc?.calib?.source}` : null)
      } catch (e) { fail(t, [n], e) }
    } finally { await srv.stop?.() }
  },
}

async function measuredLoad(t, P, m, metric, name) {
  if (m.error) throw new Error(`midstudy.ready: ${m.error}`)
  const s = t.shared.srv
  const st = await P.page.evaluate(() => window.midstudy.getState()?.scene?.name ?? null)
  const net = netStats(P, s.base, m.origin, m.origin + m.shown)
  const lt = ltIn(m.lt, 0, m.shown)
  const hp = await heap(P)
  const diff = await photoShown(t, P, name)
  const err = st !== name ? `getState().scene is ${st}` : !(diff <= 12) ? `the photo isn't on screen at the expected place (median difference ${diff})` : null
  record(t, metric, m.shown, { ready: round(m.ready, 1), hook: round(m.hook, 1), ...net, ...hp, ...lt, ...m.cpu, photo_diff: diff }, err)
}
async function settle(P, ms = 250) { await frames(P, 2); await sleep(ms); await frames(P, 2) }

// A 2 s mouse drag of the item (press on it, 15 % of the photo's width left, then back), moves dispatched every 16 ms of
// wall time; the page records every animation frame and long task meanwhile.
async function drag(t, P, sceneName, uid) {
  try {
    const r = await photoRect(t, P, sceneName)
    const sr = await P.page.evaluate((uid) => window.midstudy.getScreenRect(uid), uid)
    if (!sr) return { error: 'getScreenRect is null' }
    const x0 = r.rect.x + (sr.x + sr.w / 2) * r.scale, y0 = r.rect.y + (sr.y + sr.h * 0.6) * r.scale
    const dx = -0.15 * r.rect.w
    const pos0 = await P.page.evaluate((uid) => window.midstudy.getState().items.find((i) => i.uid === uid).position, uid)
    await P.page.evaluate(() => {
      const f = (window.__perf.frames = [])
      window.__perf.framesOn = true
      const tick = (ts) => { if (!window.__perf.framesOn) return; f.push(ts); requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await P.page.mouse.move(x0, y0)
    await P.page.mouse.down()
    const T = 2000, t0 = now()
    let moves = 0, mid = null
    for (;;) {
      const e = now() - t0
      if (e >= T) break
      const u = e / T, k = u < 0.5 ? u * 2 : 2 - u * 2
      await P.page.mouse.move(x0 + dx * k, y0)
      moves++
      if (!mid && u >= 0.5) mid = await P.page.evaluate((uid) => window.midstudy.getState().items.find((i) => i.uid === uid).position, uid)
      const next = t0 + moves * 16
      if (next > now()) await sleep(next - now())
    }
    await P.page.mouse.move(x0, y0)
    await P.page.mouse.up()
    const ms = now() - t0
    const f = await P.page.evaluate(() => { window.__perf.framesOn = false; const f = window.__perf.frames; const lt = window.__perf.lt.filter(([s, d]) => s + d > f[0] && s < f.at(-1)); return { f, lt: lt.reduce((a, [, d]) => a + d, 0) } })
    const iv = f.f.slice(1).map((x, i) => x - f.f[i])
    const moved = mid ? Math.hypot(mid[0] - pos0[0], mid[2] - pos0[2]) * 100 : 0
    return { p50: quantile(iv, 0.5), p95: quantile(iv, 0.95), max: round(Math.max(...iv), 1), frames: iv.length, moves, ms: round(ms, 0), moved_cm: round(moved, 1), longtask_ms: round(f.lt, 1),
      error: iv.length < 2 ? 'fewer than 2 frames' : moved < 5 ? `the drag didn't move the piece (${round(moved, 1)} cm at mid-drag)` : null }
  } catch (e) { return { error: String(e?.message || e) } }
}

// A drag of a fixed number of moves (10 % of the photo's width to the left, paced at 16 ms, each awaited), timed from the
// press until the last move's frame is drawn; the piece goes back where it was afterwards (by the hook).
async function dragMoves(t, P, sceneName, uid, n) {
  try {
    const r = await photoRect(t, P, sceneName)
    const sr = await P.page.evaluate((uid) => window.midstudy.getScreenRect(uid), uid)
    if (!sr) return { error: 'getScreenRect is null' }
    const x0 = r.rect.x + (sr.x + sr.w / 2) * r.scale, y0 = r.rect.y + (sr.y + sr.h * 0.6) * r.scale, dx = -0.1 * r.rect.w
    const st0 = await P.page.evaluate((uid) => window.midstudy.getState().items.find((i) => i.uid === uid), uid)
    await P.page.evaluate(() => {
      const f = (window.__perf.frames = [])
      window.__perf.framesOn = true
      const tick = (ts) => { if (!window.__perf.framesOn) return; f.push(ts); requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await P.page.mouse.move(x0, y0)
    const t0 = now()
    await P.page.mouse.down()
    for (let k = 1; k <= n; k++) {
      await P.page.mouse.move(x0 + (dx * k) / n, y0)
      const next = t0 + k * 16
      if (next > now()) await sleep(next - now())
    }
    await frames(P, 2)
    const ms = now() - t0
    const pos = await P.page.evaluate((uid) => window.midstudy.getState().items.find((i) => i.uid === uid).position, uid)
    await P.page.mouse.up()
    const f = await P.page.evaluate(() => { window.__perf.framesOn = false; const f = window.__perf.frames; const lt = window.__perf.lt.filter(([s, d]) => s + d > f[0] && s < f.at(-1)); return { f, lt: lt.reduce((a, [, d]) => a + d, 0) } })
    await P.page.evaluate(({ uid, p, rot }) => window.midstudy.moveItem(uid, { position: p, rotation_y_deg: rot }), { uid, p: st0.position, rot: st0.rotation_y_deg })
    const iv = f.f.slice(1).map((x, i) => x - f.f[i])
    const moved = Math.hypot(pos[0] - st0.position[0], pos[2] - st0.position[2]) * 100
    return { ms: round(ms, 1), frames: iv.length, p50: round(quantile(iv, 0.5), 1), max: round(Math.max(...iv), 1), moved_cm: round(moved, 1), longtask_ms: round(f.lt, 1),
      error: moved < 5 ? `the drag didn't move the piece (${round(moved, 1)} cm)` : null }
  } catch (e) { return { error: String(e?.message || e) } }
}

function timedSpawn(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = now()
    let stdout = '', stderr = ''
    const p = spawn(cmd[0], [...cmd.slice(1), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const to = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', (b) => { stdout += b }); p.stderr.on('data', (b) => { stderr += b })
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, ms: now() - t0, stdout, stderr: String(e) }) })
    p.on('close', (code) => { clearTimeout(to); resolve({ code, ms: now() - t0, stdout, stderr }) })
  })
}

// --- profiles (--profile) --------------------------------------------------------------------------------------------
// Chrome's CPU profiler (main thread) around the biggest browser costs, and the furniture CLI under cProfile (Python) or
// --cpu-prof (Node). Top functions by self time go to the console and evals/out/perf/profiles/summary.json.
function topSelf(profile, n = 15) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]))
  const self = new Map()
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0) / 1000
  profile.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0) / 1000) })
  const agg = new Map()
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame
    const where = cf.url ? `${cf.url.replace(/^https?:\/\/[^/]+/, '').replace(/^.*\/npm\//, 'npm:')}:${cf.lineNumber + 1}` : ''
    const key = `${cf.functionName || '(anonymous)'} ${where}`.trim()
    agg.set(key, (agg.get(key) || 0) + ms)
  }
  return { total_ms: round(total, 0), top: [...agg].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ fn: k, self_ms: round(ms, 1), pct: round((100 * ms) / total, 1) })) }
}
// A Chrome trace's self time per thread and event name; summarized as how busy the GPU process's main thread was
// (SwiftShader executing WebGL command buffers) and how long the renderer and compositor waited on it.
function traceBusy(buf) {
  const tr = JSON.parse(buf.toString())
  const evs = tr.traceEvents || tr
  const names = new Map()
  for (const e of evs) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name)
  const xs = evs.filter((e) => e.ph === 'X' && e.dur > 0).sort((a, b) => a.ts - b.ts || b.dur - a.dur)
  const stacks = new Map(), self = new Map()
  for (const e of xs) {
    const k = `${e.pid}:${e.tid}`, st = stacks.get(k) || []
    while (st.length && st.at(-1).end <= e.ts) st.pop()
    if (st.length) st.at(-1).child += e.dur
    const node = { name: e.name, dur: e.dur, end: e.ts + e.dur, child: 0, thread: names.get(k) || k }
    st.push(node); stacks.set(k, st)
    ;(self.get(node.thread) || self.set(node.thread, []).get(node.thread)).push(node)
  }
  const top = (th, n = 6) => {
    const m = new Map()
    for (const x of self.get(th) || []) m.set(x.name, (m.get(x.name) || 0) + (x.dur - x.child) / 1000)
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, round(v, 0)])
  }
  const sum = (th, re) => round((self.get(th) || []).filter((x) => re.test(x.name)).reduce((a, x) => a + (x.dur - x.child) / 1000, 0), 0)
  return { gpu_busy_ms: sum('CrGpuMain', /CommandBufferService|Decoder|GPUTask|DoLinkProgram|Raster/), renderer_wait_gpu_ms: sum('CrRendererMain', /WaitForGetOffset|WaitForToken|WaitSync/),
    compositor_wait_gpu_ms: sum('Compositor', /WaitForGetOffset|WaitForToken/), gpu_top: top('CrGpuMain'), renderer_top: top('CrRendererMain') }
}
async function profileTarget(t) {
  const dir = path.join(OUT, 'profiles', t.label)
  fs.mkdirSync(dir, { recursive: true })
  const summary = {}
  const s = await mainServer(t)
  const browser = await browserOf(t)
  const prof = async (P, label, fn) => {
    await P.cdp.send('Profiler.enable')
    await P.cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await browser.startTracing(P.page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'gpu', 'toplevel'] })
    await P.cdp.send('Profiler.start')
    let note = null
    try { note = await fn() } finally {
      const { profile } = await P.cdp.send('Profiler.stop')
      const trace = await browser.stopTracing()
      fs.writeFileSync(path.join(dir, `${label}.cpuprofile`), JSON.stringify(profile))
      fs.writeFileSync(path.join(dir, `${label}.trace.json`), trace)
      let busy = {}
      try { busy = traceBusy(trace) } catch (e) { busy = { error: String(e) } }
      summary[label] = { ...topSelf(profile), note, trace: busy }
      console.log(`\nprofile ${t.label} ${label} (${summary[label].total_ms} ms sampled${note ? `, ${note}` : ''}; GPU process busy ${busy.gpu_busy_ms} ms, renderer waited on it ${busy.renderer_wait_gpu_ms} ms, compositor ${busy.compositor_wait_gpu_ms} ms):`)
      for (const x of summary[label].top) console.log(`  ${String(x.self_ms).padStart(8)} ms ${String(x.pct).padStart(5)} %  ${x.fn}`)
      console.log(`  GPU main thread: ${(busy.gpu_top || []).map(([k, v]) => `${k} ${v} ms`).join(' | ')}`)
    }
  }
  // the browser: a warm-up load first (the GPU process's shader cache, as in the measured runs), then the profiled ones
  const scene = await t.H.seedScene(s, LW, 'profile')
  { const P = await newPage(t); await loadPlanner(P, `${s.base}/planner/?scene=${scene.name}`); await P.close() }
  {
    const P = await newPage(t)
    await prof(P, 'planner_load_desktop', async () => { const m = await loadPlanner(P, `${s.base}/planner/?scene=${scene.name}`); return `shown at ${round(m.shown, 0)} ms` })
    await P.close()
  }
  {
    const P = await newPage(t)
    await loadPlanner(P, `${s.base}/planner/`)
    await frames(P, 3)
    await prof(P, 'scene_open', async () => `${round((await timedHook(P, 'openScene', [scene.name])).ms, 0)} ms`)
    const a = await timedHook(P, 'addItem', ['probe-box'])
    await timedHook(P, 'addItem', [CHAIR.id, { position: [0.8, 0, -3.2] }])
    await settle(P)
    await prof(P, 'render_keep_room', async () => `${round((await timedHook(P, 'renderView', [{ model: 'nano-banana', keepRoom: true }])).ms, 0)} ms`)
    await prof(P, 'add_item_splat', async () => `${round((await timedHook(P, 'addItem', [IDOL.id])).ms, 0)} ms`)
    await settle(P, 600)
    await prof(P, 'render_capture_splat', async () => `${round((await timedHook(P, 'renderView', [{ model: 'nano-banana' }], 300000)).ms, 0)} ms`)
    void a
    await P.close()
  }
  // the CLI
  const cmd = addCommand(t)
  const env = cliEnv(t)
  const jobs = {
    idol: [path.join(t.repo, 'fixtures/fal/speridlabs-idol/input.jpg'), '--engine', 'idol', '--name', 'Idol Chair', '--id', 'idol-chair', '--dims', '80x90x95'],
    sam3d: [path.join(t.repo, 'fixtures/fal/sam-3-3d-objects/input.jpg'), '--engine', 'sam3d', '--prompt', 'chair', '--name', 'SAM Chair', '--id', 'sam-chair', '--dims', '75x80x95'],
  }
  for (const [engine, args] of Object.entries(jobs)) {
    const lib = path.join(dir, `cli-${engine}`)
    fs.rmSync(lib, { recursive: true, force: true })
    let r, top
    if (cmd[0] === 'uv') {
      const out = path.join(dir, `add_cli_${engine}.pstats`)
      const pre = cmd.slice(0, cmd.indexOf('midstudy-add'))
      r = await timedSpawn([...pre, 'python', '-m', 'cProfile', '-o', out, '-m', 'midstudy_pipeline.cli'], [...args, '--library', lib], { cwd: t.repo, env, timeoutMs: 600000 })
      top = sh('uv', ['run', '--project', 'pipeline', 'python', '-c', `import pstats, json
s = pstats.Stats(${JSON.stringify(out)}); tot = s.total_tt; rows = sorted(s.stats.items(), key=lambda kv: -kv[1][2])[:15]
print(json.dumps({"total_ms": round(tot * 1000), "top": [{"fn": f"{fn[2]} {fn[0].split('site-packages/')[-1].split('midstudy_pipeline/')[-1]}:{fn[1]}", "self_ms": round(v[2] * 1000, 1), "pct": round(100 * v[2] / tot, 1), "calls": v[1]} for fn, v in rows]}))`], t.repo)
      try { top = JSON.parse(top) } catch { top = { error: top } }
    } else if (cmd[0] === 'node') {
      const pdir = path.join(dir, `add_cli_${engine}`)
      r = await timedSpawn(['node', '--cpu-prof', `--cpu-prof-dir=${pdir}`, ...cmd.slice(1)], [...args, '--library', lib], { cwd: t.repo, env, timeoutMs: 600000 })
      const f = fs.existsSync(pdir) ? fs.readdirSync(pdir).find((x) => x.endsWith('.cpuprofile')) : null
      top = f ? topSelf(JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) : { error: 'no .cpuprofile written' }
    } else top = { error: `can't profile ${cmd.join(' ')}` }
    summary[`add_cli_${engine}`] = { wall_ms: round(r?.ms, 0), code: r?.code, ...top }
    console.log(`\nprofile ${t.label} add_cli_${engine} (${round(r?.ms, 0)} ms wall, exit ${r?.code}):`)
    for (const x of top.top || []) console.log(`  ${String(x.self_ms).padStart(8)} ms ${String(x.pct).padStart(5)} %  ${x.fn}${x.calls ? ` (${x.calls} calls)` : ''}`)
    if (top.error) console.log(`  ${clip(top.error, 300)}`)
    fs.rmSync(lib, { recursive: true, force: true })
  }
  // the product page reader: v1's Python reader in-process (evals/perf/profile_product.py); the slowest pages
  if (fs.existsSync(path.join(t.repo, 'planner/product_page.py'))) {
    const paths = ['/huge', '/gzip-bomb', '/digits', '/products/oak-writing-desk']
    const r = await timedSpawn(['python3', path.join(SELF, 'evals/perf/profile_product.py'), t.repo, s.pages.base, path.join(dir, 'product')], paths,
      { cwd: t.repo, env: mockEnv(t, { MIDSTUDY_FETCH_ALLOW: `127.0.0.1:${s.pages.port}` }), timeoutMs: 300000 })
    let res = null
    try { res = JSON.parse(r.stdout.trim().split('\n').at(-1)) } catch { console.log(`\nprofile ${t.label} product_read: ${clip(r.stderr || r.stdout, 300)}`) }
    for (const [p, x] of Object.entries(res || {})) {
      summary[`product_read ${p}`] = x
      console.log(`\nprofile ${t.label} product_read ${p} (${x.wall_ms} ms, status ${x.status}):`)
      for (const y of x.top) console.log(`  ${String(y.self_ms).padStart(8)} ms ${String(y.pct).padStart(5)} %  ${y.fn} (${y.calls} calls)`)
    }
  } else summary.product_read = { note: 'no planner/product_page.py: profile the server process itself (node --cpu-prof)' }
  // one real calibration (MoGe-2) under cProfile, warm bytecode as in the calib suite
  if (A.withCalib && fs.existsSync(path.join(t.repo, 'calib/pyproject.toml'))) {
    const out = path.join(dir, 'calib_run.pstats'), sc = path.join(dir, 'calib-scene')
    fs.rmSync(sc, { recursive: true, force: true })
    const env = mockEnv(t, { PYTHONDONTWRITEBYTECODE: null, MIDSTUDY_CALIB_MOCK: null })
    const photo = path.join(t.repo, 'fixtures/scenes', LW, 'photo.jpg')
    await timedSpawn(['uv', 'run', '--project', 'calib', 'midstudy-calib'], ['run', photo, '--out', `${sc}-warm`], { cwd: t.repo, env, timeoutMs: 900000 })
    const r = await timedSpawn(['uv', 'run', '--project', 'calib', 'python', '-m', 'cProfile', '-o', out, '-m', 'midstudy_calib.cli'], ['run', photo, '--out', sc], { cwd: t.repo, env, timeoutMs: 900000 })
    let top = sh('uv', ['run', '--project', 'calib', 'python', '-c', `import pstats, json
s = pstats.Stats(${JSON.stringify(out)}); tot = s.total_tt
self = sorted(s.stats.items(), key=lambda kv: -kv[1][2])[:15]
cum = {fn[2]: v[3] for fn, v in s.stats.items() if fn[2] in ("load", "infer", "_infer", "_moge", "fit", "run", "ingest", "_fit_light", "_torch", "from_pretrained")}
print(json.dumps({"total_ms": round(tot * 1000), "cumulative_ms": {k: round(v * 1000) for k, v in cum.items()}, "top": [{"fn": f"{fn[2]} {fn[0].split('site-packages/')[-1]}:{fn[1]}", "self_ms": round(v[2] * 1000, 1), "pct": round(100 * v[2] / tot, 1), "calls": v[1]} for fn, v in self]}))`], t.repo, 120000)
    try { top = JSON.parse(top) } catch { top = { error: top } }
    summary.calib_run = { wall_ms: round(r.ms, 0), code: r.code, ...top }
    console.log(`\nprofile ${t.label} calib_run (${round(r.ms, 0)} ms wall, exit ${r.code}; cumulative ${JSON.stringify(top.cumulative_ms)}):`)
    for (const x of top.top || []) console.log(`  ${String(x.self_ms).padStart(8)} ms ${String(x.pct).padStart(5)} %  ${x.fn} (${x.calls} calls)`)
    fs.rmSync(sc, { recursive: true, force: true }); fs.rmSync(`${sc}-warm`, { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

// --- reports ---------------------------------------------------------------------------------------------------------
const fmtV = (v, unit = 'ms') => (v == null ? '—' : unit === 'ms' ? (v >= 1000 ? `${round(v / 1000, 2)} s` : `${round(v, v < 10 ? 2 : 1)} ms`) : `${round(v, 2)}`)
const pct = (x) => (x == null ? '—' : `${round(100 * x, 1)} %`)
function noteOf(name, s) {
  const e = s.extra || {}
  if (name.startsWith('planner_load')) return `${e.requests} req, ${e.kb} KB (${e.ext_requests} ext, ${e.ext_kb} KB), heap ${e.heap_mb} MB, ready ${e.ready} ms, long tasks ${e.longtask_ms} ms, main thread: script ${e.script_ms}, other ${e.task_other_ms} ms`
  if (name === 'scene_open') return `long tasks ${e.longtasks} / ${e.longtask_ms} ms, script ${e.script_ms} ms, task ${e.task_ms} ms`
  if (name === 'add_item_splat') return `${e.splats} splats, ${e.requests} req, ${e.kb} KB (${e.ext_kb} KB ext)`
  if (name === 'drag_frames_p50') return `${e.frames} frames, ${e.moves} moves in ${e.drag_ms} ms, long tasks ${e.longtask_ms} ms`
  if (name === 'drag_splat') return `${e.total_ms} ms for 5 moves, ${e.frames} frames (p50 ${e.frame_p50} ms), long tasks ${e.longtask_ms} ms`
  if (METRICS[name]?.info) return `informational${e.max ? `, max ${e.max} ms` : ''}`
  if (name === 'product_read_max') return `${e.pages} pages`
  if (name.endsWith('_server') && e.ttfb != null) return `ttfb ${e.ttfb} ms`
  if (name.startsWith('calib_')) return `MoGe load ${e.load_ms} + inference ${e.infer_ms} + floor ${e.floor_fit_ms} ms; the tool's total ${e.tool_ms} ms`
  if (e.longtask_ms) return `long tasks ${e.longtask_ms} ms`
  return ''
}
function table(res) {
  const lines = []
  for (const t of res.targets) {
    lines.push(`\nE17 ${t.label} — ${t.repo} @ ${t.git.commit?.slice(0, 10)}${t.git.dirty ? '+dirty' : ''} (server ${t.server_cmd}, add ${t.add_cmd})`)
    lines.push(`${'metric'.padEnd(26)} ${'median'.padStart(10)} ${'p95'.padStart(10)} ${'n'.padStart(3)} ${'noise'.padStart(8)}  load 1m before→after  notes`)
    for (const [name, m] of Object.entries(t.metrics)) {
      const s = m.summary
      lines.push(`${name.padEnd(26)} ${fmtV(s.median, m.unit).padStart(10)} ${fmtV(s.p95, m.unit).padStart(10)} ${String(s.n).padStart(3)} ${pct(s.noise_within).padStart(8)}  ${String(s.load_before?.[0] ?? '—').padStart(5)} → ${String(s.load_after?.[0] ?? '—').padEnd(6)}  ${s.n ? noteOf(name, s) : `FAILED: ${s.errors.join(' | ')}`}`)
    }
  }
  return lines.join('\n')
}
// Compare `now` against `base` metric by metric (both: results files or baselines). → {rows, failed}
function compare(base, cur, { baseLabel, curLabel } = {}) {
  const bt = base.targets.find((x) => x.label === baseLabel) || base.targets[0]
  const ct = cur.targets.find((x) => x.label === curLabel) || cur.targets.at(-1)
  const rows = []
  for (const [name, cm] of Object.entries(ct.metrics)) {
    const bm = bt.metrics[name]
    if (!bm?.summary?.median || cm.summary.median == null) { rows.push({ name, verdict: bm ? 'no data' : 'new', now: cm.summary.median }); continue }
    const b = bm.summary.median, c = cm.summary.median, ratio = c / b
    const nb = bm.noise ?? bm.summary.noise_within ?? 0, nc = cm.summary.noise_within ?? 0
    const noise = Math.min(1, bm.noise != null ? nb : Math.max(nb, nc))
    const allowed = 0.10 + noise
    const worse = ratio > 1 + allowed && c - b > 1
    rows.push({ name, base: b, now: c, ratio, noise, allowed, verdict: worse ? (METRICS[name]?.info ? 'worse (info)' : 'WORSE') : ratio < 1 / (1 + allowed) ? 'better' : 'same' })
  }
  return { rows, failed: rows.filter((r) => r.verdict === 'WORSE').map((r) => r.name), baseLabel: bt.label, curLabel: ct.label }
}
function compareTable(c) {
  const lines = [`\ncompare ${c.curLabel} against ${c.baseLabel}: fails when worse by more than 10 % + the metric's noise (and > 1 ms)`,
    `${'metric'.padEnd(26)} ${'base'.padStart(10)} ${'now'.padStart(10)} ${'ratio'.padStart(7)} ${'allowed'.padStart(8)}  verdict`]
  for (const r of c.rows) lines.push(`${r.name.padEnd(26)} ${fmtV(r.base).padStart(10)} ${fmtV(r.now).padStart(10)} ${(r.ratio ? r.ratio.toFixed(2) : '—').padStart(7)} ${(r.allowed != null ? `+${pct(r.allowed)}` : '—').padStart(8)}  ${r.verdict}`)
  lines.push(c.failed.length ? `REGRESSION in ${c.failed.length}: ${c.failed.join(', ')}` : 'no regression beyond the allowance')
  return lines.join('\n')
}
function finalize(res) {
  for (const t of res.targets) for (const m of Object.values(t.metrics)) m.summary = summarize(m.samples)
  return res
}
// --make-baseline: the quietest run (lowest mean 1-min load over its samples) with every metric's run-to-run noise.
function makeBaseline(files) {
  const runs = files.map((f) => ({ f, r: JSON.parse(fs.readFileSync(f, 'utf8')) }))
  const quiet = (r) => { const xs = r.targets[0] ? Object.values(r.targets[0].metrics).flatMap((m) => m.samples.flatMap((s) => [s.load?.[0]?.[0], s.load?.[1]?.[0]])).filter(Number.isFinite) : []; return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity }
  runs.forEach((x) => { x.load = quiet(x.r) })
  const best = runs.slice().sort((a, b) => a.load - b.load)[0]
  const out = structuredClone(best.r)
  const t = out.targets[0]
  for (const [name, m] of Object.entries(t.metrics)) {
    const meds = runs.map((x) => x.r.targets[0]?.metrics[name]?.summary?.median).filter(Number.isFinite)
    const mid = median(meds)
    m.run_medians = meds
    m.noise = meds.length >= 2 && mid > 0 ? round((Math.max(...meds) - Math.min(...meds)) / mid, 4) : m.summary.noise_within
  }
  out.baseline = { made: new Date().toISOString(), from: runs.map((x) => ({ file: path.relative(SELF, x.f), started: x.r.started, mean_load_1m: round(x.load, 2), commit: x.r.targets[0]?.git?.commit })),
    chosen: path.relative(SELF, best.f), noise: 'relative range of the per-run medians across these runs' }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`baseline: ${path.relative(SELF, BASELINE)} from ${best.f} (mean 1-min load ${round(best.load, 2)}; others ${runs.filter((x) => x !== best).map((x) => round(x.load, 2)).join(', ')})`)
  console.log(table(out))
  return out
}

// --- main ------------------------------------------------------------------------------------------------------------
if (A.makeBaseline) { makeBaseline(A.makeBaseline.map((f) => path.resolve(f))); process.exit(0) }
if (A.results) {
  const cur = JSON.parse(fs.readFileSync(path.resolve(A.results), 'utf8'))
  console.log(table(cur))
  if (A.compare) { const c = compare(JSON.parse(fs.readFileSync(path.resolve(A.compare), 'utf8')), cur); console.log(compareTable(c)); process.exit(c.failed.length ? 1 : 0) }
  process.exit(0)
}

fs.mkdirSync(OUT, { recursive: true })
const specs = A.targets.length ? A.targets : [A.repo || SELF]
const targets = []
for (const [i, spec] of specs.entries()) targets.push(await loadTarget(parseTarget(spec, i)))
if (new Set(targets.map((t) => t.label)).size !== targets.length) { console.error('perf: target labels must differ (label:path)'); process.exit(2) }
const res = { eval: 'E17', version: 1, started: new Date().toISOString(), args: process.argv.slice(2), machine: machine(), load: { before: loadavg() }, targets: [] }
let finished = false
async function shutdown(code) {
  if (finished) return
  finished = true
  for (const t of targets) await cleanupTarget(t)
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { console.error(`perf: ${sig}`); shutdown(130) })
const watchdog = setTimeout(() => { console.error('perf: still running after 4 h; stopping'); shutdown(1) }, 4 * 3600 * 1000)
watchdog.unref()
process.on('unhandledRejection', (e) => { console.error('perf: unhandled', e); shutdown(1) })

console.log(`E17 perf: ${targets.map((t) => `${t.label}=${t.repo}${Object.keys(t.env).length ? ` ${JSON.stringify(t.env)}` : ''}`).join(', ')}; ${A.runs} runs + ${A.warmup} warm-up; load ${loadavg().join(' ')}`)
try {
  if (A.profile) {
    const prof = {}
    for (const t of targets) prof[t.label] = await profileTarget(t)
    res.profiles = prof
  } else {
    for (const suite of SUITES.filter(wanted)) {
      const t0 = Date.now()
      for (const t of targets) {
        if (suite !== 'server' && suite !== 'cli' && suite !== 'calib') {
          try { await call(t, () => mainServer(t)) } catch (e) { console.error(`perf: ${t.label}: ${e.message}`); t.setupError = String(e.message) }
        }
      }
      for (let i = -A.warmup; i < A.runs; i++) {
        const order = (i + A.warmup) % 2 === 0 ? targets : targets.slice().reverse() // ABBA: drift cancels
        for (const t of order) {
          RUN = { i, warmup: i < 0, load: loadavg() }
          const names = Object.keys(METRICS).filter((n) => METRICS[n].suite === suite)
          const count = (n) => t.metrics[n]?.samples.length ?? 0
          const before = Object.fromEntries(names.map((n) => [n, count(n)]))
          if (t.setupError && suite !== 'server' && suite !== 'cli' && suite !== 'calib') fail(t, names, t.setupError)
          else {
            try { await call(t, () => suites[suite](t)) } catch (e) { console.error(`perf: ${t.label} ${suite} run ${i}: ${e.stack || e}`); fail(t, names.filter((n) => count(n) === before[n]), e) }
            const missing = names.filter((n) => count(n) === before[n])
            if (missing.length) fail(t, missing, 'not measured in this run')
          }
          stampLoadAfter(t, names)
        }
      }
      const got = targets.map((t) => Object.keys(METRICS).filter((n) => METRICS[n].suite === suite).map((n) => {
        const s = summarize(t.metrics[n]?.samples || [])
        return `${n} ${fmtV(s.median)}${s.failed ? ` (${s.failed} failed)` : ''}`
      }).join(', ')).join(' || ')
      console.log(`[${suite}] ${((Date.now() - t0) / 1000).toFixed(0)} s, load ${loadavg().join(' ')}: ${got}`)
    }
  }
} catch (e) {
  console.error(`perf: ${e.stack || e}`)
  res.error = String(e.message || e)
}
res.finished = new Date().toISOString()
res.load.after = loadavg()
for (const t of targets) {
  res.targets.push({ label: t.label, repo: t.repo, env: t.env, git: t.git, mode: t.mode, server_cmd: serverCommand(t).join(' '), add_cmd: addCommand(t).join(' '),
    info: t.info, setup_error: t.setupError, metrics: t.metrics })
}
finalize(res)
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(res, null, 1))
if (A.out) { fs.mkdirSync(path.dirname(path.resolve(A.out)), { recursive: true }); fs.copyFileSync(path.join(OUT, 'results.json'), path.resolve(A.out)) }
let code = res.error ? 1 : 0
if (!A.profile) {
  const tab = table(res)
  console.log(tab)
  let txt = tab
  const empty = res.targets.flatMap((t) => Object.entries(t.metrics).filter(([, m]) => !m.summary.n).map(([n]) => `${t.label}:${n}`))
  if (empty.length) { console.log(`\nno valid sample: ${empty.join(', ')}`); code = 1 }
  for (const t of res.targets.slice(1)) {
    const c = compare(res, res, { baseLabel: res.targets[0].label, curLabel: t.label })
    // A/B: the allowance takes each metric's noise from the committed baseline when there is one
    if (fs.existsSync(BASELINE)) {
      const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
      for (const r of c.rows) {
        const bn = b.targets[0]?.metrics[r.name]?.noise
        if (bn == null || !r.base) continue
        r.noise = Math.min(1, Math.max(r.noise, bn))
        r.allowed = 0.1 + r.noise
        const worse = r.ratio > 1 + r.allowed && r.now - r.base > 1
        r.verdict = worse ? (METRICS[r.name]?.info ? 'worse (info)' : 'WORSE') : r.ratio < 1 / (1 + r.allowed) ? 'better' : 'same'
      }
      c.failed = c.rows.filter((r) => r.verdict === 'WORSE').map((r) => r.name)
    }
    const ct = compareTable(c)
    console.log(ct)
    txt += `\n${ct}`
    if (c.failed.length) code = 1
  }
  if (A.compare) {
    const c = compare(JSON.parse(fs.readFileSync(path.resolve(A.compare), 'utf8')), res)
    const ct = compareTable(c)
    console.log(ct)
    txt += `\n${ct}`
    if (c.failed.length) code = 1
  }
  fs.writeFileSync(path.join(OUT, 'table.txt'), `${txt}\n`)
  if (A.baseline) {
    const b = structuredClone(res)
    for (const t of b.targets) for (const m of Object.values(t.metrics)) m.noise = m.summary.noise_within
    b.baseline = { made: new Date().toISOString(), from: [{ started: res.started }], noise: 'within-run: the medians\' 2σ from the samples (single run)' }
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
    fs.writeFileSync(BASELINE, `${JSON.stringify(b, null, 1)}\n`)
    console.log(`baseline written: ${path.relative(SELF, BASELINE)}`)
  }
}
console.log(`\nE17: results in ${path.relative(SELF, path.join(OUT, 'results.json'))} (${((Date.parse(res.finished) - Date.parse(res.started)) / 1000).toFixed(0)} s); load ${res.load.before.join(' ')} → ${res.load.after.join(' ')}`)
clearTimeout(watchdog)
await shutdown(code)
