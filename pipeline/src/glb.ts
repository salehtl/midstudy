// model.glb (contract §1, §2.8, §3.4; v1's glb.py), with glTF-Transform: a .glb or .gltf is read (external files and
// data URIs packed in), its default scene's roots are wrapped in two nodes (the engine's orientation, then the item
// frame's per-axis scale and translation), and it is written as one GLB whose textures lose their camera metadata
// (the media kernels' stripGlb). Bounds are measured as v1 measured them (trimesh): every POSITION vertex of the
// points, lines, triangles and strips the default scene draws, through each node's world matrix.
//
// The stand-in box of a splat-only item is written byte for byte as v1 wrote it (it depends on nothing but the dims).
import fs from 'node:fs'
import path from 'node:path'

import { Document, Format, GLB_BUFFER, Logger, NodeIO } from '@gltf-transform/core'
import type { GLTF, Node } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

import { stripGlb } from '../../core/js/node.ts'
import { MidstudyError } from './errors.ts'
import { isFile } from '../../common/files.ts'
import { errorsPct, glbFlat, glbSelfCheck, itemFrame } from './logic/fit.ts'
import type { Bounds } from './logic/fit.ts'
import { quatXyzw } from './logic/frames.ts'
import type { Mat3, Vec3 } from './logic/frames.ts'
import { dict, dumps, entry, float, int, list, parse, plain, str } from './logic/pyjson.ts'
import type { PyValue } from './logic/pyjson.ts'
import { suffix } from './logic/pypath.ts'
import { decodeUtf8 } from '../../common/utf8.ts'

let ioInstance: NodeIO | null = null

/** glTF-Transform's reader and writer, with every Khronos extension and no log output. */
export function io(): NodeIO {
  ioInstance ??= new NodeIO().registerExtensions(ALL_EXTENSIONS).setLogger(new Logger(Logger.Verbosity.SILENT))
  return ioInstance
}

const UNSUPPORTED = ['EXT_meshopt_compression', 'KHR_draco_mesh_compression']
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isGltf(v: unknown): v is GLTF.IGLTF {
  return isRecord(v)
}

/** Python's `urllib.parse.unquote` of a relative URI (UTF-8, malformed escapes kept). */
function unquote(s: string): string {
  return s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Uint8Array.from(run.match(/%[0-9A-Fa-f]{2}/g) ?? [], (h) => Number.parseInt(h.slice(1), 16))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  })
}

/** v1's `_uri_bytes` for a file URI next to the model. */
function uriBytes(uri: string, base: string): Uint8Array<ArrayBuffer> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    throw new MidstudyError(`the glTF links a remote file (${uri}); download it next to the .gltf first`)
  }
  const p = path.join(base, unquote(uri))
  if (!isFile(p)) {
    throw new MidstudyError(`the glTF links ${uri}, which isn't next to it: put the .gltf and its files in one local folder and pass that path, or use a .glb`)
  }
  return new Uint8Array(fs.readFileSync(p))
}

