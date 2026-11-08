// Runner self-test: evals/all.mjs's signal handling and summary (MIDSTUDY_ALL_STEPS replaces its step list with tiny
// node one-liners) and evals/lib/gated_calib.py's two ways of giving up on a closed gate (MIDSTUDY_EVAL_CALIB_GATE_S).
// The gate's normal path is in evals/harness_selftest.mjs. No server, no browser, $0.
// Usage: node evals/runner_selftest.mjs   (or npm run eval:selftest-runner)
import { spawn } from 'node:child_process'
import path from 'node:path'
import { REPO, createEval, sleep } from './lib/harness.mjs'

const ev = createEval('H1', 'runner-selftest', { timeoutS: 150 })
const ALL = path.join(REPO, 'evals/all.mjs')
const GATED = path.join(REPO, 'evals/lib/gated_calib.py')

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = async (pid, ms) => { const end = Date.now() + ms; while (alive(pid) && Date.now() < end) await sleep(20); return !alive(pid) }
// Whatever a failing case leaves behind goes at the end, so a red run doesn't leak sleepers.
const leftovers = new Set()
ev.onCleanup(() => { for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } } })

// `steps` is all.mjs's list; {out(), waitOut(re), exited (promise of {code, signal, ms}), kill(sig)}.
function startAll(steps) {
  const t0 = Date.now()
  const p = spawn('node', [ALL], {
    cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MIDSTUDY_ALL_STEPS: JSON.stringify(steps) },
  })
  leftovers.add(p.pid)
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  const exited = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - t0 })))
  return {
    out: () => out, exited,
    kill: (sig) => p.kill(sig), // the runner alone, not its group
    waitOut: async (re, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = re.exec(out); if (m) return m; await sleep(20) } return null },
  }
}
// Waits for all.mjs, but a run that never ends is a failed check, not a hung self-test.
const settled = (run, ms) => Promise.race([run.exited, sleep(ms).then(() => ({ code: 'still running', signal: null, ms }))])
const stepPid = async (run) => { const m = await run.waitOut(/step-pid (\d+)/); const pid = m ? Number(m[1]) : 0; if (pid) leftovers.add(pid); return pid }

async function caseSigterm() {
  const run = startAll([
    ['X1', 'sleep', 'node', ['-e', "console.log('step-pid', process.pid); setInterval(() => {}, 1e3)"]],
    ['X2', 'after', 'node', ['-e', "console.log('X2-RAN')"]],
  ])
  const pid = await stepPid(run)
  ev.check('all.mjs: its step started and named its pid', pid > 0, `pid ${pid}`)
  run.kill('SIGTERM')
  const r = await settled(run, 10000)
  ev.check('all.mjs: SIGTERM to the runner alone ends the running step', pid > 0 && await gone(pid, 1000), `step ${pid} alive: ${pid > 0 && alive(pid)}`)
  ev.check('all.mjs: exits 130 after an interrupt', r.code === 130, `exit ${r.code} signal ${r.signal}`)
  ev.check('all.mjs: the summary marks the step interrupted', /summary[\s\S]*INTR X1 sleep.*interrupted by SIGTERM/.test(run.out()), run.out().slice(-300))
  ev.check('all.mjs: later steps do not start', !run.out().includes('X2-RAN') && !run.out().includes('eval:after'), run.out().slice(-200))
}

