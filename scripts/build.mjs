#!/usr/bin/env node
// The v2 build (docs/REFACTOR.md §1–§2; docs/notes/f-toolchain.md). `npm run build`, or `node scripts/build.mjs`.
//
// 1. wasm (every core/crates/wasm-<name> crate, into build/wasm/<name>/): cargo build --release --target
//    wasm32-unknown-unknown (SIMD128 through core/.cargo/config.toml), wasm-bindgen 0.2.121 (--target web into
//    build/wasm/web/, --target experimental-nodejs-module, Node ESM, into build/wasm/node/), then wasm-opt -O3 with SIMD.
//    File names are wasm-bindgen's: <lib name>.js, <lib name>.d.ts, <lib name>_bg.wasm (+ _bg.wasm.d.ts).
// 2. planner: esbuild bundles planner/main.ts with three.js (three/webgpu, three/tsl and the addons) from node_modules
//    (no CDN, no importmap) into planner/dist/: app.js, content-hashed chunks, assets/, linked sourcemaps; minified for
//    es2022 and safari16. Files named *.worker.ts under planner/ or core/js/ are bundled as their own entries,
//    planner/dist/<name>.worker.js, for `new Worker(new URL('./<name>.worker.js', import.meta.url), { type: 'module' })`:
//    engine.worker.js (the kernels) and sort.worker.js (planner/gpu: the splats' sort on the WebGL2 fallback). The web wasm (build/wasm/web/*.wasm) is copied next to the chunks, so
//    wasm-bindgen's `new URL('<lib>_bg.wasm', import.meta.url)` resolves. three's decoders (Draco, Basis) are copied to
//    planner/dist/libs/ for DRACOLoader/KTX2Loader.
//
// Incremental: each step keeps a stamp of its inputs (path, size, mtime) in build/stamps/; when nothing changed it is a
// no-op (one stat per input, well under a second). A build during which an input was saved writes no stamp, so the next
// one rebuilds (scripts/lib/stamps.mjs). Concurrent runs are safe: a lock per step serializes them (the second
// one then finds the stamp current), every output file is written to a temporary name and renamed into place, chunks
// before the entry (app.js) and the stamp last, and files of older builds are removed only after a grace period.
//
// Options: --force (ignore the stamps), --planner-only, --wasm-only, --quiet. Exit 1 on a failed step.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readOwner, tryClaim } from './lib/dirlock.mjs'
import { decide, MISSING, PRUNE_GRACE_MS } from './lib/stamps.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const QUIET = args.has('--quiet')
const t0 = performance.now()
const rel = (p) => path.relative(ROOT, p) || '.'
const ms = () => `${Math.round(performance.now() - t0)} ms`
const log = (s) => { if (!QUIET) console.log(s) }
const STAMPS = path.join(ROOT, 'build/stamps')

