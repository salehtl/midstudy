// scripts/lib/stamps.mjs: when a build's stamp says "current", and when a finished build may write one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide, PRUNE_GRACE_MS } from '../lib/stamps.mjs'

const stat = (key, mtimeMs) => ({ key, mtimeMs })
const MISSING = stat('missing', null)
const BUILD_START = 1_000_000

test('an unchanged tree is current', () => {
  assert.equal(decide({ inputs: { a: '1:5', b: 'missing' } }, { a: stat('1:5', 5), b: MISSING }), 'current')
})

test('a changed input is stale', () => {
  assert.equal(decide({ inputs: { a: '1:5' } }, { a: stat('1:6', 6) }), 'stale')
})

test('a recorded missing input that now exists is stale', () => {
  assert.equal(decide({ inputs: { 'core/Cargo.lock': 'missing' } }, { 'core/Cargo.lock': stat('9:7', 7) }), 'stale')
})

test('an input the stamp never saw is stale', () => {
  assert.equal(decide({ inputs: { a: '1:5' } }, { a: stat('1:5', 5), 'core/crates/geom/data.bin': stat('2:6', 6) }), 'stale')
})

test('a recorded input that has gone is stale', () => {
  assert.equal(decide({ inputs: { a: '1:5' } }, { a: MISSING }), 'stale')
})

test('after a build: untouched inputs may be stamped', () => {
  assert.equal(decide(null, { a: stat('1:5', BUILD_START - 1) }, BUILD_START), 'write')
})

test('after a build: an input saved during it is not stamped', () => {
  assert.equal(decide(null, { a: stat('1:5', 5), b: stat('1:9', BUILD_START + 1) }, BUILD_START), 'do-not-write')
})

test('after a build: an input that disappeared is not stamped', () => {
  assert.equal(decide(null, { a: MISSING }, BUILD_START), 'do-not-write')
  assert.equal(decide({ inputs: { a: '1:5' } }, { a: MISSING }, BUILD_START), 'do-not-write')
})

test('after a build: an input missing since before it may be stamped', () => {
  assert.equal(decide({ inputs: { 'core/Cargo.lock': 'missing' } }, { 'core/Cargo.lock': MISSING }, BUILD_START), 'write')
})

test('files of older builds stay for a day', () => {
  assert.equal(PRUNE_GRACE_MS, 24 * 60 * 60_000)
})
