// scripts/check.mjs's set-up flags and its generated-files gate. Each test runs the working tree's check.mjs in a
// throwaway tree; PATH shims stand in for the tools (uv, pyright, ruff).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const REPO = path.resolve(import.meta.dirname, '../..')
const CHECK = path.join(REPO, 'scripts/check.mjs')

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, mode === undefined ? {} : { mode })
}

function runCheck(root, name, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs'), name], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

/** A tree with just what check.mjs itself needs to start. */
function bareTree(t) {
  const root = tempDir(t, 'check-tree-')
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(CHECK, path.join(root, 'scripts/check.mjs'))
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'))
  return root
}

/** A detached worktree of HEAD running the working tree's check.mjs. */
function worktree(t) {
  const root = path.join(tempDir(t, 'check-worktree-'), 'tree')
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', root, 'HEAD'], { cwd: REPO })
  t.after(() => execFileSync('git', ['worktree', 'remove', '--force', root], { cwd: REPO }))
  fs.copyFileSync(CHECK, path.join(root, 'scripts/check.mjs'))
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'))
  return root
}

function driftSchema(root) {
  const file = path.join(root, 'contract/calib.schema.json')
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
  schema.properties.drifted_for_a_test = { type: 'string' }
  fs.writeFileSync(file, JSON.stringify(schema, null, 2) + '\n')
}

const GEN_OUTPUTS = ['contract/gen', 'core/crates/contract']
const genStatus = (root) => execFileSync('git', ['status', '--porcelain', '--', ...GEN_OUTPUTS], { cwd: root, encoding: 'utf8' })

test('check:gen fails on a drifted schema and leaves the generated files alone', (t) => {
  const root = worktree(t)
  assert.equal(runCheck(root, 'gen').status, 0, 'a clean tree passes')
  driftSchema(root)
  const r = runCheck(root, 'gen')
  assert.equal(r.status, 1)
  assert.equal(genStatus(root), '')
})

test('check:gen still fails on generated files that were regenerated but not committed', (t) => {
  const root = worktree(t)
  driftSchema(root)
  execFileSync(process.execPath, ['scripts/gen-contract.mjs'], { cwd: root })
  const before = genStatus(root)
  assert.notEqual(before, '')
  assert.equal(runCheck(root, 'gen').status, 1)
  assert.equal(genStatus(root), before)
})

function pyTree(t) {
  const root = bareTree(t)
  write(path.join(root, 'calib/pyproject.toml'), '[tool.pyright]\n')
  fs.mkdirSync(path.join(root, 'calib/.venv/bin'), { recursive: true })
  const shims = path.join(root, 'shims')
  const log = path.join(root, 'tools.log')
  for (const tool of ['uv', 'pyright', 'ruff']) {
    write(path.join(shims, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\n[ "${tool}" != uv ] || exit "\${UV_SHIM_EXIT:-0}"\n`, 0o755)
  }
  return { root, log, env: { PATH: `${shims}:${process.env.PATH}` } }
}

test('check:py syncs an existing venv, without removing the optional extras', (t) => {
  const { root, log, env } = pyTree(t)
  assert.equal(runCheck(root, 'py', env).status, 0)
  const uv = fs.readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('uv '))
  assert.equal(uv, 'uv sync --project calib --frozen --inexact --quiet')
})

test('check:py fails when the sync fails', (t) => {
  const { root, env } = pyTree(t)
  assert.equal(runCheck(root, 'py', { ...env, UV_SHIM_EXIT: '1' }).status, 1)
})

const MANIFEST = (rev) => JSON.stringify({ packages: [{ name: 'aesop', rev: 'other' }, { name: 'mathlib', rev }] })

function proofsTree(t, rev) {
  const root = bareTree(t)
  const dir = path.join(root, 'proofs')
  const log = path.join(root, 'fetches.log')
  write(path.join(dir, 'lakefile.toml'), '')
  write(path.join(dir, 'lake-manifest.json'), MANIFEST(rev))
  write(path.join(dir, 'check.sh'), '#!/bin/sh\necho "check:proofs: fine"\n', 0o755)
  write(path.join(dir, 'run.sh'), `#!/bin/sh\necho "$*" >> "${log}"\nmkdir -p "${dir}/.lake/packages/mathlib/.lake/build"\nexit "\${FETCH_EXIT:-0}"\n`, 0o755)
  const fetches = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0)
  return { root, dir, fetches, marker: path.join(root, 'build/check/mathlib-cache.json') }
}

test('check:proofs does not take a partial Mathlib for a finished fetch', (t) => {
  const { root, fetches, marker } = proofsTree(t, 'rev1')
  assert.equal(runCheck(root, 'proofs', { FETCH_EXIT: '1' }).status, 1)
  assert.equal(fs.existsSync(marker), false, 'a failed fetch records nothing')
  assert.equal(runCheck(root, 'proofs').status, 0)
  assert.equal(fetches(), 2, 'the partial build directory left by the failed fetch does not stop the next one')
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { rev: 'rev1' })
})

test('check:proofs fetches once per Mathlib rev, and again when the marker or the files are gone', (t) => {
  const { root, dir, fetches, marker } = proofsTree(t, 'rev1')
  assert.equal(runCheck(root, 'proofs').status, 0)
  assert.equal(runCheck(root, 'proofs').status, 0)
  assert.equal(fetches(), 1, 'a matching marker skips the fetch')
  write(path.join(dir, 'lake-manifest.json'), MANIFEST('rev2'))
  assert.equal(runCheck(root, 'proofs').status, 0)
  assert.equal(fetches(), 2, 'a new rev fetches')
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { rev: 'rev2' })
  fs.rmSync(marker)
  assert.equal(runCheck(root, 'proofs').status, 0)
  assert.equal(fetches(), 3, 'no marker fetches')
  fs.rmSync(path.join(dir, '.lake/packages/mathlib/.lake/build'), { recursive: true })
  assert.equal(runCheck(root, 'proofs').status, 0)
  assert.equal(fetches(), 4, 'a marker without the files fetches')
})
