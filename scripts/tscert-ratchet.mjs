#!/usr/bin/env node
// The TScert ratchet (docs/REFACTOR.md §3 check:tscert; docs/notes/tscert.md): TScert over the pure logic modules named
// by tscert/config.json, one result per top-level function and per module initialization, written to
// tscert/report.json (git-ignored). Every function in tscert/baseline.json must still certify; new ones may join it.
//
//   node scripts/tscert-ratchet.mjs            check: exit 1 when a baselined function no longer certifies
//   node scripts/tscert-ratchet.mjs --update   rewrite tscert/baseline.json with everything that certifies now
//   options: --config FILE (default tscert/config.json), --report FILE, --baseline FILE, --no-baseline
//
// TScert itself runs inside the Nix sandbox (nix/tscert.nix runUnits, built on first use: about 6 minutes), under its
// pinned Node 26.13.0 with its Lean-built verifier. Prints one summary line: `tscert: <certified>/<total> certified …`.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const UPDATE = argv.includes('--update')
const NO_BASELINE = argv.includes('--no-baseline')
const CONFIG = path.resolve(ROOT, opt('--config', 'tscert/config.json'))
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const fromConfig = (p) => path.resolve(path.dirname(CONFIG), p)
const REPORT = path.resolve(ROOT, opt('--report', config.report ? path.relative(ROOT, fromConfig(config.report)) : 'tscert/report.json'))
const BASELINE = path.resolve(ROOT, opt('--baseline', 'tscert/baseline.json'))
const INIT = '(init)'
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

// glob → RegExp (as scripts/check-ownership.mjs): ** any depth, * one segment, {a,b} alternatives.
function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') { i++; re += '(?:/)?' } } else if (c === '*') re += '[^/]*'
    else if (c === '{') { const j = g.indexOf('}', i); re += `(${g.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = j } else re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
function walk(dir, out = []) {
  let es
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['node_modules', 'dist', '.lake'].includes(e.name)) walk(p, out) } else if (e.isFile()) out.push(p)
  }
  return out
}

// The files: each area's glob (relative to the repo, or to the config file when `base` is "config").
const jobs = []
for (const area of config.areas) {
  const base = area.base === 'config' ? path.dirname(CONFIG) : ROOT
  const re = globRe(area.glob)
  const segs = area.glob.split('/')
  const firstGlob = segs.findIndex((s) => /[*{]/.test(s))
  const top = path.join(base, segs.slice(0, firstGlob < 0 ? segs.length - 1 : firstGlob).join('/'))
  for (const f of walk(top).filter((f) => re.test(path.relative(base, f).split(path.sep).join('/')) && !f.endsWith('.d.ts')).sort()) {
    jobs.push({ file: f, project: path.resolve(base, area.project) })
  }
}
if (!jobs.length) {
  console.log(`tscert: nothing to check (no file matches ${config.areas.map((a) => a.glob).join(', ')})`)
  process.exit(0)
}

// Each file's top-level function declarations (TScert's module functions) and whether it has initialization code.
let ts
try { ts = (await import('typescript')).default } catch { console.error('tscert: typescript missing: run `nix develop -c npm install`'); process.exit(1) }
for (const j of jobs) {
  const text = fs.readFileSync(j.file, 'utf8')
  const sf = ts.createSourceFile(j.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  j.functions = []
  j.init = false
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) j.functions.push({ name: st.name.text, start: st.getStart(sf), end: st.end })
    else if (ts.isFunctionDeclaration(st) || ts.isImportDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue
    else if (ts.isExportDeclaration(st) && (st.isTypeOnly || !st.moduleSpecifier)) continue
    else if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue
    else j.init = true
  }
}

// TScert, once for every file, inside the Nix sandbox (nix/tscert.nix runUnits): a copy of the inputs is checked by
// the built TScert as the Nix build user, never as you, and the result is a store path, so an unchanged tree is read
// back at once. Paths in the jobs are relative to the repository.
const jobsFile = path.join(ROOT, 'build/tscert/jobs.json')
fs.mkdirSync(path.dirname(jobsFile), { recursive: true })
fs.writeFileSync(jobsFile, JSON.stringify(jobs.map((j) => ({ ...j, file: rel(j.file), project: rel(j.project) }))))
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'flake.lock'), 'utf8')).nodes.nixpkgs.locked
const inputDirs = ['tscert', 'planner/logic', 'server/src/logic', 'pipeline/src/logic', 'contract/gen', ...new Set(jobs.map((j) => rel(path.dirname(j.file))))]
const nixList = (xs) => `[ ${xs.map((x) => JSON.stringify(x)).join(' ')} ]`
const expr = `
let
  root = ${ROOT};
  pkgs = (builtins.getFlake "github:${lock.owner}/${lock.repo}/${lock.rev}").legacyPackages.\${builtins.currentSystem};
  lib = pkgs.lib;
  t = import ${ROOT}/nix/tscert.nix { inherit pkgs; };
  files = ${nixList(['package.json', 'tsconfig.base.json', 'tsconfig.planner.json', 'tsconfig.server.json', 'tsconfig.pipeline.json', 'scripts/tscert.mjs', 'build/tscert/jobs.json'])};
  dirs = ${nixList(inputDirs)};
  skip = ${nixList(['tscert/report.json', 'tscert/experiments/report.json'])};
  rel = p: lib.removePrefix (toString root + "/") (toString p);
  under = r: d: r == d || lib.hasPrefix (d + "/") r;
  above = r: x: lib.hasPrefix (r + "/") x;
in
t.runUnits {
  src = builtins.path {
    path = root;
    name = "tscert-input";
    filter = p: type: let r = rel p; in
      !(builtins.elem r skip) && (builtins.elem r files || lib.any (d: under r d) dirs
        || (type == "directory" && lib.any (x: above r x) (files ++ dirs)));
  };
}`
const t0 = performance.now()
const r = spawnSync('nix', ['build', '--impure', '--no-link', '--print-out-paths', '--expr', expr], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 })
if (r.error || r.status !== 0) {
  console.error((r.error?.message || '') + (r.stderr || '').split('\n').filter((l) => !/^(warning: Git tree|copying path|building ')/.test(l)).slice(-40).join('\n'))
  console.error('tscert: the sandboxed TScert run failed (nix build of nix/tscert.nix runUnits)')
  process.exit(1)
}
let byFile
try { byFile = JSON.parse(fs.readFileSync(r.stdout.trim().split('\n').at(-1), 'utf8')) } catch (e) { console.error(`tscert: unreadable result: ${e.message}`); process.exit(1) }
for (const j of jobs) byFile[j.file] = byFile[rel(j.file)]
const secs = ((performance.now() - t0) / 1000).toFixed(0)

const results = {}
for (const j of jobs) for (const [name, res] of Object.entries(byFile[j.file] ?? {})) {
  results[`${rel(j.file)}#${name}`] = { status: res.status, phase: res.phase, ...(res.status === 'verified' ? {} : { detail: res.detail }) }
}
const keys = Object.keys(results).sort()
const certified = keys.filter((k) => results[k].status === 'verified')
const rev = /rev = "([0-9a-f]{40})"/.exec(fs.readFileSync(path.join(ROOT, 'nix/tscert.nix'), 'utf8'))?.[1] ?? ''
fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, `${JSON.stringify({ tscert: rev, certified: certified.length, total: keys.length, functions: Object.fromEntries(keys.map((k) => [k, results[k]])) }, null, 1)}\n`)

