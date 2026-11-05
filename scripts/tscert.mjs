#!/usr/bin/env node
// The `tscert` command (nix/tscert.nix runs this file under TScert's pinned Node 26.13.0, with its Lean 4.33.1, OCaml
// and dune on PATH). TScert is https://github.com/cristianoc/TScert at the commit nix/tscert.nix pins (NON-AI MIT
// licence: used as a checker only). Everything it builds or caches stays in the git-ignored build/tscert/.
//
//   tscert build                 build TScert into build/tscert/ (npm ci in tools/, lake build, dune build, the stage
//                                runner); a no-op when the stamp matches the pinned commit and toolchain
//   tscert check FILE [--project TSCONFIG] [--omit f,g]
//                                TScert's own CLI (pipeline/verify-source.mts): its JSON outcome; exit 0 when verified
//   tscert units --batch JOBS.json
//                                one result per function and per module initialization (scripts/tscert-ratchet.mjs
//                                uses it): JSON on stdout
//   tscert version               the pinned commit and the toolchain
//
// Exit codes: 0 ok/verified, 1 not verified or a failed step, 2 usage.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'build/tscert')
// The built TScert tree (read-only, in the Nix store) through its out-link.
const SRC = path.join(BUILD, 'result')
const STAMP = path.join(BUILD, 'stamp.json')
const env = process.env
const need = (k) => { if (!env[k]) { console.error(`tscert: ${k} is not set: run me through the \`tscert\` command of the dev shell (nix/tscert.nix)`); process.exit(2) } return env[k] }

// TScert's caches and temporary runs, kept out of ~ and out of the system temp directory.
function sandboxEnv() {
  for (const d of ['stages', 'tmp', 'cache', 'npm-cache']) fs.mkdirSync(path.join(BUILD, d), { recursive: true })
  return {
    ...env,
    TSCERT_STAGE_STORE: env.TSCERT_STAGE_STORE || path.join(BUILD, 'stages'),
    TMPDIR: path.join(BUILD, 'tmp'),
    XDG_CACHE_HOME: path.join(BUILD, 'cache'),
    npm_config_cache: path.join(BUILD, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    DUNE_CACHE: 'disabled',
  }
}

function toolchain() {
  const v = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8' }).trim().split('\n')[0] } catch { return null } }
  return { rev: need('TSCERT_REV'), node: process.version, lean: v('lean', ['--version']), ocaml: v('ocaml', ['-version']), dune: v('dune', ['--version']) }
}

// TScert itself is the flake's `.#tscert` (nix/tscert.nix `built`): built in the Nix sandbox, kept alive by the out-link
// build/tscert/result. A no-op when the out-link already points at the pinned build.
function build({ quiet = false } = {}) {
  const want = toolchain()
  const link = path.join(BUILD, 'result')
  const current = () => { try { return fs.readFileSync(path.join(link, '.tscert-rev'), 'utf8').trim() === want.rev } catch { return false } }
  if (!current()) {
    fs.mkdirSync(BUILD, { recursive: true })
    const t = performance.now()
    process.stderr.write(`tscert build: nix build .#tscert at ${want.rev.slice(0, 12)} (the Lean verifier takes a while the first time) … `)
    const r = spawnSync('nix', ['build', `${ROOT}#tscert`, '--out-link', link, '--print-build-logs'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 512 << 20 })
    if (r.error || r.status !== 0 || !current()) {
      process.stderr.write('FAILED\n')
      console.error((r.error?.message || '') + (r.stderr || '').slice(-6000))
      process.exit(1)
    }
    process.stderr.write(`${((performance.now() - t) / 1000).toFixed(0)} s\n`)
  }
  fs.writeFileSync(STAMP, `${JSON.stringify({ ...want, built: fs.realpathSync(link) }, null, 1)}\n`)
  if (!quiet) console.log(`tscert: built at ${want.rev.slice(0, 12)} (${fs.realpathSync(link)})`)
}

// One result per function, each checked on its own: the function selected and every other function of the file (and
// the module initialization) omitted, so they are read at their declared signatures; the same for the module
// initialization (INIT: constants, classes, arrow functions bound at the top level). A refusal is then that unit's own,
// never a neighbour's: TScert's gate names the first unreviewed library member of the selected code, at the first
// mention of its global, which in a whole-file check can sit in another function. `functions` are the file's
// top-level function declarations; `init` says whether the file has initialization code.
const INIT = '(init)'
async function units(job, vs, fp) {
  const { file, project, functions, init } = job
  const names = [...functions.map((f) => f.name), ...(init ? [INIT] : [])]
  const toTscert = (n) => (n === INIT ? fp.initOmission : n)
  const clean = (d) => String(d ?? '').replace(/\/nix\/var\/nix\/builds\/[^\s"')]*\/work\//g, '').replace(/\/[^\s"')]*tscert-runs-[^\s"')]*/g, '<run>').slice(0, 2000)
  const one = async (name) => {
    let o
    try {
      o = await vs.checkApart(path.resolve(file), project ? path.resolve(project) : undefined, false, undefined, false,
        { omitted: names.filter((n) => n !== name).map(toTscert), select: [toTscert(name)] })
    } catch (e) {
      return { status: 'error', phase: '-', detail: clean(String(e?.message || e).split('\n')[0]) }
    }
    const res = { status: o.status, phase: o.phase, detail: clean(o.detail) }
    const unit = (o.units ?? []).find((u) => u.members.some((m) => (vs.memberName(m) === fp.initOmission ? INIT : vs.memberName(m)) === name))
    try { o[Symbol.dispose]?.() } catch { /* best effort */ }
    return unit ? { status: unit.status, phase: unit.phase, detail: clean(unit.detail), unit: unit.unit, members: unit.members } : res
  }
  const done = await Promise.all(names.map(async (n) => [n, await one(n)]))
  return Object.fromEntries(done)
}

