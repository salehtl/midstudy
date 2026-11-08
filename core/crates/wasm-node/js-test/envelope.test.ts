// The envelope's guards in core/js/node.ts: a malformed answer from our own wasm is a protocol fault (a thrown Error),
// never a MediaError or a value read from the wrong place. Hand-made envelopes go straight into the decoder, because the
// real kernels never write these. Run by `npm run test:kernels-node`, which needs build/wasm (`npm run build`).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeEnvelope, decodeGlbEnvelope, stripGlb, zipPlan } from '../../../js/node.ts'

const GLB = fileURLToPath(new URL('../../../../fixtures/library/test-cube/model.glb', import.meta.url))
const NO_CODES = [] as const
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]
const env = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes)

type Reader = Parameters<typeof decodeEnvelope>[2]
const oneU32: Reader = (p) => p.u32()

void test('a tag that is neither ok nor error is a protocol fault, not an error envelope', () => {
  assert.throws(() => decodeEnvelope(env(7, ...u32(0), 0), NO_CODES, oneU32), /unknown envelope tag/)
})

void test('an empty envelope is a protocol fault', () => {
  assert.throws(() => decodeEnvelope(env(), NO_CODES, oneU32), /unknown envelope tag/)
})

void test('an ok envelope shorter than its fields is a protocol fault', () => {
  assert.throws(() => decodeEnvelope(env(0), NO_CODES, oneU32), /shorter than its fields/)
  assert.throws(() => decodeEnvelope(env(0, 1, 2, 3), NO_CODES, oneU32), /shorter than its fields/)
})

void test('pieces whose own bytes run past the envelope are a protocol fault, not a truncated view', () => {
  const noBytes = 0xffff_ffff
  const short = env(0, ...u32(1), ...u32(noBytes), ...u32(4), 9, 9)
  assert.throws(() => decodeEnvelope(short, NO_CODES, (p) => p.pieces(new Uint8Array(8))), /shorter than its fields/)
})

void test('an error envelope shorter than its header or its code is a protocol fault', () => {
  assert.throws(() => decodeEnvelope(env(1), ['x'] as const, oneU32), /shorter than its fields/)
  assert.throws(() => decodeEnvelope(env(1, ...u32(0)), ['x'] as const, oneU32), /shorter than its fields/)
  assert.throws(() => decodeEnvelope(env(1, ...u32(0), 5, 0x78), ['x'] as const, oneU32), /shorter than its fields/)
})

void test('a well-formed error envelope is still a refusal', () => {
  const r = decodeEnvelope(env(1, ...u32(3), 1, 0x78, 0x68, 0x69), ['x'] as const, oneU32)
  assert.deepEqual(r, { ok: false, error: { code: 'x', offset: 3, message: 'hi' } })
})

void test('fields left unread are a protocol fault', () => {
  assert.throws(() => decodeEnvelope(env(0, ...u32(1), ...u32(2)), NO_CODES, oneU32), /trailing bytes/)
})

void test('exact readers and rest readers pass', () => {
  assert.deepEqual(decodeEnvelope(env(0, ...u32(9)), NO_CODES, oneU32), { ok: true, value: 9 })
  const r = decodeEnvelope(env(0, 1, 2), NO_CODES, (p) => [...p.rest()])
  assert.deepEqual(r, { ok: true, value: [1, 2] })
})

void test('zipPlan reports the entry index of an entry out of range', () => {
  const good = { name: new TextEncoder().encode('a.obj'), flags: 0, uncompressedSize: 1, externalAttributes: 0 }
  const r = zipPlan([good, good, { ...good, flags: -1 }])
  assert.equal(r.ok, false)
  assert.equal(r.ok ? null : r.error.code, 'bad-input')
  assert.equal(r.ok ? null : r.error.offset, 2)
})

/** An ok glb_strip envelope with no images around `rest`. */
const glbEnvelope = (rest: number[]): Uint8Array => env(0, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...rest)
const glbHeader = (magic: string, version: number, length: number): number[] =>
  [...new TextEncoder().encode(magic), ...u32(version), ...u32(length)]

void test('a real GLB round-trips through stripGlb, in both layouts', () => {
  const input = new Uint8Array(readFileSync(GLB))
  for (const layout of ['compact', 'in-place'] as const) {
    const r = stripGlb(input, { layout })
    assert.equal(r.ok, true)
    if (!r.ok) continue
    assert.deepEqual([...r.value.bytes.subarray(0, 4)], [...new TextEncoder().encode('glTF')])
    const again = stripGlb(r.value.bytes, { layout })
    assert.equal(again.ok, true)
  }
})

void test('stripGlb refuses an answer that is not a whole GLB', () => {
  const fault = /not a whole GLB/
  assert.throws(() => decodeGlbEnvelope(glbEnvelope([1, 2, 3])), fault)
  assert.throws(() => decodeGlbEnvelope(glbEnvelope(glbHeader('nope', 2, 12))), fault)
  assert.throws(() => decodeGlbEnvelope(glbEnvelope(glbHeader('glTF', 1, 12))), fault)
  assert.throws(() => decodeGlbEnvelope(glbEnvelope(glbHeader('glTF', 2, 99))), fault)
  const ok = decodeGlbEnvelope(glbEnvelope(glbHeader('glTF', 2, 12)))
  assert.equal(ok.ok, true)
})