async function caseBurst() {
  const run = startAll([['X1', 'burst', 'node', ['-e', "let n = 0; process.on('SIGTERM', () => { console.log('TERM#' + ++n); setTimeout(() => process.exit(0), 1000) }); console.log('step-pid', process.pid); setInterval(() => {}, 1e3)"]]])
  const pid = await stepPid(run)
  run.kill('SIGTERM')
  await sleep(150)
  run.kill('SIGTERM')
  const r = await settled(run, 10000)
  ev.check('all.mjs: a repeat signal within 2 s is not forwarded', run.out().includes('TERM#1') && !run.out().includes('TERM#2'), (run.out().match(/TERM#\d/g) || []).join(' ') || 'no signal reached the step')
  ev.check('all.mjs: the burst still exits 130', r.code === 130, `exit ${r.code} signal ${r.signal}`)
  ev.check('all.mjs: the burst leaves no step behind', pid > 0 && await gone(pid, 1000), `step ${pid}`)
}

async function caseStubborn() {
  const run = startAll([['X1', 'stubborn', 'node', ['-e', "process.on('SIGTERM', () => {}); console.log('step-pid', process.pid); setInterval(() => {}, 1e3)"]]])
  const pid = await stepPid(run)
  const t0 = Date.now()
  run.kill('SIGTERM')
  const r = await settled(run, 60000)
  const secs = (Date.now() - t0) / 1000
  ev.check('all.mjs: a step that ignores the signal is killed after 50 s', r.code === 130 && secs >= 49 && secs < 56 && pid > 0 && await gone(pid, 1000), `exit ${r.code} after ${secs.toFixed(1)} s, step alive: ${pid > 0 && alive(pid)}`)
}

async function caseSummary() {
  const run = startAll([
    ['X1', 'silent', 'node', ['-e', 'process.exit(3)']],
    ['X2', 'fine', 'node', ['-e', "console.log('X2: 3/3 checks passed in 0.1 s')"]],
  ])
  const r = await settled(run, 15000)
  ev.check('all.mjs: a step that crashed before its summary says so', /FAIL X1 silent.*\(no summary line: exited 3 before its summary\)/.test(run.out()), run.out().slice(-300))
  ev.check('all.mjs: a scraped summary line is kept', /PASS X2 fine.*X2: 3\/3 checks passed/.test(run.out()), run.out().slice(-200))
  ev.check('all.mjs: a failed step exits 1, and the next step still ran', r.code === 1, `exit ${r.code}`)
}

const gatedEnv = (extra) => ({ ...process.env, MIDSTUDY_EVAL_CALIB_GATE: path.join(ev.out, 'never-opened'), MIDSTUDY_EVAL_CALIB_GATE_S: '1', MIDSTUDY_EVAL_CALIB_TARGET: 'true', ...extra })
function runGated(args, ms = 5000) {
  return new Promise((resolve) => {
    const p = spawn('python3', [GATED, ...args], { cwd: REPO, env: gatedEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    leftovers.add(p.pid)
    const t0 = Date.now()
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { p.kill('SIGKILL') }, ms)
    p.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, secs: (Date.now() - t0) / 1000, stdout, stderr }) })
  })
}
const lastJson = (s) => { try { return JSON.parse(s.trim().split('\n').at(-1)) } catch { return null } }

async function caseGate() {
  const SENTENCE = 'gated_calib: the gate was not opened within 1 s'
  const a = await runGated(['run', 'photo.jpg', '--out', 'x'])
  const answer = lastJson(a.stdout)
  ev.check('gated_calib: a timeout on a one-shot run exits 1 within 2 s', a.code === 1 && a.secs < 2, `exit ${a.code} ${a.signal ?? ''} in ${a.secs.toFixed(2)} s`)
  ev.check('gated_calib: the last stdout line is the contract failure', answer?.ok === false && answer?.error === SENTENCE, a.stdout.trim() || '(empty)')
  ev.check('gated_calib: stderr carries midstudy-calib: <sentence>', a.stderr.includes(`midstudy-calib: ${SENTENCE}`), a.stderr.trim() || '(empty)')
  const s = await runGated(['serve'])
  ev.check('gated_calib: a timeout on serve exits 2, the one-shot fallback', s.code === 2 && s.secs < 2, `exit ${s.code} ${s.signal ?? ''} in ${s.secs.toFixed(2)} s`)
}

async function caseParentDeath() {
  const env = gatedEnv({ MIDSTUDY_EVAL_CALIB_GATE_S: '30' })
  const sh = spawn('sh', ['-c', 'python3 "$0" run photo.jpg --out x & echo $!; sleep 0.2', GATED], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  sh.stdout.on('data', (d) => { out += d })
  await new Promise((resolve) => sh.on('exit', resolve)) // 'exit': the poller keeps the pipe open for as long as it lives
  const pid = Number(out.trim().split('\n')[0])
  if (pid) leftovers.add(pid)
  const ok = pid > 0 && await gone(pid, 1000)
  ev.check('gated_calib: a held poller is gone within 1 s of its parent', ok, `pid ${pid} alive: ${pid > 0 && alive(pid)}`)
}

ev.section('evals/all.mjs and evals/lib/gated_calib.py')
await Promise.all([caseSigterm(), caseBurst(), caseStubborn(), caseSummary(), caseGate(), caseParentDeath()])
await ev.finish()
