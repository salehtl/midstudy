// scripts/tscert-ratchet.mjs's run lock. A copy of the ratchet runs in a throwaway tree with a PATH shim for `nix` that
// answers from the jobs file it reads, as the sandboxed run does (it reads the jobs file some time after the ratchet
// wrote it).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = path.resolve(import.meta.dirname, '../..')

const NIX_SHIM = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const jobsFile = 'build/tscert/jobs.json'
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.NIX_SHIM_SLEEP_MS))
if (process.env.NIX_SHIM_SWAP === '1') fs.writeFileSync(jobsFile, JSON.stringify(JSON.parse(fs.readFileSync(jobsFile, 'utf8')).slice(0, 1)))
const result = {}
for (const job of JSON.parse(fs.readFileSync(jobsFile, 'utf8'))) {
  result[job.file] = Object.fromEntries(job.functions.map((f) => [f.name, { status: 'verified', phase: 'done' }]))
}
const out = path.resolve('build/tscert/shim-result-' + process.pid + '.json')
fs.writeFileSync(out, JSON.stringify(result))
console.log(out)
`

const BASELINED = ['app/logic/a.ts#a', 'app/logic/b.ts#b']

function tree(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tscert-lock-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (rel, text, mode) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text, mode === undefined ? {} : { mode })
  }
  for (const rel of ['scripts/tscert-ratchet.mjs', 'scripts/lib/dirlock.mjs', 'common/logic/lock.ts', 'flake.lock', 'nix/tscert.nix', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel))
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'))
  write('tsconfig.app.json', '{}\n')
  write('tscert/config.json', JSON.stringify({ areas: [{ glob: 'app/logic/*.ts', project: 'tsconfig.app.json' }] }))
  write('tscert/baseline.json', JSON.stringify({ functions: BASELINED }))
  write('app/logic/a.ts', 'export function a(): number { return 1 }\n')
  write('app/logic/b.ts', 'export function b(): number { return 2 }\n')
  write('shims/nix', NIX_SHIM, 0o755)
  return root
}

function ratchet(root, args, env = {}) {
  const child = spawn(process.execPath, ['scripts/tscert-ratchet.mjs', ...args], {
    cwd: root,
    env: { ...process.env, PATH: `${path.join(root, 'shims')}:${process.env.PATH}`, NIX_SHIM_SLEEP_MS: '3000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (b) => { out += String(b) })
  child.stderr.on('data', (b) => { out += String(b) })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

async function untilExists(file) {
  for (let i = 0; i < 1500 && !fs.existsSync(file); i++) await sleep(10)
  assert.ok(fs.existsSync(file), `${file} never appeared`)
}

test('a --files run during a full run waits, and the full run still sees every baselined function', async (t) => {
  const root = tree(t)
  const full = ratchet(root, [])
  await untilExists(path.join(root, 'build/tscert/jobs.json'))
  const some = await ratchet(root, ['--files', 'app/logic/a.ts'], { NIX_SHIM_SLEEP_MS: '0' })
  const whole = await full
  assert.equal(whole.code, 0, whole.out)
  assert.match(whole.out, /2\/2 certified, all 2 baselined still certify/)
  assert.doesNotMatch(whole.out, /gone/)
  assert.equal(some.code, 0, some.out)
  assert.match(some.out, /certified app\/logic\/a\.ts#a/)
  assert.equal(fs.existsSync(path.join(root, 'build/locks/tscert.lock')), false, 'the lock is given back')
})

test('jobs swapped under a full run exit 1 with the reason, not as a lost function', async (t) => {
  const root = tree(t)
  const r = await ratchet(root, [], { NIX_SHIM_SWAP: '1', NIX_SHIM_SLEEP_MS: '0' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /the jobs file changed under this run/)
  assert.doesNotMatch(r.out, /gone/)
  assert.equal(fs.existsSync(path.join(root, 'build/locks/tscert.lock')), false, 'an exit path gives the lock back')
})

test('jobs swapped under a full --update do not shrink the baseline', async (t) => {
  const root = tree(t)
  const before = fs.readFileSync(path.join(root, 'tscert/baseline.json'), 'utf8')
  const r = await ratchet(root, ['--update'], { NIX_SHIM_SWAP: '1', NIX_SHIM_SLEEP_MS: '0' })
  assert.equal(r.code, 1, r.out)
  assert.equal(fs.readFileSync(path.join(root, 'tscert/baseline.json'), 'utf8'), before)
})

test('two --update runs take turns', async (t) => {
  const root = tree(t)
  const runs = await Promise.all([ratchet(root, ['--update']), ratchet(root, ['--update'], { NIX_SHIM_SLEEP_MS: '0' })])
  for (const r of runs) assert.equal(r.code, 0, r.out)
  assert.ok(runs.some((r) => /waiting for the tscert lock/.test(r.out)), runs.map((r) => r.out).join('\n'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tscert/baseline.json'), 'utf8')).functions, BASELINED)
})
