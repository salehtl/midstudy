// --engine rug (contract §3.2; v1's rug.py): a rug pictured from straight above, laid flat, with no model call. The
// picture's plain margin is cropped and it is turned a quarter when that matches W × D better (the imaging kernels,
// exactly as v1's Pillow and numpy did it), then it becomes the unlit top of a W × D × H slab in the item frame
// (sides and bottom in the rug's edge colour), built with glTF-Transform. The picture's top edge is the back (−Z).
import fs from 'node:fs'

import { Document } from '@gltf-transform/core'
import { KHRMaterialsUnlit } from '@gltf-transform/extensions'

import { imageRug } from '../../core/js/pipeline.ts'
import { MidstudyError, UnexpectedError } from './errors.ts'
import { io } from './glb.ts'
import type { Vec3 } from './logic/frames.ts'
import { fixed, general, pyRound } from './logic/pyformat.ts'

const ASPECT_NOTE = 0.08

interface Quad {
  readonly p: Vec3[]
  readonly n: Vec3
  readonly uv: [number, number][] | null
  readonly tri: number[]
}

/** v1's `_quad`: two triangles, wound counterclockwise seen from the normal (positions as float32). */
function quad(corners: Vec3[], normal: Vec3, uv: [number, number][] | null = null): Quad {
  const p = corners.map((c): Vec3 => [Math.fround(c[0]), Math.fround(c[1]), Math.fround(c[2])])
  const [a, b, c] = [p[0] ?? [0, 0, 0], p[1] ?? [0, 0, 0], p[2] ?? [0, 0, 0]]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const cross = [(u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0), (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0), (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0)]
  const dot = (cross[0] ?? 0) * normal[0] + (cross[1] ?? 0) * normal[1] + (cross[2] ?? 0) * normal[2]
  return { p, n: normal, uv, tri: dot < 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3] }
}

/** v1's `build`: writes the rug GLB (item frame, metres) to `out` and the texture to `textureOut`; returns the
 *  notes. */
export async function build(image: string, wCm: number, dCm: number, hCm: number, out: string, textureOut: string): Promise<string[]> {
  const r = imageRug(new Uint8Array(fs.readFileSync(image)), wCm, dCm)
  if (!r.ok) {
    if (r.error.code === 'plain-colour') throw new MidstudyError('the picture looks like one plain colour: use a picture of the rug itself')
    throw new UnexpectedError('OSError', r.error.detail === '' ? r.error.code : r.error.detail)
  }
  const t = r.value
  const notes: string[] = []
  if (t.crop !== null) notes.push(`cropped the picture's plain margin to ${String(t.crop[2] - t.crop[0])} x ${String(t.crop[3] - t.crop[1])} px`)
  if (t.turned) notes.push("turned the picture a quarter so its long side runs along the rug's long side")
  if (Math.abs(t.have / t.want - 1) > ASPECT_NOTE) {
    notes.push(`the picture is ${fixed(t.have, 2)}:1 but ${general(wCm)} x ${general(dCm)} cm is ${fixed(t.want, 2)}:1, so the pattern is stretched to fit: check the size`)
  }
  if (hCm > 10) notes.push(`a rug ${general(hCm)} cm thick: H is the thickness (about 1 cm for most rugs)`)
  fs.writeFileSync(textureOut, t.jpeg)

  const x = wCm / 200
  const y = hCm / 100
  const z = dCm / 200
  const top = quad([[-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]])
  const sides = [
    quad([[-x, 0, z], [x, 0, z], [x, y, z], [-x, y, z]], [0, 0, 1]),
    quad([[x, 0, -z], [-x, 0, -z], [-x, y, -z], [x, y, -z]], [0, 0, -1]),
    quad([[x, 0, z], [x, 0, -z], [x, y, -z], [x, y, z]], [1, 0, 0]),
    quad([[-x, 0, -z], [-x, 0, z], [-x, y, z], [-x, y, -z]], [-1, 0, 0]),
    quad([[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]], [0, -1, 0]),
  ]
  const doc = new Document()
  doc.getRoot().getAsset().generator = 'midstudy-add rug'
  const buffer = doc.createBuffer()
  const unlit = doc.createExtension(KHRMaterialsUnlit)
  const texture = doc.createTexture().setImage(t.jpeg).setMimeType('image/jpeg')
  const topMaterial = doc.createMaterial('rug-top')
    .setBaseColorTexture(texture)
    .setMetallicFactor(0.0)
    .setRoughnessFactor(1.0)
    .setExtension('KHR_materials_unlit', unlit.createUnlit())
  topMaterial.getBaseColorTextureInfo()?.setMagFilter(9729).setMinFilter(9987).setWrapS(33071).setWrapT(33071)
  const edge = t.edge.map((v) => pyRound(v, 4))
  const edgeMaterial = doc.createMaterial('rug-edge')
    .setBaseColorFactor([edge[0] ?? 0, edge[1] ?? 0, edge[2] ?? 0, 1.0])
    .setMetallicFactor(0.0)
    .setRoughnessFactor(1.0)
  const primitive = (quads: Quad[], textured: boolean) => {
    const pos = new Float32Array(quads.flatMap((q) => q.p.flatMap((p) => [...p])))
    const nor = new Float32Array(quads.flatMap((q) => [...q.n, ...q.n, ...q.n, ...q.n]))
    const idx = new Uint32Array(quads.flatMap((q, i) => q.tri.map((k) => k + 4 * i)))
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer))
    if (textured) {
      const uv = new Float32Array(quads.flatMap((q) => (q.uv ?? []).flatMap((c) => [...c])))
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer))
    }
    return prim
  }
  const mesh = doc.createMesh('rug')
    .addPrimitive(primitive([top], true).setMaterial(topMaterial))
    .addPrimitive(primitive(sides, false).setMaterial(edgeMaterial))
  const node = doc.createNode('rug').setMesh(mesh)
  doc.getRoot().setDefaultScene(doc.createScene().addChild(node))
  fs.writeFileSync(out, await io().writeBinary(doc))
  return notes
}
