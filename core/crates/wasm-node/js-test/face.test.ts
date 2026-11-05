// Tests core/js/node.ts against the wasm build in build/wasm/node/ (build it with core/crates/wasm-node/build-node.sh):
// every function on known inputs, the wasm outputs against the native build (examples/difftool) on the GPS-canary
// corpus diff_v1.py leaves in evals/out/media-diff/corpus/, and random inputs into every export (a panic in wasm would
// throw "RuntimeError: unreachable").
//
//   nix develop -c node --test core/crates/wasm-node/js-test/face.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkHost, compareNames, contentLength, decodeImageDataUri, decodeMeta, hostName, isRenderName, isSceneName, isSlug,
  jpegFrame, jpegIsClean, jpegPassthrough, normalizePath, originOk, photoExt, pngSize, reduceLeadingSlashes, sniff,
  staticRoute, stripGlb, stripJpeg, stripPng, zipPlan,
} from '../../../js/node.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const bytes = (...parts: (number[] | Uint8Array | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : [...p])))
const seg = (marker: number, payload: Uint8Array): Uint8Array => bytes([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload)

/** A tiny structurally valid JPEG: JFIF, SOF0 (w x h, 3 components), one scan with a stuffed byte and a restart. */
function tinyJpeg(w: number, h: number, extra: Uint8Array = new Uint8Array()): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    seg(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 72, 0, 72, 0, 0])),
    extra,
    seg(0xc0, bytes([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])),
    seg(0xda, bytes([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56],
    [0xff, 0xd9],
  )
}

void test('sniff', () => {
  assert.equal(sniff(tinyJpeg(1, 1)), 'jpeg')
  assert.equal(sniff(bytes([0x89], 'PNG\r\n\x1a\n')), 'png')
  assert.equal(sniff(bytes([0, 0, 0, 24], 'ftypmif1', [0, 0, 0, 0], 'heic')), 'heif')
  assert.equal(sniff(bytes([0, 0, 0, 20], 'ftypmif1', [0, 0, 0, 0], 'avif')), 'unknown')
  assert.equal(sniff(bytes('glTF')), 'glb')
  assert.equal(photoExt('heif'), 'heic')
  assert.equal(photoExt('glb'), null)
})

void test('JPEG: strip, frame, clean, pass-through', () => {
  const clean = tinyJpeg(640, 480)
  const exif = seg(0xe1, bytes('Exif\0\0TestCam GPS'))
  const dirty = bytes(tinyJpeg(640, 480, bytes(exif, seg(0xfe, bytes('comment')))), 'after EOI')
  const s = stripJpeg(dirty)
  assert.ok(s.ok)
  assert.deepEqual(s.value.bytes, clean)
  assert.deepEqual(s.value.removed, { appSegments: 1, app0Segments: 0, jfifTrimmed: 0, comments: 1, fillBytes: 0, trailingBytes: 9 })
  const f = jpegFrame(dirty)
  assert.ok(f.ok)
  assert.deepEqual(f.value, { width: 640, height: 480, components: 3, precision: 8, marker: 0xc0 })
  assert.equal(jpegIsClean(clean), true)
  assert.equal(jpegIsClean(dirty), false)
  assert.equal(jpegPassthrough(clean).ok, true)
  const big = jpegPassthrough(tinyJpeg(4000, 3000))
  assert.ok(!big.ok)
  assert.equal(big.error.code, 'too-large')
  const cut = stripJpeg(clean.subarray(0, clean.length - 2))
  assert.ok(!cut.ok)
  assert.equal(cut.error.code, 'truncated')
  assert.equal(typeof cut.error.offset, 'number')
  const none = jpegFrame(bytes([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0]))
  assert.ok(!none.ok)
  assert.equal(none.error.code, 'scan-before-frame')
})