// --- inputs, stamps, locks ------------------------------------------------------------------------------------------------
function walk(dir, skip = () => false, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (skip(p, e)) continue
    if (e.isDirectory()) walk(p, skip, out)
    else if (e.isFile() || e.isSymbolicLink()) out.push(p)
  }
  return out
}
const statOf = (p) => { try { const s = fs.statSync(p); return { key: `${s.size}:${Math.round(s.mtimeMs)}`, mtimeMs: s.mtimeMs } } catch { return { key: MISSING, mtimeMs: null } } }
const statsOf = (files) => Object.fromEntries([...new Set(files)].sort().map((f) => [rel(f), statOf(f)]))
const keysOf = (stats) => Object.fromEntries(Object.entries(stats).map(([f, s]) => [f, s.key]))
// `inputs`: the files the step knows it reads before it runs; one the stamp never saw makes it stale.
function stampCurrent(name, want, inputs = []) {
  if (FORCE) return false
  try {
    const have = JSON.parse(fs.readFileSync(path.join(STAMPS, `${name}.json`), 'utf8'))
    if (JSON.stringify(have.key) !== JSON.stringify(want.key)) return false
    const now = statsOf([...Object.keys(have.inputs).map((f) => path.join(ROOT, f)), ...inputs])
    if (decide(have, now) !== 'current') return false
    for (const f of have.outputs) if (!fs.existsSync(path.join(ROOT, f))) return false
    return true
  } catch { return false }
}
// Stats the inputs once: what is checked against buildStart is what the stamp records. `before`: the inputs at the start.
function writeStamp(name, key, inputs, outputs, buildStart, before = null) {
  const stats = statsOf(inputs)
  const file = path.join(STAMPS, `${name}.json`)
  if (decide(before, stats, buildStart) === 'do-not-write') {
    fs.rmSync(file, { force: true })
    log(`${name}: an input changed during the build; it rebuilds next time`)
    return
  }
  atomicWrite(file, JSON.stringify({ key, inputs: keysOf(stats), outputs: outputs.map(rel) }, null, 1))
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// A lock directory per step (scripts/lib/dirlock.mjs): a live holder keeps it however long it runs; a dead one's, or one
// with no readable owner after 10 s, is taken over. No signal handlers on purpose: the tools run through spawnSync, so a
// JS handler would wait for the child and make the build unkillable for minutes. A SIGTERMed build leaves a lock with a
// dead pid, which the next build reclaims at once.
async function withLock(name, fn) {
  const dir = path.join(ROOT, 'build/locks', `${name}.lock`)
  const deadline = Date.now() + 30 * 60_000
  let held
  while ((held = tryClaim(dir, { cmd: `build ${name}` })) === null) {
    if (Date.now() > deadline) throw new Error(`build: ${rel(dir)} held for 30 min${readOwner(dir) ? ` by pid ${readOwner(dir).pid}` : ''}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  try { return await fn() } finally { held.release() }
}
// Removes files under `dir` that this build did not write, once they are older than the grace period.
function prune(dir, keep) {
  const now = Date.now()
  for (const f of walk(dir)) {
    if (keep.has(f) || path.basename(f).startsWith('.')) continue
    try { if (now - fs.statSync(f).mtimeMs > PRUNE_GRACE_MS) fs.rmSync(f, { force: true }) } catch { /* gone already */ }
  }
}
// The .tmp-<crate>-<pid> folders of builds that died (SIGTERM has no cleanup here).
function sweepDeadTemps() {
  const dir = path.join(ROOT, 'build/wasm')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const n of names) {
    const m = /^\.tmp-.+-(\d+)$/.exec(n)
    if (m && !alive(Number(m[1]))) fs.rmSync(path.join(dir, n), { recursive: true, force: true })
  }
}
// The real path of a tool on PATH: its Nix store path names its version, so a toolchain change rebuilds.
function which(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, cmd)
    try { fs.accessSync(p, fs.constants.X_OK); return fs.realpathSync(p) } catch { /* next */ }
  }
  return null
}
const scriptKey = createHash('sha256').update(fs.readFileSync(import.meta.filename))
  .update(fs.readFileSync(path.join(import.meta.dirname, 'lib/stamps.mjs'))).digest('hex').slice(0, 16)

// --- 1. wasm --------------------------------------------------------------------------------------------------------------
const CORE = path.join(ROOT, 'core')
// Every core/crates/wasm-<name> crate builds into build/wasm/<name>/: wasm-web (or a crate whose Cargo.toml says
// [package.metadata.midstudy] target = "web") for the browser with --target web, every other one for Node as ESM
// (wasm-node, wasm-pipeline, wasm-product…).
const WASM_CRATES = (() => {
  let dirs = []
  try {
    dirs = fs.readdirSync(path.join(CORE, 'crates'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('wasm-')).map((e) => e.name).sort()
  } catch { return [] }
  return dirs.filter((d) => fs.existsSync(path.join(CORE, 'crates', d, 'Cargo.toml'))).map((d) => {
    const meta = fs.readFileSync(path.join(CORE, 'crates', d, 'Cargo.toml'), 'utf8').split('[package.metadata.midstudy]')[1] ?? ''
    const web = d === 'wasm-web' || /^\s*target\s*=\s*"web"/m.test(meta.split(/^\[/m)[0] ?? '')
    return { crate: d, target: web ? 'web' : 'experimental-nodejs-module', out: path.join(ROOT, 'build/wasm', d.slice('wasm-'.length)) }
  })
})()
// The wasm features Rust 1.95 enables by default for wasm32-unknown-unknown, plus SIMD128 (core/.cargo/config.toml).
const WASM_OPT_FEATURES = ['--enable-simd', '--enable-bulk-memory', '--enable-sign-ext', '--enable-nontrapping-float-to-int',
  '--enable-mutable-globals', '--enable-reference-types', '--enable-multivalue']

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: QUIET ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], encoding: 'utf8', ...opts })
  if (r.error) throw new Error(`${cmd}: ${r.error.message}${r.error.code === 'ENOENT' ? ' (run inside `nix develop`)' : ''}`)
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${r.status}${QUIET ? `\n${r.stderr || ''}` : ''}`)
  return r
}

// Everything cargo can read: include_str! and build.rs data count. Cargo.lock by name, so its appearing flips the stamp.
const wasmInputs = () => [
  ...walk(path.join(CORE, 'crates'), (p, e) => e.isDirectory() && (['target', 'node_modules'].includes(e.name) || e.name.startsWith('.'))),
  ...walk(path.join(CORE, '.cargo')),
  path.join(CORE, 'Cargo.toml'),
  path.join(CORE, 'Cargo.lock'),
]

async function buildWasm() {
  sweepDeadTemps()
  // scripts/test/build-lock.test.mjs: the step is a sleep under its lock.
  if (args.has('--lock-selftest')) return withLock('wasm', async () => { console.log('lock-selftest: entered'); await new Promise((r) => setTimeout(r, Number(process.env.MIDSTUDY_BUILD_STEP_SLEEP_MS))); return 'wasm: lock-selftest' })
  if (!WASM_CRATES.length) return 'wasm: no core/crates/wasm-* crate yet, nothing to build'
  const tools = ['cargo', 'rustc', 'wasm-bindgen', 'wasm-opt'].map((t) => [t, which(t)])
  const missing = tools.filter(([, p]) => !p).map(([t]) => t)
  if (missing.length) throw new Error(`wasm: ${missing.join(', ')} not on PATH (run inside \`nix develop\`)`)
  const key = { script: scriptKey, tools, crates: WASM_CRATES.map((c) => c.crate) }
  return withLock('wasm', async () => {
    const outputsOf = () => WASM_CRATES.flatMap((c) => walk(c.out).filter((f) => !path.basename(f).startsWith('.')))
    const inputs = wasmInputs()
    if (stampCurrent('wasm', { key }, inputs)) return `wasm: up to date (${WASM_CRATES.map((c) => rel(c.out)).join(', ')})`
    const buildStart = Date.now()
    const before = { inputs: keysOf(statsOf(inputs)) }
    // --locked once core/Cargo.lock exists (it is shared-append: the kernel tracks commit it with their crates).
    const locked = fs.existsSync(path.join(CORE, 'Cargo.lock')) ? ['--locked'] : []
    const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', ...locked], { cwd: CORE, encoding: 'utf8', maxBuffer: 64 << 20 }))
    const targetDir = meta.target_directory
    // The package of core/crates/<dir>, by manifest path: its name is the crate's own (midstudy-wasm-web), not the dir.
    const pkgOf = (c) => meta.packages.find((p) => path.resolve(p.manifest_path) === path.join(CORE, 'crates', c.crate, 'Cargo.toml'))
    run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', ...locked,
      ...WASM_CRATES.flatMap((c) => ['-p', pkgOf(c)?.name ?? c.crate])], { cwd: CORE })
    const written = []
    for (const c of WASM_CRATES) {
      const pkg = pkgOf(c)
      const lib = pkg?.targets.find((t) => t.kind.includes('cdylib'))
      if (!lib) throw new Error(`wasm: ${c.crate} has no cdylib target ([lib] crate-type = ["cdylib"])`)
      const wasm = path.join(targetDir, 'wasm32-unknown-unknown/release', `${lib.name.replace(/-/g, '_')}.wasm`)
      const tmp = path.join(ROOT, 'build/wasm', `.tmp-${c.crate}-${process.pid}`)
      fs.rmSync(tmp, { recursive: true, force: true })
      run('wasm-bindgen', ['--target', c.target, '--out-dir', tmp, wasm])
      for (const f of fs.readdirSync(tmp).filter((f) => f.endsWith('.wasm'))) {
        const p = path.join(tmp, f)
        run('wasm-opt', ['-O3', ...WASM_OPT_FEATURES, '-o', `${p}.opt`, p])
        fs.renameSync(`${p}.opt`, p)
      }
      // .wasm first, the JS glue that loads it after: a reader never sees glue without its module.
      const files = fs.readdirSync(tmp).sort((a, b) => Number(b.endsWith('.wasm')) - Number(a.endsWith('.wasm')))
      for (const f of files) {
        atomicWrite(path.join(c.out, f), fs.readFileSync(path.join(tmp, f)))
        written.push(path.join(c.out, f))
      }
      fs.rmSync(tmp, { recursive: true, force: true })
      prune(c.out, new Set(written))
    }
    writeStamp('wasm', key, inputs, outputsOf(), buildStart, before)
    return `wasm: built ${WASM_CRATES.map((c) => rel(c.out)).join(', ')} (${written.length} files)`
  })
}

