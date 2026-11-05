#!/usr/bin/env node
// The v2 gates (docs/REFACTOR.md §3): `npm run check` runs them all, `npm run check:<name>` one. Run inside the dev
// shell: `nix develop -c npm run check`. Each check prints one summary line, `check:<name>: ok|FAIL — <what>`, with the
// tool's own output above it only when it fails (or with --verbose). An area that does not exist yet passes with
// "nothing to check". Exit 1 when any check fails.
//
//   types      tsc -b over every tsconfig area that has .ts files (tsconfig.json lists the areas)
//   lint       eslint (eslint.config.js: strict-type-checked, no any / ! / casts / ts-comments) over the .ts files
//   dead       knip (knip.json): no unused files, exports or dependencies
//   gen        scripts/gen-contract.mjs (when it exists), then contract/gen/ must equal what is committed
//   tscert     scripts/tscert-ratchet.mjs: TScert over the logic/ modules, tscert/baseline.json still certifies
//   rust       in core/: cargo fmt --check, clippy -D warnings, tests; Miri (nightly shell) on core/miri.txt's
//              crates; Kani harnesses when Kani is available
//   fuzz       a smoke run per cargo-fuzz target under core/ (MIDSTUDY_FUZZ_SECONDS, default 60), nightly shell
//   proofs     lake build in proofs/; no sorry or admit, no axiom outside proofs/axioms.txt
//   py         pyright (strict) and ruff on calib/
//   ownership  scripts/check-ownership.mjs for MIDSTUDY_TRACK (default: the track of a v2-<track> branch)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
let ts
try { ts = (await import('typescript')).default } catch { console.error('check: typescript missing: run `nix develop -c npm install`'); process.exit(1) }
const argv = process.argv.slice(2)
const VERBOSE = argv.includes('--verbose')
const ORDER = ['ownership', 'gen', 'types', 'lint', 'dead', 'tscert', 'py', 'rust', 'fuzz', 'proofs']
const wanted = argv.filter((a) => !a.startsWith('--'))
for (const w of wanted) if (!ORDER.includes(w)) { console.error(`check: unknown check ${w} (${ORDER.join(', ')})`); process.exit(2) }
const exists = (p) => fs.existsSync(path.join(ROOT, p))
const bin = (name) => path.join(ROOT, 'node_modules/.bin', name)

function walk(dir, skip = new Set(['node_modules', 'dist', 'target', '.lake', '.venv', 'build', '.git']), out = []) {
  let es
  try { es = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }) } catch { return out }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!skip.has(e.name)) walk(p, skip, out) } else if (e.isFile()) out.push(p)
  }
  return out
}
// Runs a command; returns {code, out} with stdout and stderr together.
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 << 20, ...opts, env: { ...process.env, FORCE_COLOR: '0', ...opts.env } })
  if (r.error) return { code: 127, out: `${cmd}: ${r.error.code === 'ENOENT' ? 'not found (run inside `nix develop`, after `npm install`)' : r.error.message}` }
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const tail = (s, n = 60) => s.trim().split('\n').slice(-n).join('\n')
// The nightly shell (Miri, cargo-fuzz): `nix develop .#nightly -c …` from the repository.
const nightly = (args, opts = {}) => sh('nix', ['develop', `${ROOT}#nightly`, '-c', ...args], opts)