void test('PNG: strip and size', () => {
  const chunk = (kind: string, body: number[]): Uint8Array => bytes([0, 0, 0, body.length], kind, body, [0, 0, 0, 0])
  const head = bytes([0x89], 'PNG\r\n\x1a\n', chunk('IHDR', [0, 0, 0, 7, 0, 0, 0, 5, 8, 2, 0, 0, 0]))
  const tail = bytes(chunk('IDAT', [1, 2]), chunk('IEND', []))
  const dirty = bytes(head, chunk('tEXt', [...new TextEncoder().encode('GPS')]), chunk('eXIf', [1]), tail, 'x')
  const s = stripPng(dirty)
  assert.ok(s.ok)
  assert.deepEqual(s.value.bytes, bytes(head, tail))
  assert.deepEqual(s.value.removed, { exif: 1, text: 1, time: 0, trailingBytes: 1 })
  assert.deepEqual(pngSize(dirty), { width: 7, height: 5 })
  assert.equal(pngSize(bytes('nope')), null)
})

void test('GLB: strip a texture, both layouts', () => {
  const image = tinyJpeg(2, 2, seg(0xe1, new Uint8Array(200).fill(71)))
  const geometry = new Uint8Array(8).fill(1)
  const pad = (n: number): number => (4 - (n % 4)) % 4
  const bin = bytes(geometry, image, new Uint8Array(pad(image.length)), new Uint8Array(8).fill(2))
  const after = 8 + image.length + pad(image.length)
  const json = JSON.stringify({
    asset: { version: '2.0' }, images: [{ bufferView: 1, mimeType: 'image/jpeg' }],
    bufferViews: [{ buffer: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: image.length }, { buffer: 0, byteOffset: after, byteLength: 8 }],
    buffers: [{ byteLength: bin.length }],
  })
  const j = bytes(json, ' '.repeat(pad(json.length)))
  const le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
  const body = bytes(le(j.length), 'JSON', j, le(bin.length + pad(bin.length)), [0x42, 0x49, 0x4e, 0], bin, new Uint8Array(pad(bin.length)))
  const glb = bytes('glTF', le(2), le(12 + body.length), body)
  const compact = stripGlb(glb)
  const inPlace = stripGlb(glb, { layout: 'in-place' })
  assert.ok(compact.ok && inPlace.ok)
  assert.equal(compact.value.report.layout, 'compact')
  assert.equal(inPlace.value.report.layout, 'in-place')
  assert.equal(inPlace.value.bytes.length, glb.length)
  assert.ok(compact.value.bytes.length <= glb.length - 192) // 204 bytes freed: 192 removed, 12 kept as padding
  assert.deepEqual(compact.value.report.images, [
    { image: 0, source: 'buffer-view', view: 1, kind: 'jpeg', bytesBefore: image.length, bytesAfter: image.length - 204, changed: true },
  ])
  const again = stripGlb(compact.value.bytes)
  assert.ok(again.ok)
  assert.equal(again.value.report.changed, false)
  const bad = stripGlb(glb.subarray(0, 40))
  assert.ok(!bad.ok)
  assert.equal(bad.error.code, 'length')
})

void test('data URIs and X-Midstudy-Meta', () => {
  const d = decodeImageDataUri('data:image/jpeg;base64,/9j/', 'jpeg')
  assert.ok(d.ok)
  assert.deepEqual(d.value, bytes([0xff, 0xd8, 0xff]))
  const wrong = decodeImageDataUri('data:image/png;base64,/9j/', 'jpeg')
  assert.ok(!wrong.ok)
  assert.equal(wrong.error.code, 'not-data-uri')
  const m = decodeMeta(Buffer.from('{"title": "Lounge é"}').toString('base64'))
  assert.ok(m.ok)
  assert.equal(m.value, '{"title": "Lounge é"}')
  const sp = decodeMeta('eyJ0 aXRsZSI6IDF9')
  assert.ok(!sp.ok)
  assert.equal(sp.error.code, 'base64')
  const long = decodeMeta('QUJD', 3)
  assert.ok(!long.ok)
  assert.equal(long.error.code, 'too-long')
})

