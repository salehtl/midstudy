// The §1 self-checks and their sentences (v1's glb.py and splat.py): a model's bounds and a splat's percentile extent
// against --dims, the per-axis fit errors in percent, the GLB's item-frame transform, and what splat.spz's read-back
// says. Pure (functional core).

import type { PyValue } from './pyjson.ts'
import { dict, entry, float } from './pyjson.ts'
import { fixed, general, percent, pyRound, thousands } from './pyformat.ts'
import type { Vec3 } from './frames.ts'

/** §1 tolerances (the same as evals/validate_library.py). */
const GLB_DIM_TOL = 0.02
const GLB_CENTER_TOL = 0.01
const GLB_FLOOR_TOL = 0.005
const SPLAT_DIM_TOL = 0.02
const SPLAT_FLOOR_TOL = 0.01
const SPLAT_CENTER_TOL = 0.01
const SPZ_POS_CHECK = 0.00025

/** An axis-aligned box: min and max corners. */
export interface Bounds {
  readonly lo: Vec3
  readonly hi: Vec3
}

/** The dims in metres as v1 holds them: x = w, y = h, z = d (`np.array([w, h, d]) / 100`). */
export function dimsMetres(w: number, d: number, h: number): Vec3 {
  return [w / 100, h / 100, d / 100]
}

/** v1's `errors_pct`: {w, d, h} per-axis size error in percent, rounded to 3 places. */
export function errorsPct(b: Bounds, dims: Vec3): PyValue {
  const e = (i: 0 | 1 | 2): number => {
    const s = b.hi[i] - b.lo[i]
    return pyRound((Math.abs(s - dims[i]) / dims[i]) * 100, 3)
  }
  return dict([entry('w', float(e(0))), entry('d', float(e(2))), entry('h', float(e(1)))])
}

function allFinite(b: Bounds): boolean {
  return [...b.lo, ...b.hi].every((v) => Number.isFinite(v))
}

const LABELS = ['w', 'h', 'd'] as const

/** v1's GLB `self_check`: null when the bounds pass, else its sentence. */
export function glbSelfCheck(b: Bounds, dims: Vec3): string | null {
  if (!allFinite(b)) return 'self-check failed: GLB has non-finite (NaN/inf) coordinates; the model is corrupt'
  for (const i of [0, 1, 2] as const) {
    const s = b.hi[i] - b.lo[i]
    const t = dims[i]
    const off = Math.abs(s - t) / t
    if (off > GLB_DIM_TOL) {
      return `self-check failed: GLB ${LABELS[i]} is ${fixed(s * 100, 1)} cm, expected ${fixed(t * 100, 1)} cm (${percent(off, 1)} off, max ${percent(GLB_DIM_TOL, 0)})`
    }
  }
  const cx = (b.lo[0] + b.hi[0]) / 2
  const cz = (b.lo[2] + b.hi[2]) / 2
  if (Math.abs(cx) > GLB_CENTER_TOL || Math.abs(cz) > GLB_CENTER_TOL) {
    return `self-check failed: GLB footprint center is (${fixed(cx, 3)}, ${fixed(cz, 3)}) m, max ${fixed(GLB_CENTER_TOL * 100, 0)} cm from the origin`
  }
  if (Math.abs(b.lo[1]) > GLB_FLOOR_TOL) {
    return `self-check failed: GLB min y is ${fixed(b.lo[1], 3)} m, max ${fixed(GLB_FLOOR_TOL * 100, 1)} cm from 0`
  }
  return null
}

/** The flat-axis refusal before a model is scaled, or null. */
export function glbFlat(size: Vec3): string | null {
  const names = ['X', 'Y', 'Z'] as const
  for (const i of [0, 1, 2] as const) {
    if (size[i] < 1e-6) return `the model is flat along ${names[i]} (size 0), so it can't be scaled to --dims`
  }
  return null
}

/** The item-frame node's scale and translation for oriented bounds (v1's `normalize`): per-axis scale to the dims,
 *  then the footprint center to x = z = 0 and the bottom to y = 0. */
export function itemFrame(b: Bounds, dims: Vec3): { readonly scale: Vec3; readonly translation: Vec3 } {
  const size: Vec3 = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]]
  const k: Vec3 = [dims[0] / size[0], dims[1] / size[1], dims[2] / size[2]]
  const center: Vec3 = [(b.lo[0] + b.hi[0]) / 2, b.lo[1], (b.lo[2] + b.hi[2]) / 2]
  return { scale: k, translation: [-k[0] * center[0], -k[1] * center[1], -k[2] * center[2]] }
}

