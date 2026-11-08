// midstudy-add's commit (docs/notes/state-machines-plan.md, wave 2 pipeline-commit): nothing in the library changes
// until the item, library.json and the summary are known good; a failed step puts everything back.
//
//   nix develop -c node --test pipeline/test/commit.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { keepPaidOutputs, swapIn, type SwapOps } from '../src/commit.ts'
import { load, prepareUpsert, writeLibrary } from '../src/library.ts'
import { dict, entry, str } from '../src/logic/pyjson.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRATCH = path.join(REPO, 'evals/out/pipeline-commit-test')
const CLI = path.join(REPO, 'pipeline/src/cli.ts')

function fresh(name: string): string {
  const dir = path.join(SCRATCH, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** `midstudy-add` with fal mocked and strict mode on. */
function cli(args: readonly string[]): { readonly code: number | null; readonly stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_STRICT: '1' }
  delete env['FAL_KEY']
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
  return { code: r.status, stderr: r.stderr }
}

function addIdol(lib: string): { readonly code: number | null; readonly stderr: string } {
  return cli([path.join(REPO, 'fixtures/fal/speridlabs-idol/input.jpg'), '--name', 'Chair', '--dims', '80x90x95', '--library', lib])
}

function addSam3d(lib: string): { readonly code: number | null; readonly stderr: string } {
  return cli([path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg'), '--name', 'Chair', '--dims', '80x90x95', '--engine', 'sam3d', '--library', lib])
}

const BAD_LIBRARY = `${JSON.stringify({ version: 1, items: [{ id: 'not valid', extra: true }] }, null, 2)}\n`

function bytes(file: string): string {
  return fs.readFileSync(file).toString('base64')
}

void test('a strict violation in library.json refuses the add before the library is touched', () => {
  const lib = fresh('strict-add')
  const file = path.join(lib, 'library.json')
  fs.writeFileSync(file, BAD_LIBRARY)
  const r = addIdol(lib)
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stderr, /contract violation/)
  assert.equal(fs.existsSync(path.join(lib, 'chair')), false)
  assert.equal(fs.readFileSync(file, 'utf8'), BAD_LIBRARY)
  assert.equal(fs.existsSync(path.join(lib, 'costs.csv')), false)
})

void test('--rescale: a replace that fails puts every file back and leaves library.json alone', () => {
  const lib = fresh('rescale-fail')
  const added = addSam3d(lib)
  assert.equal(added.code, 0, added.stderr)
  const item = path.join(lib, 'chair')
  const glb = bytes(path.join(item, 'model.glb'))
  const ply = bytes(path.join(item, 'splat.ply'))
  const library = fs.readFileSync(path.join(lib, 'library.json'), 'utf8')
  fs.rmSync(path.join(item, 'splat.spz'))
  fs.mkdirSync(path.join(item, 'splat.spz'))
  const r = cli(['--rescale', 'chair', '--yaw', '90', '--library', lib])
  assert.equal(r.code, 1, r.stderr)
  assert.equal(bytes(path.join(item, 'model.glb')), glb)
  assert.equal(bytes(path.join(item, 'splat.ply')), ply)
  assert.equal(fs.readFileSync(path.join(lib, 'library.json'), 'utf8'), library)
  assert.deepEqual(fs.readdirSync(item).filter((n) => n.includes('.bak-')), [])
})

void test('--rescale in strict mode: a library that breaks the schema changes no asset file', () => {
  const lib = fresh('rescale-strict')
  const added = addSam3d(lib)
  assert.equal(added.code, 0, added.stderr)
  const item = path.join(lib, 'chair')
  const glb = bytes(path.join(item, 'model.glb'))
  const file = path.join(lib, 'library.json')
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(typeof data === 'object' && data !== null && 'items' in data && Array.isArray(data.items))
  const items: unknown[] = data.items
  fs.writeFileSync(file, `${JSON.stringify({ ...data, items: [...items, { id: 'not valid' }] }, null, 2)}\n`)
  const before = fs.readFileSync(file, 'utf8')
  const r = cli(['--rescale', 'chair', '--yaw', '90', '--library', lib])
  assert.equal(r.code, 1, r.stderr)
  assert.equal(bytes(path.join(item, 'model.glb')), glb)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

/** A library holding item `chair` (with raw/), and a finished staging folder for a new one. */
function swapFixture(name: string, withRaw: boolean): { readonly lib: string; readonly item: string; readonly staging: string } {
  const root = fresh(name)
  const lib = path.join(root, 'lib')
  const item = path.join(lib, 'chair')
  const staging = path.join(root, 'staging')
  fs.mkdirSync(path.join(item, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(item, 'model.glb'), 'old model')
  fs.writeFileSync(path.join(item, 'raw', 'engine.glb'), 'old raw')
  fs.mkdirSync(staging)
  fs.writeFileSync(path.join(staging, 'model.glb'), 'new model')
  if (withRaw) {
    fs.mkdirSync(path.join(staging, 'raw'))
    fs.writeFileSync(path.join(staging, 'raw', 'new.glb'), 'new raw')
  }
  return { lib, item, staging }
}

/** Real file operations, the `failAt`-th mutating one throwing before it acts (a failing move leaves a partial copy). */
function failingOps(failAt: number): SwapOps {
  let step = 0
  const hit = (): boolean => ++step === failAt
  return {
    rename: (from, to) => {
      if (hit()) throw new Error(`step ${String(failAt)} failed`)
      fs.renameSync(from, to)
    },
    move: (from, to) => {
      if (hit()) {
        fs.mkdirSync(to)
        fs.writeFileSync(path.join(to, 'partial'), 'x')
        throw new Error(`step ${String(failAt)} failed`)
      }
      fs.renameSync(from, to)
    },
    exists: (p) => fs.existsSync(p),
    remove: (p) => { fs.rmSync(p, { recursive: true, force: true }) },
  }
}

function assertOldItem(item: string): void {
  assert.equal(fs.readFileSync(path.join(item, 'model.glb'), 'utf8'), 'old model')
  assert.equal(fs.readFileSync(path.join(item, 'raw', 'engine.glb'), 'utf8'), 'old raw')
}

for (const carryRaw of [false, true]) {
  // move, rename the old item aside, (carry raw/,) rename the new one into place
  for (let k = 1; k <= (carryRaw ? 4 : 3); k++) {
    void test(`swapIn with step ${String(k)} failing (carryRaw ${String(carryRaw)}): the old item is whole and only the outputs remain`, () => {
      const { lib, item, staging } = swapFixture(`swap-${String(carryRaw)}-${String(k)}`, !carryRaw)
      const r = swapIn(staging, item, lib, carryRaw, failingOps(k))
      assert.equal(r.ok, false)
      assert.ok(!r.ok)
      assert.match(r.error.message, /failed/)
      assertOldItem(item)
      assert.equal(fs.readFileSync(path.join(r.outputs, 'model.glb'), 'utf8'), 'new model')
      const leftovers = fs.readdirSync(lib).filter((n) => n.startsWith('.'))
      assert.deepEqual(leftovers, k === 1 ? [] : [path.basename(r.outputs)])
    })
  }
}

void test('swapIn puts the new item in place, carries raw/, and undo restores the old one', () => {
  const { lib, item, staging } = swapFixture('swap-ok', false)
  const r = swapIn(staging, item, lib, true)
  assert.ok(r.ok)
  assert.equal(fs.readFileSync(path.join(item, 'model.glb'), 'utf8'), 'new model')
  assert.equal(fs.readFileSync(path.join(item, 'raw', 'engine.glb'), 'utf8'), 'old raw')
  const outputs = r.undo()
  assertOldItem(item)
  assert.equal(fs.readFileSync(path.join(outputs, 'model.glb'), 'utf8'), 'new model')
  assert.deepEqual(fs.readdirSync(lib).filter((n) => n.startsWith('.')), [path.basename(outputs)])
})

void test('swapIn finish drops the old item', () => {
  const { lib, item, staging } = swapFixture('swap-finish', true)
  const r = swapIn(staging, item, lib, false)
  assert.ok(r.ok)
  r.finish()
  assert.equal(fs.readFileSync(path.join(item, 'raw', 'new.glb'), 'utf8'), 'new raw')
  assert.deepEqual(fs.readdirSync(lib).filter((n) => n.startsWith('.')), [])
})

function itemNamed(id: string): ReturnType<typeof dict> {
  return dict([entry('id', str(id))])
}

void test('prepareUpsert reads library.json when it is called, not from an earlier snapshot, and writes nothing', async () => {
  const lib = fresh('prepare')
  writeLibrary(lib, '{"version": 1, "items": []}\n')
  load(lib)
  // another writer, after this run loaded the library
  writeLibrary(lib, '{"version": 1, "items": [{"id": "other"}]}\n')
  const before = fs.readFileSync(path.join(lib, 'library.json'), 'utf8')
  const r = await prepareUpsert(lib, itemNamed('mine'))
  assert.equal(r.replaced, false)
  assert.match(r.text, /"other"/)
  assert.match(r.text, /"mine"/)
  assert.equal(fs.readFileSync(path.join(lib, 'library.json'), 'utf8'), before)
})

void test('a paid failure keeps the outputs first, and a cost row that fails does not lose them', async () => {
  const { lib, staging } = swapFixture('paid-keep', true)
  const r = await keepPaidOutputs(staging, lib, 'chair', '2026-01-01T00:00:00Z', () => Promise.reject(new Error('costs locked')))
  assert.ok(r.kept !== null)
  assert.equal(fs.readFileSync(path.join(r.kept, 'raw', 'new.glb'), 'utf8'), 'new raw')
  assert.equal(path.basename(r.kept), 'chair-2026-01-01T000000Z')
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0] ?? '', /cost row could not be written.*costs locked/)
})

void test('a move that fails still records the cost', async () => {
  const { lib, staging } = swapFixture('paid-move', true)
  let recorded = false
  const r = await keepPaidOutputs(staging, lib, 'chair', '2026-01-01T00:00:00Z', () => { recorded = true; return Promise.resolve() }, failingOps(1))
  assert.equal(r.kept, null)
  assert.equal(recorded, true)
  assert.match(r.problems[0] ?? '', /could not be kept/)
})

void test('the unwind of a paid run fits the server\'s kill grace (a cross-volume copy of 64 MB, under 3 s)', async () => {
  const { lib, staging } = swapFixture('paid-time', true)
  fs.writeFileSync(path.join(staging, 'raw', 'big.ply'), Buffer.alloc(64 * 1024 * 1024, 7))
  const ops: SwapOps = {
    ...failingOps(0),
    move: (from, to) => {
      fs.cpSync(from, to, { recursive: true })
      fs.rmSync(from, { recursive: true, force: true })
    },
  }
  const t = Date.now()
  const r = await keepPaidOutputs(staging, lib, 'chair', '2026-01-01T00:00:00Z', () => Promise.resolve(), ops)
  assert.ok(r.kept !== null)
  assert.ok(Date.now() - t < 3000, `took ${String(Date.now() - t)} ms`)
  fs.rmSync(r.kept, { recursive: true })
})
