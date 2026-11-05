// splat.ply and splat.spz (contract §1; v1's splat.py), through the Rust splat kernels (core/js/pipeline.ts): the
// per-axis fit with its covariances, the §1 self-check of the written file, then splat.spz (SPZ v2, gzipped with
// mtime 0 as v1's gzip.compress, at level 4 rather than v1's 9: a third of the time for 0.6 % more bytes on the
// Idol fixture, docs/notes/pipeline.md) checked against splat.ply.
import fs from 'node:fs'
import zlib from 'node:zlib'

import { splatNormalize, spzCheck, spzEncode } from '../../core/js/pipeline.ts'
import { MidstudyError, UnexpectedError } from './errors.ts'
import { errorsPct, plyMessage, restNote, splatSelfCheck, spzSelfCheck } from './logic/fit.ts'
import { flat, percentiles } from './logic/frames.ts'
import type { Mat3, Vec3 } from './logic/frames.ts'
import type { PyValue } from './logic/pyjson.ts'

function plyError(code: string, detail: string, file: string): Error {
  const m = plyMessage(code, detail, file)
  if (!m.unexpected) return new MidstudyError(m.message)
  const at = m.message.indexOf(': ')
  return new UnexpectedError(m.message.slice(0, at), m.message.slice(at + 2))
}

/** v1's `normalize` for a splat: writes `out` in the item frame, fitted per axis; returns the fit error in percent
 *  and the notes. */
export function normalize(src: string, rotation: Mat3, dims: Vec3, out: string, engine: string | null): { readonly fit: PyValue; readonly notes: readonly string[] } {
  const pct = percentiles(engine)
  const r = splatNormalize(new Uint8Array(fs.readFileSync(src)), flat(rotation), dims, pct)
  if (!r.ok) {
    const { code, offset, detail } = r.error
    if (code === 'non-finite') throw new MidstudyError('the splat has non-finite (NaN/inf) positions; the file is corrupt')
    if (code === 'flat') {
      const axis = ['X', 'Y', 'Z'][offset ?? 0] ?? 'X'
      throw new MidstudyError(`the splat is flat along ${axis} (its extent is 0), so it can't be fitted to --dims`)
    }
    throw plyError(code, detail, src)
  }
  const f = r.value
  fs.writeFileSync(out, f.ply)
  const bounds = { lo: f.lo, hi: f.hi }
  const bad = splatSelfCheck(bounds, f.finite, dims, pct)
  if (bad !== null) throw new MidstudyError(bad)
  const notes = f.droppedRest > 0 ? [restNote(f.droppedRest, f.rotated, f.stretched)] : []
  return { fit: errorsPct(bounds, dims), notes }
}

/** The gzip level of splat.spz (v1: 9; the contract names none). */
const SPZ_GZIP_LEVEL = 4

/** v1's `write_spz`: splat.spz from the written splat.ply, its positions checked against splat.ply's (the payload
 *  the file holds, before gzip; v1 read the file back and gunzipped it). */
export function writeSpz(ply: string, out: string): { readonly count: number; readonly dropped: number; readonly bytes: number } {
  const data = new Uint8Array(fs.readFileSync(ply))
  const enc = spzEncode(data)
  if (!enc.ok) {
    if (enc.error.code === 'too-large') throw new MidstudyError("the splat is over 2 km across: it can't be written as splat.spz")
    throw plyError(enc.error.code, enc.error.detail, ply)
  }
  const raw = enc.value.payload
  const packed = zlib.gzipSync(raw, { level: SPZ_GZIP_LEVEL })
  fs.writeFileSync(out, packed)
  const check = spzCheck(raw, data)
  if (!check.ok) {
    if (check.error.code === 'short') {
      throw new UnexpectedError('error', `unpack_from requires a buffer of at least 16 bytes for unpacking 16 bytes at offset 0 (actual buffer size is ${String(raw.length)})`)
    }
    throw plyError(check.error.code, check.error.detail, ply)
  }
  const bad = spzSelfCheck(check.value, out)
  if (bad !== null) throw new MidstudyError(bad)
  return { count: enc.value.count, dropped: enc.value.dropped, bytes: packed.length }
}