/** v1's splat `self_check` on the written splat's percentile extent: null when it passes, else its sentence. */
export function splatSelfCheck(b: Bounds, finite: boolean, dims: Vec3, pct: readonly [number, number]): string | null {
  if (!finite) return 'self-check failed: splat has non-finite (NaN/inf) positions; the splat is corrupt'
  const range = `p${general(pct[0])}-p${general(pct[1])}`
  for (const i of [0, 1, 2] as const) {
    const s = b.hi[i] - b.lo[i]
    const t = dims[i]
    const off = Math.abs(s - t) / t
    if (off > SPLAT_DIM_TOL) {
      return `self-check failed: splat ${LABELS[i]} (${range}) is ${fixed(s * 100, 1)} cm, expected ${fixed(t * 100, 1)} cm (${percent(off, 1)} off, max ${percent(SPLAT_DIM_TOL, 0)})`
    }
  }
  if (Math.abs(b.lo[1]) > SPLAT_FLOOR_TOL) {
    return `self-check failed: splat floor (p${general(pct[0])} y) is ${fixed(b.lo[1], 3)} m, max ${fixed(SPLAT_FLOOR_TOL * 100, 0)} cm from 0`
  }
  const cx = (b.lo[0] + b.hi[0]) / 2
  const cz = (b.lo[2] + b.hi[2]) / 2
  if (Math.abs(cx) > SPLAT_CENTER_TOL || Math.abs(cz) > SPLAT_CENTER_TOL) {
    return `self-check failed: splat footprint center is (${fixed(cx, 3)}, ${fixed(cz, 3)}) m, max ${fixed(SPLAT_CENTER_TOL * 100, 0)} cm from the origin`
  }
  return null
}

/** The note when f_rest_* coefficients were dropped. */
export function restNote(count: number, rotated: boolean, stretched: boolean): string {
  const why = [rotated ? 'rotating' : '', stretched ? 'stretching it per axis' : ''].filter((w) => w !== '').join(' and ')
  return `dropped ${String(count)} f_rest_* SH coefficients (view-dependent colour) after ${why}`
}

/** "splat.spz: 262,144 splats, 3.1 MB" (and what was dropped). */
export function spzLine(count: number, bytes: number, dropped: number): string {
  const tail = dropped > 0 ? ` (dropped the ${thousands(dropped)} that cover the least)` : ''
  return `splat.spz: ${thousands(count)} splats, ${fixed(bytes / 1e6, 1)} MB${tail}`
}

/** What reading splat.spz back found. */
export interface SpzReadBack {
  readonly magic: number
  readonly version: number
  readonly count: number
  readonly shDegree: number
  readonly fractionalBits: number
  readonly flags: number
  readonly length: number
  readonly valid: boolean
  readonly expected: number
  readonly maxOffset: number
}

/** v1's `write_spz` checks on the read-back: null when it passes, else the sentence (`path` is splat.spz's). */
export function spzSelfCheck(r: SpzReadBack, path: string): string | null {
  if (!r.valid) {
    const head = `{'magic': ${String(r.magic)}, 'version': ${String(r.version)}, 'count': ${String(r.count)}, 'sh_degree': ${String(r.shDegree)}, 'fractional_bits': ${String(r.fractionalBits)}, 'flags': ${String(r.flags)}}`
    return `${path} isn't the SPZ v2 file midstudy-add writes (${head}, ${String(r.length)} bytes)`
  }
  if (r.count !== r.expected) return `self-check failed: splat.spz holds ${String(r.count)} splats, expected ${String(r.expected)}`
  if (r.maxOffset > SPZ_POS_CHECK) {
    return `self-check failed: splat.spz positions are up to ${fixed(r.maxOffset * 1000, 2)} mm from splat.ply's (max ${fixed(SPZ_POS_CHECK * 1000, 2)} mm)`
  }
  return null
}

/** The sentence for a PLY v1 wouldn't read (`code` and `detail` from the kernel), with the file's path. */
export function plyMessage(code: string, detail: string, path: string): { readonly message: string; readonly unexpected: boolean } {
  switch (code) {
    case 'not-ply': return { message: `${path} is not a PLY file`, unexpected: false }
    case 'format': return { message: `${path} is a ${detail === '' ? 'unknown' : detail} PLY; only binary PLY splats are supported`, unexpected: false }
    case 'vertex-not-first': return { message: `${path}: the vertex element must come first`, unexpected: false }
    case 'unsupported': return { message: `${path}: unsupported PLY property '${detail}'`, unexpected: false }
    case 'missing': return { message: `${path} isn't a 3DGS splat (missing ${detail})`, unexpected: false }
    case 'empty': return { message: `${path} has no splats`, unexpected: false }
    case 'truncated': return { message: `${path} is truncated`, unexpected: false }
    case 'no-header-end': return { message: 'ValueError: subsection not found', unexpected: true }
    case 'duplicate': return { message: `ValueError: field '${detail}' occurs more than once`, unexpected: true }
    default: return { message: `ValueError: malformed PLY header line '${detail}'`, unexpected: true }
  }
}