void test('paths and routes', () => {
  assert.equal(normalizePath('/./library/costs.csv'), '/library/costs.csv')
  assert.equal(normalizePath('/%2e%2e/%2E/x?q'), '/x')
  assert.equal(normalizePath('/a%00b'), null)
  assert.equal(reduceLeadingSlashes('///x'), '/x')
  assert.deepEqual(staticRoute('/'), { kind: 'redirect-to-planner' })
  assert.deepEqual(staticRoute('/planner/'), { kind: 'planner', path: '', trailingSlash: true })
  assert.deepEqual(staticRoute('/library/library.json'), { kind: 'library-json' })
  assert.deepEqual(staticRoute('/library/chair/splat.spz'), { kind: 'library', id: 'chair', file: 'splat.spz' })
  assert.deepEqual(staticRoute('/scenes/s-1/depth.png'), { kind: 'scene', name: 's-1', file: 'depth.png' })
  assert.deepEqual(staticRoute('/renders/r.jpg'), { kind: 'render', file: 'r.jpg' })
  for (const hidden of ['/library/costs.csv', '/Library/costs.csv', '/library/x/source.jpg', '/scenes/s/calib.json', '/.env', '/%2e%65nv', '/fixtures/photos/a.jpg']) {
    assert.deepEqual(staticRoute(hidden), { kind: 'not-found' }, hidden)
  }
})

void test('names', () => {
  assert.equal(isSlug('a-b'), true)
  assert.equal(isSlug('evil\n'), false)
  assert.equal(isSceneName('scene-20261104-201500-2'), true)
  assert.equal(isRenderName('render-20261104-201500'), true)
  assert.equal(compareNames('scene-20261104-201500-10', 'scene-20261104-201500-9'), 1)
  const sorted = ['scene-20261104-201500-10', 'scene-20261104-201500', 'scene-20261104-201500-9'].sort(compareNames)
  assert.deepEqual(sorted, ['scene-20261104-201500', 'scene-20261104-201500-9', 'scene-20261104-201500-10'])
})