/** v1's `read_glb` + `load_model`: the model as a Document, refusing what v1 refused with its sentences. */
async function loadModel(file: string): Promise<Document> {
  let json: PyValue
  let blob: Uint8Array<ArrayBuffer> | null = null
  const bytes = new Uint8Array(fs.readFileSync(file))
  if (suffix(file).toLowerCase() === '.gltf') {
    const text = decodeUtf8(bytes)
    if (!text.ok) throw new MidstudyError(`${file} is not valid glTF JSON (${text.error})`)
    const parsed = parse(text.text)
    if (!parsed.ok) throw new MidstudyError(`${file} is not valid glTF JSON (${parsed.error})`)
    json = parsed.value
  } else {
    if (bytes.length < 20 || bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) {
      throw new MidstudyError(`${file} is not a GLB file (bad header)`)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const version = view.getUint32(4, true)
    if (version !== 2) throw new MidstudyError(`${file} is glTF ${String(version)}; only glTF 2.0 is supported`)
    const end = Math.min(view.getUint32(8, true), bytes.length)
    let off = 12
    let found: PyValue | null = null
    while (off + 8 <= end) {
      const size = view.getUint32(off, true)
      const kind = view.getUint32(off + 4, true)
      const chunk = bytes.subarray(off + 8, Math.min(off + 8 + size, bytes.length))
      off += 8 + size
      if (kind === JSON_CHUNK && found === null) {
        const text = decodeUtf8(chunk)
        if (!text.ok) throw new MidstudyError(`${file} is not valid glTF JSON (${text.error})`)
        const parsed = parse(text.text)
        if (!parsed.ok) throw new MidstudyError(`${file} is not valid glTF JSON (${parsed.error})`)
        found = parsed.value
      } else if (kind === BIN_CHUNK && blob === null) {
        blob = new Uint8Array(chunk)
      }
    }
    if (found === null) throw new MidstudyError(`${file} has no JSON chunk`)
    json = found
  }
  const doc = plain(json)
  if (!isGltf(doc)) throw new MidstudyError(`${file} is not glTF 2.0`)
  const asset: unknown = doc.asset
  const version: unknown = isRecord(asset) ? asset['version'] : undefined
  const versionText = typeof version === 'number' ? String(version) : typeof version === 'string' ? version : ''
  if (!versionText.startsWith('2')) throw new MidstudyError(`${file} is not glTF 2.0`)
  const used = Array.isArray(doc.extensionsUsed) ? doc.extensionsUsed : []
  const bad = UNSUPPORTED.filter((x) => used.includes(x))
  if (bad.length > 0) throw new MidstudyError(`the model uses ${bad.join(', ')}; re-export it without mesh compression`)
  const buffers = doc.buffers ?? []
  const first = buffers[0]
  if (buffers.length === 1 && first !== undefined && first.uri === undefined && blob !== null && blob.length < first.byteLength) {
    throw new MidstudyError(`${file} is truncated (binary chunk is ${String(blob.length)} of ${String(first.byteLength)} bytes)`)
  }
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {}
  const base = path.dirname(file)
  for (const [i, b] of buffers.entries()) {
    if (b.uri !== undefined && !b.uri.startsWith('data:')) resources[b.uri] = uriBytes(b.uri, base)
    else if (b.uri === undefined && (i !== 0 || blob === null)) throw new MidstudyError(`${file}: buffer ${String(i)} has no data`)
  }
  for (const im of doc.images ?? []) {
    if (im.uri !== undefined && !im.uri.startsWith('data:')) resources[im.uri] = uriBytes(im.uri, base)
  }
  if (blob !== null) resources[GLB_BUFFER] = blob
  try {
    return await io().readJSON({ json: doc, resources })
  } catch (e) {
    throw new MidstudyError(`couldn't read the model's geometry (${detail(e)}); the file may be corrupt`)
  }
}

function detail(e: unknown): string {
  if (e instanceof Error) return e.message === '' ? e.name : `${e.name}: ${e.message}`
  return String(e)
}

/** The default scene's bounds as trimesh measures them, or null when it draws no geometry. */
function measure(doc: Document): Bounds | null {
  const root = doc.getRoot()
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode()
      if ((mode === 0 || mode === 1 || mode === 4 || mode === 5) && prim.getAttribute('POSITION') === null) {
        throw new MidstudyError("couldn't read the model's geometry (KeyError: 'POSITION'); the file may be corrupt")
      }
    }
  }
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  if (scene === undefined) return null
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  const seen = { geometry: false }
  const visit = (node: Node): void => {
    const mesh = node.getMesh()
    if (mesh !== null) {
      const m = node.getWorldMatrix()
      for (const prim of mesh.listPrimitives()) {
        const mode = prim.getMode()
        if (mode !== 0 && mode !== 1 && mode !== 4 && mode !== 5) continue
        const pos = prim.getAttribute('POSITION')
        const a = pos?.getArray()
        if (pos === null || a === null || a === undefined || pos.getCount() === 0) continue
        const stride = pos.getElementSize()
        const n = pos.getCount()
        const mn = [Infinity, Infinity, Infinity]
        const mx = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < n; i++) {
          const x = a[i * stride] ?? 0
          const y = stride > 1 ? (a[i * stride + 1] ?? 0) : 0
          const z = stride > 2 ? (a[i * stride + 2] ?? 0) : 0
          for (let r = 0; r < 3; r++) {
            const v = (m[r] ?? 0) * x + (m[4 + r] ?? 0) * y + (m[8 + r] ?? 0) * z
            if (v < (mn[r] ?? 0)) mn[r] = v
            if (v > (mx[r] ?? 0)) mx[r] = v
          }
        }
        for (let r = 0; r < 3; r++) {
          const t = m[12 + r] ?? 0
          lo[r] = Math.min(lo[r] ?? 0, (mn[r] ?? 0) + t)
          hi[r] = Math.max(hi[r] ?? 0, (mx[r] ?? 0) + t)
        }
        seen.geometry = true
      }
    }
    for (const child of node.listChildren()) visit(child)
  }
  for (const node of scene.listChildren()) visit(node)
  if (!seen.geometry) return null
  return { lo: [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0], hi: [hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0] }
}