if (NO_BASELINE) {
  console.log(`tscert: ${certified.length}/${keys.length} certified (${jobs.length} files, ${secs} s; report ${rel(REPORT)})`)
  process.exit(0)
}
if (UPDATE) {
  fs.writeFileSync(BASELINE, `${JSON.stringify({ doc: 'Every function here must keep certifying (scripts/tscert-ratchet.mjs; docs/notes/tscert.md). Rewritten by --update.', functions: certified }, null, 1)}\n`)
  console.log(`tscert: ${certified.length}/${keys.length} certified; baseline rewritten (${rel(BASELINE)}, ${secs} s)`)
  process.exit(0)
}
let baseline = []
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).functions } catch { /* none yet */ }
const lost = baseline.filter((k) => results[k]?.status !== 'verified')
const fresh = certified.filter((k) => !baseline.includes(k))
if (lost.length) {
  for (const k of lost) console.log(`  no longer certifies: ${k}: ${results[k] ? `${results[k].status} (${results[k].phase}) ${String(results[k].detail ?? '').split('\n')[0]}` : 'gone (removed or renamed: update the baseline on purpose)'}`)
  console.log(`tscert: FAIL, ${lost.length} baselined function(s) no longer certify; ${certified.length}/${keys.length} certified (${secs} s)`)
  process.exit(1)
}
console.log(`tscert: ${certified.length}/${keys.length} certified, all ${baseline.length} baselined still certify${fresh.length ? `, ${fresh.length} new (add them: --update)` : ''} (${jobs.length} files, ${secs} s)`)