// --- 2. planner -----------------------------------------------------------------------------------------------------------
const PLANNER = path.join(ROOT, 'planner')
const DIST = path.join(PLANNER, 'dist')
const DECODERS = [
  ['draco/gltf', ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']],
  ['basis', ['basis_transcoder.js', 'basis_transcoder.wasm']],
]
const CDN = /https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com|cdn\.skypack\.dev)\/[^\s'"`)]*/g

// The addons (GLTFLoader, KTX2Loader, RoomEnvironment…) import 'three': resolved to three's WebGPU build, the one the
// planner renders with (three.module.js is three.core.js + WebGLRenderer, which nothing uses), as three's own import
// map for WebGPU does. An addon that needed a WebGL-only export would fail the build.
const THREE_WEBGPU = path.join(ROOT, 'node_modules/three/build/three.webgpu.js')
const threeWebGPU = { name: 'three-webgpu', setup(b) { b.onResolve({ filter: /^three$/ }, () => ({ path: THREE_WEBGPU })) } }

function plannerEntries() {
  const main = path.join(PLANNER, 'main.ts')
  if (!fs.existsSync(main)) throw new Error('planner: no planner/main.ts')
  const workers = [
    ...walk(PLANNER, (p, e) => e.isDirectory() && (p === DIST || e.name === 'node_modules')),
    ...walk(path.join(ROOT, 'core/js')),
  ].filter((f) => /\.worker\.ts$/.test(f))
  const entries = { app: main }
  for (const w of workers) {
    const name = path.basename(w).replace(/\.ts$/, '')
    if (entries[name]) throw new Error(`planner: two workers named ${name}: ${rel(entries[name])}, ${rel(w)}`)
    entries[name] = w
  }
  return entries
}

async function buildPlanner() {
  const entries = plannerEntries()
  const webWasm = walk(path.join(ROOT, 'build/wasm/web')).filter((f) => f.endsWith('.wasm') && !path.basename(f).startsWith('.'))
  const decoderFiles = DECODERS.flatMap(([d, fs_]) => fs_.map((f) => path.join(ROOT, 'node_modules/three/examples/jsm/libs', d, f)))
  const key = { script: scriptKey, entries: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, rel(v)])), wasm: webWasm.map(rel) }
  return withLock('planner', async () => {
    if (stampCurrent('planner', { key })) return 'planner: up to date (planner/dist/app.js)'
    const buildStart = Date.now()
    let esbuild
    try { esbuild = await import('esbuild') } catch { throw new Error('planner: esbuild missing: run `nix develop -c npm install`') }
    const result = await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: entries,
      outdir: DIST,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022', 'safari16'],
      minify: true,
      sourcemap: 'linked',
      entryNames: '[name]',
      chunkNames: '[name]-[hash]',
      assetNames: 'assets/[name]-[hash]',
      loader: { '.wasm': 'file', '.png': 'file', '.svg': 'file', '.jpg': 'file' },
      metafile: true,
      write: false,
      logLevel: 'silent',
      legalComments: 'linked',
      charset: 'utf8',
      plugins: [threeWebGPU],
    }).catch((e) => { throw new Error(`planner: esbuild failed\n${(e.errors || []).slice(0, 10).map((m) => `  ${m.location ? `${m.location.file}:${m.location.line}: ` : ''}${m.text}`).join('\n') || e.message}`) })
    for (const w of result.warnings) log(`planner: warning: ${w.location ? `${w.location.file}:${w.location.line}: ` : ''}${w.text}`)
    // Chunks, assets and maps first, entries after, so app.js never names a chunk that is not there yet.
    const isEntry = (f) => Object.keys(entries).some((n) => path.basename(f) === `${n}.js`)
    const outs = [...result.outputFiles].sort((a, b) => Number(isEntry(a.path)) - Number(isEntry(b.path)))
    const written = new Set()
    for (const o of outs.filter((o) => !isEntry(o.path))) { atomicWrite(o.path, o.contents); written.add(o.path) }
    for (const f of webWasm) { const to = path.join(DIST, path.basename(f)); atomicWrite(to, fs.readFileSync(f)); written.add(to) }
    for (const [d, files] of DECODERS) for (const f of files) {
      const to = path.join(DIST, 'libs', d, f)
      atomicWrite(to, fs.readFileSync(path.join(ROOT, 'node_modules/three/examples/jsm/libs', d, f)))
      written.add(to)
    }
    for (const o of outs.filter((o) => isEntry(o.path))) { atomicWrite(o.path, o.contents); written.add(o.path) }
    prune(DIST, written)
    const inputs = [...Object.keys(result.metafile.inputs).map((f) => path.resolve(ROOT, f)), ...webWasm, ...decoderFiles, path.join(ROOT, 'package-lock.json')]
    writeStamp('planner', key, inputs, [...written], buildStart)
    const js = outs.filter((o) => o.path.endsWith('.js'))
    const cdn = new Set(js.flatMap((o) => o.text.match(CDN) || []))
    const appKb = Math.round((outs.find((o) => path.basename(o.path) === 'app.js')?.contents.length || 0) / 1024)
    const chunks = js.filter((o) => !isEntry(o.path)).length
    let line = `planner: built planner/dist/app.js (${appKb} kB) + ${chunks} chunk(s), ${Object.keys(entries).length - 1} worker(s), ${written.size} files from ${Object.keys(result.metafile.inputs).length} inputs`
    if (cdn.size) line += `\nplanner: warning: ${cdn.size} CDN URL(s) still in the bundle: ${[...cdn].join(', ')}`
    return line
  })
}

// --- main -----------------------------------------------------------------------------------------------------------------
try {
  const lines = []
  if (!args.has('--planner-only')) lines.push(await buildWasm())
  if (!args.has('--wasm-only')) lines.push(await buildPlanner())
  for (const l of lines) log(l)
  log(`build: ok in ${ms()}`)
} catch (e) {
  console.error(String(e.message || e))
  console.error(`build: FAILED in ${ms()}`)
  process.exit(1)
}