/** One buffer for writeBinary: every accessor moved into the first buffer (glTF-Transform's `unpartition`). */
function oneBuffer(doc: Document): void {
  const root = doc.getRoot()
  const buffers = root.listBuffers()
  const keep = buffers[0] ?? doc.createBuffer()
  for (const a of root.listAccessors()) a.setBuffer(keep)
  for (const b of buffers.slice(1)) b.dispose()
}

/** The GLB's bytes: glTF-Transform's JSON with every node's translation, rotation and scale as computed (its writer
 *  drops values within 1e-5 of the identity, and v1 wrote them all, e.g. a rug's 0.99999998 item-frame scale), the
 *  textures' metadata stripped (contract §2.8). */
async function writeClean(doc: Document): Promise<Uint8Array> {
  oneBuffer(doc)
  const { json, resources } = await io().writeJSON(doc, { format: Format.GLB })
  const nodes = doc.getRoot().listNodes()
  json.nodes?.forEach((def, i) => {
    const node = nodes[i]
    if (node === undefined) return
    const t = node.getTranslation()
    const r = node.getRotation()
    const s = node.getScale()
    if (t.some((v) => v !== 0)) def.translation = t
    if (r[0] !== 0 || r[1] !== 0 || r[2] !== 0 || r[3] !== 1) def.rotation = r
    if (s.some((v) => v !== 1)) def.scale = s
  })
  const bin = resources[GLB_BUFFER]
  const glb = bin === undefined ? await io().writeBinary(doc) : glbBytes(JSON.stringify(json), bin)
  const clean = stripGlb(glb)
  if (!clean.ok) throw new MidstudyError(`the model's textures can't be cleaned of camera metadata (${clean.error.message}); re-export the model`)
  return clean.value.bytes
}

/** v1's `normalize`: writes `out` in the item frame and returns the per-axis fit error in percent. */
export async function normalize(src: string, rotation: Mat3, dims: Vec3, out: string, math: { sqrt(x: number): number; cos(x: number): number; sin(x: number): number }): Promise<PyValue> {
  const doc = await loadModel(src)
  const root = doc.getRoot()
  for (const node of root.listNodes()) {
    // trimesh calls its graph root "world" (v1 renamed such nodes so its wrappers weren't dropped)
    if (node.getName() === 'world') node.setName('world_root')
  }
  let scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null
  if (scene === null) {
    scene = doc.createScene()
    for (const node of root.listNodes()) if (node.getParentNode() === null) scene.addChild(node)
  }
  root.setDefaultScene(scene)
  const orientation = doc.createNode('midstudy_orientation').setRotation([...quatXyzw(rotation, math)])
  for (const child of scene.listChildren()) orientation.addChild(child)
  const frame = doc.createNode('midstudy_item_frame').addChild(orientation)
  scene.addChild(frame)

  const oriented = measure(doc)
  if (oriented === null) throw new MidstudyError('the model has no mesh geometry')
  const flat = glbFlat([oriented.hi[0] - oriented.lo[0], oriented.hi[1] - oriented.lo[1], oriented.hi[2] - oriented.lo[2]])
  if (flat !== null) throw new MidstudyError(flat)
  const f = itemFrame(oriented, dims)
  frame.setScale([...f.scale]).setTranslation([...f.translation])
  const bounds = measure(doc)
  if (bounds === null) throw new MidstudyError('the model has no mesh geometry')
  const bad = glbSelfCheck(bounds, dims)
  if (bad !== null) throw new MidstudyError(bad)
  fs.writeFileSync(out, await writeClean(doc))
  return errorsPct(bounds, dims)
}

// --- the stand-in box (contract §1), as v1's stand_in_box writes it -------------------------------------------------

function f32(v: number): number {
  return Math.fround(v)
}

/** Python's `json.dumps(doc, separators=(",", ":"))`. */
function compact(v: PyValue): string {
  const d = dumps(v, { indent: null, ensureAscii: true, compact: true, allowNan: true })
  if (!d.ok) throw new MidstudyError(d.error)
  return d.text
}

/** v1's `write_glb`: the JSON chunk padded with spaces, the binary chunk with zeros. */
function glbBytes(jsonText: string, blob: Uint8Array): Uint8Array {
  const j = Buffer.from(jsonText, 'utf8')
  const jPad = (4 - (j.length % 4)) % 4
  const bPad = (4 - (blob.length % 4)) % 4
  const total = 12 + 8 + j.length + jPad + 8 + blob.length + bPad
  const out = Buffer.alloc(total)
  out.write('glTF', 0, 'latin1')
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(j.length + jPad, 12)
  out.writeUInt32LE(JSON_CHUNK, 16)
  j.copy(out, 20)
  out.fill(0x20, 20 + j.length, 20 + j.length + jPad)
  const b = 20 + j.length + jPad
  out.writeUInt32LE(blob.length + bPad, b)
  out.writeUInt32LE(BIN_CHUNK, b + 4)
  out.set(blob, b + 8)
  return out
}

