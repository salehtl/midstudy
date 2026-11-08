// The model's spend hold (contract §2.11 Money): a call whose cost row could not be written stays held against today's
// cap, and its answer is still used. The FalError branch can't be reached with fal mocked (falCall isn't injectable).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { before, beforeEach, describe, test } from 'node:test'
import type { ServerDeps } from '../src/deps.ts'
import { Deadline } from '../src/product/errors.ts'
import { Ctx } from '../src/product/layers.ts'
import { runLlm } from '../src/product/llm.ts'
import { SpendCap } from '../src/spend.ts'
import { REPO, SCRATCH } from './helpers.ts'

const DIR = path.join(SCRATCH, 'product-llm-' + String(process.pid))
const LEDGER = path.join(DIR, 'costs.csv')
const LLM_RESERVE = 0.002
const LINES = ['This cabinet stands 120 tall, 90 across and 40 deep, all in centimetres.']
const URL = 'https://shop.example/p/teak-cabinet-prose'

const depsWith = (spend: SpendCap, costsFile: string): ServerDeps => ({
  config: {
    repo: REPO, host: '127.0.0.1', port: 0,
    scenesDir: path.join(DIR, 'scenes'), roomsDir: path.join(DIR, 'rooms'), layoutsDir: path.join(DIR, 'layouts'), rendersDir: path.join(DIR, 'renders'), libraryDir: DIR,
    costsFile, calib: ['true'], midstudyAdd: ['true'], dailySpendUsd: 1, allowedHosts: [], socketTimeoutSeconds: 30,
  },
  spend,
  onShutdown: () => undefined,
})

void describe('runLlm spend hold', () => {
  before(() => {
    if (!fs.existsSync(path.join(REPO, 'build/wasm/product'))) throw new Error('build/wasm/product is missing: run npm run build')
    process.env['MIDSTUDY_FAL_MOCK'] = 'fixtures/fal'
    process.env['MIDSTUDY_FAL_MOCK_COST'] = '1'
    process.env['MIDSTUDY_NO_DOTENV'] = '1'
    process.env['NOOK_NO_DOTENV'] = '1'
  })

  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true })
    fs.mkdirSync(DIR, { recursive: true })
  })

  void test('a cost row that cannot be written keeps the hold, warns, and still returns the answer', async () => {
    const unwritable = path.join(DIR, 'costs-dir')
    fs.mkdirSync(unwritable)
    const spend = new SpendCap(LEDGER, 1)
    const warnings: string[] = []
    const got = await runLlm(URL, LINES, new Ctx(false, null, warnings), depsWith(spend, unwritable), new Deadline())
    assert.equal(spend.view().reserved_usd, LLM_RESERVE, 'held against today')
    assert.ok(warnings.some((w) => w.includes('could not be recorded')), warnings.join('; '))
    assert.equal(got.asked, true)
    assert.equal(got.sizes.length, 1)
  })

  void test('a recorded call releases its hold and writes the row', async () => {
    const spend = new SpendCap(LEDGER, 1)
    const got = await runLlm(URL, LINES, new Ctx(false, null, []), depsWith(spend, LEDGER), new Deadline())
    assert.equal(spend.view().reserved_usd, 0)
    assert.match(fs.readFileSync(LEDGER, 'utf8'), /product:llm/)
    assert.equal(got.sizes.length, 1)
  })
})