const [cmd, ...rest] = process.argv.slice(2)
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined }
switch (cmd) {
  case 'build':
    build()
    break
  case 'version':
    console.log(JSON.stringify(toolchain()))
    break
  case 'check': {
    const file = rest[0]
    if (!file) { console.error('usage: tscert check FILE [--project TSCONFIG] [--omit f,g]'); process.exit(2) }
    build({ quiet: true })
    const argv = [path.join(SRC, 'pipeline/verify-source.mts'), path.resolve(file)]
    if (opt('--project')) argv.push('--project', path.resolve(opt('--project')))
    if (opt('--omit')) argv.push('--omit', opt('--omit'))
    const r = spawnSync(process.execPath, argv, { stdio: 'inherit', env: sandboxEnv() })
    process.exit(r.status ?? 1)
    break
  }
  case 'units': {
    // tscert units --batch JOBS.json: JOBS is [{file, project, functions: [{name, start, end}], init}]; prints
    // {file: {name: {status, phase, detail, …}}} as JSON. Files are checked concurrently (TScert's worker pool).
    const batch = opt('--batch')
    if (!batch) { console.error('usage: tscert units --batch JOBS.json'); process.exit(2) }
    build({ quiet: true })
    Object.assign(process.env, sandboxEnv())
    const vs = await import(pathToFileURL(path.join(SRC, 'pipeline/verify-source.mts')).href)
    const fp = await import(pathToFileURL(path.join(SRC, 'tools/fragment-parse.mts')).href)
    const jobs = JSON.parse(fs.readFileSync(batch, 'utf8'))
    const done = await Promise.all(jobs.map(async (j) => [j.file, await units(j, vs, fp)]))
    process.stdout.write(`${JSON.stringify(Object.fromEntries(done))}\n`)
    process.exit(0)
    break
  }
  default:
    console.error('usage: tscert build | check FILE [--project TSCONFIG] [--omit f,g] | units --batch JOBS.json | version')
    process.exit(2)
}