/** v1's `stand_in_box`: a plain box exactly at the dims in the item frame, one untextured material; checked and
 *  measured like any model.glb. */
export async function standInBox(dims: Vec3, out: string): Promise<PyValue> {
  const [w, h, d] = dims
  const x0 = -w / 2
  const x1 = w / 2
  const y0 = 0.0
  const y1 = h
  const z0 = -d / 2
  const z1 = d / 2
  const faces: [Vec3[], Vec3][] = [
    [[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]],
    [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]],
    [[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]],
    [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]],
    [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    [[[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]],
  ]
  const pos = new Float32Array(faces.flatMap(([quad]) => quad.flatMap((p) => [...p])))
  const nrm = new Float32Array(faces.flatMap(([, n]) => [...n, ...n, ...n, ...n]))
  const idx = new Uint16Array(Array.from({ length: 6 }, (_, f) => [4 * f, 4 * f + 1, 4 * f + 2, 4 * f, 4 * f + 2, 4 * f + 3]).flat())
  const pb = new Uint8Array(pos.buffer)
  const nb = new Uint8Array(nrm.buffer)
  const ib = new Uint8Array(idx.buffer)
  const pad = (4 - (ib.length % 4)) % 4
  const blob = new Uint8Array(pb.length + nb.length + ib.length + pad)
  blob.set(pb, 0)
  blob.set(nb, pb.length)
  blob.set(ib, pb.length + nb.length)
  const mins = [0, 1, 2].map((k) => Math.min(...Array.from({ length: 24 }, (_, i) => pos[i * 3 + k] ?? 0)))
  const maxs = [0, 1, 2].map((k) => Math.max(...Array.from({ length: 24 }, (_, i) => pos[i * 3 + k] ?? 0)))
  const doc = dict([
    entry('asset', dict([entry('version', str('2.0')), entry('generator', str('midstudy-add stand-in'))])),
    entry('scene', int(0)),
    entry('scenes', list([dict([entry('nodes', list([int(0)]))])])),
    entry('nodes', list([dict([entry('name', str('stand-in')), entry('mesh', int(0))])])),
    entry('meshes', list([dict([entry('name', str('stand-in')), entry('primitives', list([dict([
      entry('attributes', dict([entry('POSITION', int(0)), entry('NORMAL', int(1))])),
      entry('indices', int(2)),
      entry('material', int(0)),
    ])]))])])),
    entry('materials', list([dict([
      entry('name', str('stand-in')),
      entry('pbrMetallicRoughness', dict([
        entry('baseColorFactor', list([float(0.6), float(0.6), float(0.6), float(1.0)])),
        entry('metallicFactor', float(0.0)),
        entry('roughnessFactor', float(1.0)),
      ])),
    ])])),
    entry('buffers', list([dict([entry('byteLength', int(blob.length))])])),
    entry('bufferViews', list([
      dict([entry('buffer', int(0)), entry('byteOffset', int(0)), entry('byteLength', int(pb.length)), entry('target', int(34962))]),
      dict([entry('buffer', int(0)), entry('byteOffset', int(pb.length)), entry('byteLength', int(nb.length)), entry('target', int(34962))]),
      dict([entry('buffer', int(0)), entry('byteOffset', int(pb.length + nb.length)), entry('byteLength', int(ib.length)), entry('target', int(34963))]),
    ])),
    entry('accessors', list([
      dict([
        entry('bufferView', int(0)), entry('componentType', int(5126)), entry('count', int(24)), entry('type', str('VEC3')),
        entry('min', list(mins.map((v) => float(f32(v))))), entry('max', list(maxs.map((v) => float(f32(v))))),
      ]),
      dict([entry('bufferView', int(1)), entry('componentType', int(5126)), entry('count', int(24)), entry('type', str('VEC3'))]),
      dict([entry('bufferView', int(2)), entry('componentType', int(5123)), entry('count', int(36)), entry('type', str('SCALAR'))]),
    ])),
  ])
  const bytes = glbBytes(compact(doc), blob)
  fs.writeFileSync(out, bytes)
  // the self-check reads the written box back, as v1's measured it
  const back = await io().readBinary(new Uint8Array(bytes))
  const bounds = measure(back)
  if (bounds === null) throw new MidstudyError('the model has no mesh geometry')
  const bad = glbSelfCheck(bounds, dims)
  if (bad !== null) throw new MidstudyError(bad)
  return errorsPct(bounds, dims)
}