void test('HTTP framing', () => {
  assert.deepEqual(contentLength([]), { ok: true, value: null })
  assert.deepEqual(contentLength([' 12 ']), { ok: true, value: 12 })
  assert.deepEqual(contentLength(['999999999999999']), { ok: true, value: 999999999999999 })
  const two = contentLength(['1', '1'])
  assert.ok(!two.ok)
  assert.equal(two.error.code, 'multiple')
  const sq = contentLength(['²'])
  assert.ok(!sq.ok)
  assert.equal(sq.error.code, 'not-digits')
  assert.equal(hostName('[::1]:8765'), '[::1]')
  assert.equal(hostName('127.0.0.1:80@evil.example'), null)
  assert.equal(checkHost(['localhost:9'], []), 'allowed')
  assert.equal(checkHost(['homeserver'], ['homeserver']), 'allowed')
  assert.equal(checkHost(['evil.example'], ['homeserver']), 'unknown')
  assert.equal(checkHost([], []), 'missing')
  assert.equal(checkHost(['a', 'b'], []), 'multiple')
  assert.equal(originOk({ xMidstudy: '1', host: '127.0.0.1:1' }), true)
  assert.equal(originOk({ xMidstudy: '1', origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' }), true)
  assert.equal(originOk({ xMidstudy: '1', origin: 'http://evil', host: '127.0.0.1:1' }), false)
  assert.equal(originOk({ origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' }), false)
})

void test('zip plans', () => {
  const file = 0o100644 * 65536
  const e = (name: string, size: number | bigint = 10, externalAttributes = file, flags = 0) => ({ name: new TextEncoder().encode(name), flags, uncompressedSize: size, externalAttributes })
  const ok = zipPlan([e('m/'), e('m/chair.obj'), e('m/chair.mtl'), e('m/wood.PNG', 5n)])
  assert.deepEqual(ok, { ok: true, value: { obj: 1, totalBytes: 25, extract: [1, 2, 3], skip: [0] } })
  const climb = zipPlan([e('a.obj'), e('../b.png')])
  assert.ok(!climb.ok)
  assert.deepEqual(climb.error, { code: 'climbs', offset: 1, message: 'the zip holds a path that climbs out of it (../b.png): re-zip the folder' })
  const big = zipPlan([e('a.obj', 600_000_000)])
  assert.ok(!big.ok)
  assert.equal(big.error.message, 'the zip unpacks to 600 MB, at most 500 MB is allowed')
  const link = zipPlan([e('a.obj', 1, 0o120777 * 65536)])
  assert.ok(!link.ok)
  assert.equal(link.error.code, 'link')
  const neg = zipPlan([e('a.obj', -1)])
  assert.ok(!neg.ok)
  assert.equal(neg.error.code, 'bad-input')
})

void test('the wasm build writes what the native build writes (GPS-canary corpus)', (t) => {
  const corpus = join(REPO, 'evals/out/media-diff/corpus')
  const tool = join(REPO, 'core/target/release/examples/difftool')
  if (!existsSync(corpus) || !existsSync(tool)) {
    t.skip('run core/crates/media/tests/diff_v1.py first (it builds the corpus; the difftool is built for it)')
    return
  }
  const files = readdirSync(corpus).map((f) => join(corpus, f))
  const ops = files.map((f) => (f.endsWith('.glb') ? 'glb-compact' : f.endsWith('.png') ? 'png-strip' : 'jpeg-strip'))
  const input = files.map((f, k) => `${ops[k] ?? ''}\t@${f}`).join('\n') + '\n'
  const run = spawnSync(tool, [], { input, encoding: 'utf8', maxBuffer: 1 << 30 })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.trim().split('\n')
  assert.equal(lines.length, files.length)
  files.forEach((f, k) => {
    const native: unknown = JSON.parse(lines[k] ?? '{}')
    assert.ok(typeof native === 'object' && native !== null)
    const hex: unknown = Reflect.get(native, 'hex')
    const data = readFileSync(f)
    const wasm = ops[k] === 'glb-compact' ? stripGlb(data) : ops[k] === 'png-strip' ? stripPng(data) : stripJpeg(data)
    if (typeof hex !== 'string') {
      assert.equal(wasm.ok, false, f)
      return
    }
    assert.ok(wasm.ok, f)
    assert.equal(Buffer.from(wasm.value.bytes).toString('hex'), hex, f)
  })
})

void test('random input never throws', () => {
  let seed = 7
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed % n
  }
  const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rand(256))
  const prefixes = [bytes([0xff, 0xd8]), bytes([0x89], 'PNG\r\n\x1a\n'), bytes('glTF', [2, 0, 0, 0]), new Uint8Array()]
  for (let i = 0; i < 3000; i++) {
    const b = bytes(prefixes[i % prefixes.length] ?? [], randomBytes(rand(200)))
    const s = Buffer.from(randomBytes(rand(40))).toString('latin1')
    sniff(b)
    stripJpeg(b)
    jpegFrame(b)
    jpegIsClean(b)
    jpegPassthrough(b)
    stripPng(b)
    pngSize(b)
    stripGlb(b)
    stripGlb(b, { layout: 'in-place' })
    decodeImageDataUri(`data:image/jpeg;base64,${s}`, 'jpeg')
    decodeMeta(s)
    normalizePath(s)
    staticRoute(`/${s}`)
    isSlug(s)
    compareNames(s, 'scene-20261104-201500')
    contentLength([s])
    hostName(s)
    checkHost([s], ['homeserver'])
    originOk({ xMidstudy: s, origin: s, host: s })
    zipPlan([{ name: b, flags: rand(2) * 0x800, uncompressedSize: rand(1000), externalAttributes: rand(2 ** 31) }])
  }
})
