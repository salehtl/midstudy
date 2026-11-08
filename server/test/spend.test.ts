// SpendCap (contract §2.9): a reservation changes owner without being checked again, and a ledger that can't be read
// refuses paid calls instead of reading as $0.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { SpendCap } from '../src/spend.ts'
import { REPO } from './helpers.ts'

const DIR = path.join(REPO, 'evals/out/server-core-tests/spend-' + String(process.pid))
const COSTS = path.join(DIR, 'costs.csv')
const NOW = Date.UTC(2026, 10, 8, 12)
const DAY = '2026-11-08'

const cap = (usd: number): SpendCap => new SpendCap(COSTS, usd, () => NOW)
const rows = (usd: number): void => {
  fs.writeFileSync(COSTS, 'date,id,engine,cost_usd,mock,input\n' + DAY + 'T01:00:00Z,a,sam3d,' + String(usd) + ',false,x\n')
}

void describe('SpendCap', () => {
  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true })
    fs.mkdirSync(DIR, { recursive: true })
  })

  void test('transfer moves a reservation to a new key', () => {
    const s = cap(2)
    assert.equal(s.reserve('fetch-x', 1), null)
    s.transfer('fetch-x', 'l-1')
    assert.equal(s.view().reserved_usd, 1)
    s.release('fetch-x')
    assert.equal(s.view().reserved_usd, 1, 'the old key holds nothing')
    s.release('l-1')
    assert.equal(s.view().reserved_usd, 0)
  })

  void test('transfer succeeds where a fresh reserve of the same amount would be refused', () => {
    const s = cap(1)
    assert.equal(s.reserve('fetch-x', 1), null)
    rows(0.5)
    assert.notEqual(new SpendCap(COSTS, 1, () => NOW).reserve('probe', 1), null, 'a fresh reserve is refused once costs.csv grew')
    s.transfer('fetch-x', 'l-1')
    assert.equal(s.view().reserved_usd, 1)
  })

  void test('transfer from a key that holds nothing does nothing', () => {
    const s = cap(1)
    s.transfer('fetch-x', 'l-1')
    assert.equal(s.view().reserved_usd, 0)
  })

  void test('a missing costs.csv reads as 0', () => {
    const s = cap(1)
    assert.equal(s.spent(DAY), 0)
    assert.equal(s.reserve('k', 0.5), null)
  })

  void test('a costs.csv that cannot be read refuses paid calls and reports the cap as spent', () => {
    fs.mkdirSync(COSTS)
    const s = cap(1)
    const refused = s.reserve('k', 0.5)
    assert.notEqual(refused, null)
    assert.equal(refused?.spent_usd, 1)
    assert.equal(s.view().spent_usd, 1)
    assert.equal(s.view().reserved_usd, 0)
    assert.equal(s.reserve('free', 0), null, 'a $0 call never reads the ledger')
  })
})