const checks = {
  ownership() {
    let track = process.env.MIDSTUDY_TRACK
    if (!track) {
      const b = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
      if (b.startsWith('v2-')) track = b.slice(3)
    }
    if (!track) return { ok: true, line: 'nothing to check (set MIDSTUDY_TRACK, or work on a v2-<track> branch)' }
    const r = sh('node', ['scripts/check-ownership.mjs', track])
    return { ok: r.code === 0, line: r.out.trim().split('\n')[0], out: r.out }
  },

  gen() {
    if (!exists('scripts/gen-contract.mjs')) return { ok: true, line: 'nothing to check (no scripts/gen-contract.mjs yet)' }
    const g = sh('node', ['scripts/gen-contract.mjs'])
    if (g.code !== 0) return { ok: false, line: `scripts/gen-contract.mjs exited ${g.code}`, out: g.out }
    // Everything the generator writes: contract/gen/ and the bundle the Rust contract crate reads (gate-1).
    const outs = ['contract/gen', 'core/crates/contract/schema.json']
    const diff = sh('git', ['diff', '--stat', '--exit-code', '--', ...outs])
    const untracked = sh('git', ['status', '--porcelain', '--untracked-files=all', '--', ...outs]).out.trim()
    if (diff.code !== 0 || untracked) return { ok: false, line: 'contract/gen or core/crates/contract/schema.json differs from what the schemas generate (commit the regenerated files)', out: `${diff.out}\n${untracked}` }
    return { ok: true, line: 'contract/gen and core/crates/contract/schema.json are what the schemas generate' }
  },

  types() {
    const areas = readTsconfig('tsconfig.json').references.map((r) => r.path)
    const withTs = []
    const empty = []
    for (const cfgPath of areas) {
      const cfg = readTsconfig(cfgPath)
      const res = (cfg.include || []).filter((g) => g.endsWith('.ts')).map((g) => {
        const segs = g.split('/'); const k = segs.findIndex((s) => /[*{]/.test(s))
        return { top: segs.slice(0, k < 0 ? segs.length - 1 : k).join('/'), re: globRe(g) }
      })
      const has = res.some(({ top, re }) => walk(top).some((f) => re.test(f.split(path.sep).join('/'))))
      ;(has ? withTs : empty).push(path.basename(cfgPath).replace(/^tsconfig\.|\.json$/g, ''))
    }
    if (!withTs.length) return { ok: true, line: `nothing to check (no .ts files yet in ${empty.join(', ')})` }
    // core/js/web.ts imports the wasm-bindgen output: build it first (a no-op when current).
    if (withTs.includes('core-web') || withTs.includes('core-node')) {
      const b = sh('node', ['scripts/build.mjs', '--wasm-only', '--quiet'])
      if (b.code !== 0) return { ok: false, line: 'the wasm build failed (core/js needs build/wasm)', out: b.out }
    }
    const r = sh(bin('tsc'), ['-b', ...withTs.map((a) => `tsconfig.${a}.json`), '--pretty', 'false'])
    const errors = (r.out.match(/error TS\d+/g) || []).length
    return { ok: r.code === 0, line: `${r.code === 0 ? 'no errors' : `${errors} error(s)`} in ${withTs.join(', ')}${empty.length ? `; no .ts yet in ${empty.join(', ')}` : ''}`, out: r.out }
  },

  lint() {
    const ts = ['planner', 'server', 'pipeline', 'core/js'].flatMap((d) => walk(d)).filter((f) => /\.(ts|mts|cts)$/.test(f))
    if (!ts.length) return { ok: true, line: 'nothing to check (no .ts files yet)' }
    const r = sh(bin('eslint'), ['.', '--max-warnings', '0', '--format', 'stylish'])
    const m = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(r.out)
    return { ok: r.code === 0, line: r.code === 0 ? `${ts.length} .ts file(s), no problems` : m ? `${m[1]} problem(s) (${m[2]} errors, ${m[3]} warnings)` : `eslint exited ${r.code}`, out: r.out }
  },

  dead() {
    const r = sh(bin('knip'), ['--no-progress', '--no-config-hints'])
    const n = r.out.split('\n').filter((l) => /^\S.*\(\d+\)$/.test(l)).map((l) => Number(/\((\d+)\)$/.exec(l)[1])).reduce((a, b) => a + b, 0)
    return { ok: r.code === 0, line: r.code === 0 ? 'knip: no unused files, exports or dependencies' : `knip: ${n || 'some'} unused item(s)`, out: r.out }
  },

  tscert() {
    const r = sh('node', ['scripts/tscert-ratchet.mjs'])
    const last = r.out.trim().split('\n').at(-1) || ''
    return { ok: r.code === 0, line: last.replace(/^tscert: /, ''), out: r.out }
  },

  py() {
    if (!exists('calib/pyproject.toml')) return { ok: true, line: 'nothing to check (no calib/)' }
    // pyright reads calib's own [tool.pyright] when calib has one; otherwise scripts/pyright/pyrightconfig.json (strict).
    const own = fs.readFileSync(path.join(ROOT, 'calib/pyproject.toml'), 'utf8').includes('[tool.pyright]') || exists('calib/pyrightconfig.json')
    if (!exists('calib/.venv')) {
      const s = sh('uv', ['sync', '--project', 'calib', '--frozen', '--quiet'])
      if (s.code !== 0) return { ok: false, line: 'uv sync --project calib failed (pyright needs its packages)', out: s.out }
    }
    const p = sh('pyright', ['--project', own ? 'calib' : 'scripts/pyright/pyrightconfig.json', '--pythonpath', path.join(ROOT, 'calib/.venv/bin/python')])
    const pm = /(\d+) errors?, (\d+) warnings?/.exec(p.out)
    const r = sh('ruff', ['check', '--no-cache', '--output-format', 'concise', 'calib'], { env: { NO_COLOR: '1' } })
    const rm = /Found (\d+) error/.exec(r.out)
    const ok = p.code === 0 && r.code === 0
    return { ok, line: `pyright strict: ${pm ? `${pm[1]} error(s), ${pm[2]} warning(s)` : p.code === 0 ? 'clean' : `exited ${p.code}`}; ruff: ${r.code === 0 ? 'clean' : rm ? `${rm[1]} error(s)` : `exited ${r.code}`}`, out: `${tail(p.out, 80)}\n${tail(r.out, 40)}` }
  },

  rust() {
    const crates = walk('core/crates').filter((f) => /^core\/crates\/[^/]+\/Cargo\.toml$/.test(f.split(path.sep).join('/')))
    if (!crates.length) return { ok: true, line: 'nothing to check (no core/crates/*/Cargo.toml yet)' }
    const locked = exists('core/Cargo.lock') ? ['--locked'] : []
    const cwd = path.join(ROOT, 'core')
    const steps = []
    const fmt = sh('cargo', ['fmt', '--all', '--check'], { cwd })
    if (fmt.code !== 0) return { ok: false, line: 'cargo fmt --check: unformatted code', out: fmt.out }
    steps.push('fmt')
    const clippy = sh('cargo', ['clippy', '--workspace', '--all-targets', ...locked, '--', '-D', 'warnings'], { cwd })
    if (clippy.code !== 0) return { ok: false, line: 'cargo clippy -D warnings failed', out: clippy.out }
    steps.push('clippy -D warnings')
    const test = sh('cargo', ['test', '--workspace', ...locked], { cwd })
    if (test.code !== 0) return { ok: false, line: 'cargo test failed', out: test.out }
    const passed = [...test.out.matchAll(/test result: ok\. (\d+) passed/g)].reduce((a, m) => a + Number(m[1]), 0)
    steps.push(`${passed} tests`)
    // Miri: the crates core/miri.txt lists (one per line, # comments), through the nightly shell. Its sysroot is built
    // once into build/miri/ (not ~/Library/Caches).
    if (exists('core/miri.txt')) {
      const list = fs.readFileSync(path.join(ROOT, 'core/miri.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
      const env = { MIRI_SYSROOT: path.join(ROOT, 'build/miri/sysroot') }
      const setup = nightly(['cargo', 'miri', 'setup'], { cwd, env })
      if (setup.code !== 0) return { ok: false, line: 'cargo miri setup failed', out: setup.out }
      for (const c of list) {
        const m = nightly(['cargo', 'miri', 'test', '-p', c, ...locked], { cwd, env })
        if (m.code !== 0) return { ok: false, line: `Miri found a problem in ${c}`, out: m.out }
      }
      steps.push(`Miri on ${list.join(', ') || 'no crate'}`)
    } else steps.push('Miri: no core/miri.txt')
    // Kani (nix/kani.nix, in the nightly shell on aarch64-darwin): every #[kani::proof] harness of the workspace.
    const harnesses = walk('core/crates').filter((f) => f.endsWith('.rs') && fs.readFileSync(path.join(ROOT, f), 'utf8').includes('#[kani::proof]'))
    if (harnesses.length) {
      const k = nightly(['cargo', 'kani', '--version'], { cwd })
      if (k.code === 0) {
        const run = nightly(['cargo', 'kani', '--workspace'], { cwd })
        if (run.code !== 0) return { ok: false, line: 'Kani found a failing harness', out: run.out }
        steps.push(`Kani (${harnesses.length} file(s) with harnesses)`)
      } else steps.push(`Kani unavailable: ${harnesses.length} file(s) with harnesses not run`)
    }
    return { ok: true, line: steps.join(', ') }
  },

  fuzz() {
    const dirs = walk('core').filter((f) => /(^|\/)fuzz\/Cargo\.toml$/.test(f.split(path.sep).join('/'))).map((f) => path.dirname(path.dirname(f)))
    if (!dirs.length) return { ok: true, line: 'nothing to check (no cargo-fuzz targets under core/ yet)' }
    const secs = Number(process.env.MIDSTUDY_FUZZ_SECONDS || 60)
    const ran = []
    for (const d of dirs) {
      const cwd = path.join(ROOT, d)
      const list = nightly(['cargo', 'fuzz', 'list'], { cwd })
      if (list.code !== 0) return { ok: false, line: `cargo fuzz list failed in ${d}`, out: list.out }
      for (const t of list.out.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9_-]+$/.test(l))) {
        // New inputs and crashes go to build/fuzz/, never into the tracked corpus; the tracked corpus is read as seeds.
        const corpus = path.join(ROOT, 'build/fuzz', d, t, 'corpus')
        const artifacts = path.join(ROOT, 'build/fuzz', d, t, 'artifacts') + path.sep
        fs.mkdirSync(corpus, { recursive: true })
        fs.mkdirSync(artifacts, { recursive: true })
        const seeds = path.join(cwd, 'fuzz/corpus', t)
        const r = nightly(['cargo', 'fuzz', 'run', t, corpus, ...(fs.existsSync(seeds) ? [seeds] : []), '--', `-max_total_time=${secs}`, `-artifact_prefix=${artifacts}`], { cwd })
        if (r.code !== 0) return { ok: false, line: `fuzz target ${d}/${t} failed (artifacts in ${path.relative(ROOT, artifacts)})`, out: r.out }
        ran.push(`${t}`)
      }
    }
    return { ok: true, line: `${ran.length} target(s) × ${secs} s, no crash (${ran.join(', ')})` }
  },

  proofs() {
    if (!exists('proofs/lakefile.lean') && !exists('proofs/lakefile.toml')) return { ok: true, line: 'nothing to check (no proofs/ Lean project yet)' }
    const b = sh('lake', ['build'], { cwd: path.join(ROOT, 'proofs') })
    if (b.code !== 0) return { ok: false, line: 'lake build failed', out: b.out }
    const allowed = exists('proofs/axioms.txt') ? fs.readFileSync(path.join(ROOT, 'proofs/axioms.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean) : []
    const bad = []
    const files = walk('proofs').filter((f) => f.endsWith('.lean'))
    for (const f of files) {
      // Comments and strings stripped, so a `sorry` in prose does not count.
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/-[\s\S]*?-\//g, '').replace(/--.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""')
      for (const m of src.matchAll(/\b(sorry|admit)\b/g)) bad.push(`${f}: ${m[1]}`)
      for (const m of src.matchAll(/^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+)*axiom\s+([^\s:({[]+)/gm)) if (!allowed.includes(m[1])) bad.push(`${f}: axiom ${m[1]} (not in proofs/axioms.txt)`)
    }
    if (/declaration uses 'sorry'/.test(b.out)) bad.push("lake build: declaration uses 'sorry'")
    return { ok: bad.length === 0, line: bad.length ? `${bad.length} problem(s): ${bad.slice(0, 3).join('; ')}` : `lake build ok, ${files.length} .lean file(s), no sorry/admit, ${allowed.length} allowed axiom(s)`, out: bad.join('\n') }
  },
}

// A tsconfig as TypeScript reads it (comments, trailing commas), without following `extends`.
function readTsconfig(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const { config, error } = ts.parseConfigFileTextToJson(rel, text)
  if (error) throw new Error(`${rel}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`)
  return config
}

// glob → RegExp: ** any depth, * one segment, {a,b} alternatives (as scripts/check-ownership.mjs).
function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { re += '(?:.*/)?'; i++; if (g[i + 1] === '/') i++ } else if (c === '*') re += '[^/]*'
    else if (c === '{') { const j = g.indexOf('}', i); re += `(${g.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = j } else re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

let failed = 0
for (const name of wanted.length ? wanted : ORDER) {
  const t = performance.now()
  let res
  try { res = checks[name]() } catch (e) { res = { ok: false, line: `crashed: ${e.message}`, out: e.stack } }
  const secs = ((performance.now() - t) / 1000).toFixed(1)
  if ((!res.ok || VERBOSE) && res.out) console.log(tail(res.out, 120))
  console.log(`check:${name}: ${res.ok ? 'ok' : 'FAIL'} — ${res.line} (${secs} s)`)
  if (!res.ok) failed++
}
if (!wanted.length || wanted.length > 1) console.log(`check: ${failed ? `FAIL, ${failed} check(s) failed` : 'all ok'}`)
process.exit(failed ? 1 : 0)
