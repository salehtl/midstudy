// OBJ zips (contract §2.8 zip rules, §3.1; v1's objzip.py): the central directory read as Python's zipfile reads it,
// the media kernels' zip policy decides what may be extracted (only .obj .mtl .png .jpg .jpeg; no absolute paths,
// `..` or links; at most 1,000 entries and 500 MB unpacked; exactly one .obj), entries are inflated with fflate (each
// stopped at its declared size, its CRC checked), and obj2gltf turns the .obj into a GLB.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import zlib from 'node:zlib'

import { Inflate } from 'fflate'

import { zipPlan } from '../../core/js/node.ts'
import { MidstudyError, UnexpectedError } from './errors.ts'
import { resolvePath as resolve } from '../../common/files.ts'
import { fixed, repr } from './logic/pyformat.ts'
import { decodeUtf8 } from '../../common/utf8.ts'
import { name as pathName, suffix } from './logic/pypath.ts'

/** One central-directory entry. */
interface ZipInfo {
  /** The name as Python's zipfile decodes it (and its raw bytes and flags, for the policy). */
  readonly name: string
  readonly nameBytes: Uint8Array
  readonly flags: number
  readonly method: number
  readonly crc: number
  readonly compressSize: number
  readonly fileSize: number
  readonly externalAttr: number
  readonly headerOffset: number
}

class BadZipFile extends Error {
  override readonly name: string = 'BadZipFile'
}

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function cp437(b: Uint8Array): string {
  let s = ''
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : (CP437[c - 0x80] ?? '?')
  return s
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

function u16(d: Uint8Array, at: number): number {
  return (d[at] ?? 0) | ((d[at + 1] ?? 0) << 8)
}

function u32(d: Uint8Array, at: number): number {
  return ((d[at] ?? 0) | ((d[at + 1] ?? 0) << 8) | ((d[at + 2] ?? 0) << 16)) + (d[at + 3] ?? 0) * 0x1000000
}

function u64(d: Uint8Array, at: number): number {
  return u32(d, at) + u32(d, at + 4) * 2 ** 32
}

function findLast(d: Uint8Array, sig: readonly number[], from: number): number {
  for (let i = d.length - sig.length; i >= from; i--) {
    if (sig.every((b, k) => d[i + k] === b)) return i
  }
  return -1
}

const EOCD = [0x50, 0x4b, 5, 6]

/** Python's `ZipFile(path).infolist()`. */
function readZip(d: Uint8Array): ZipInfo[] {
  // _EndRecData: the 22-byte record at the end, or searched for in the last 64 KiB + 22
  let at = -1
  if (d.length >= 22 && EOCD.every((b, k) => d[d.length - 22 + k] === b) && d[d.length - 2] === 0 && d[d.length - 1] === 0) at = d.length - 22
  else at = findLast(d, EOCD, Math.max(d.length - 65535 - 22, 0))
  if (at < 0 || at + 22 > d.length) throw new BadZipFile('File is not a zip file')
  let sizeCd = u32(d, at + 12)
  let offsetCd = u32(d, at + 16)
  let location = at
  // _EndRecData64
  const loc = at - 20
  if (loc >= 0 && d[loc] === 0x50 && d[loc + 1] === 0x4b && d[loc + 2] === 6 && d[loc + 3] === 7) {
    const reloff = u64(d, loc + 8)
    const rec = loc - 56
    if (reloff > rec) throw new BadZipFile('Corrupt zip64 end of central directory locator')
    const r = d[reloff] === 0x50 && d[reloff + 1] === 0x4b && d[reloff + 2] === 6 && d[reloff + 3] === 6 ? reloff : rec
    if (!(d[r] === 0x50 && d[r + 1] === 0x4b && d[r + 2] === 6 && d[r + 3] === 6)) throw new BadZipFile('Zip64 end of central directory record not found')
    sizeCd = u64(d, r + 40)
    offsetCd = u64(d, r + 48)
    location = r === reloff ? rec - (rec - reloff) : rec
  }
  const concat = location - sizeCd - offsetCd
  const start = offsetCd + concat
  if (start < 0) throw new BadZipFile('Bad offset for central directory')
  const cd = d.subarray(start, start + sizeCd)
  const out: ZipInfo[] = []
  let p = 0
  while (p < sizeCd) {
    if (p + 46 > cd.length) throw new BadZipFile('Truncated central directory')
    if (!(cd[p] === 0x50 && cd[p + 1] === 0x4b && cd[p + 2] === 1 && cd[p + 3] === 2)) throw new BadZipFile('Bad magic number for central directory')
    const extractVersion = cd[p + 6] ?? 0
    const flags = u16(cd, p + 8)
    const method = u16(cd, p + 10)
    const crc = u32(cd, p + 16)
    let compressSize = u32(cd, p + 20)
    let fileSize = u32(cd, p + 24)
    const nlen = u16(cd, p + 28)
    const xlen = u16(cd, p + 30)
    const clen = u16(cd, p + 32)
    const externalAttr = u32(cd, p + 38)
    let headerOffset = u32(cd, p + 42)
    const raw = cd.slice(p + 46, p + 46 + nlen)
    const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen)
    let name: string
    if (flags & 0x800) {
      const t = decodeUtf8(raw)
      if (!t.ok) throw new UnexpectedError('UnicodeDecodeError', t.error)
      name = t.text
    } else name = cp437(raw)
    if (extractVersion > 63) throw new UnexpectedError('NotImplementedError', `zip file version ${fixed(extractVersion / 10, 1)}`)
    let nameBytes: Uint8Array = raw
    let nameFlags = flags
    // _decodeExtra: zip64 sizes, the Info-ZIP Unicode Path field
    let e = 0
    while (e + 4 <= extra.length) {
      const tp = u16(extra, e)
      const ln = u16(extra, e + 2)
      if (ln + 4 > extra.length - e) throw new BadZipFile(`Corrupt extra field ${tp.toString(16).padStart(4, '0')} (size=${String(ln)})`)
      const data = extra.subarray(e + 4, e + 4 + ln)
      if (tp === 0x0001) {
        let q = 0
        if (fileSize === 0xffffffff) {
          fileSize = u64(data, q)
          q += 8
        }
        if (compressSize === 0xffffffff) {
          compressSize = u64(data, q)
          q += 8
        }
        if (headerOffset === 0xffffffff) headerOffset = u64(data, q)
      } else if (tp === 0x7075 && data.length >= 5 && data[0] === 1 && u32(data, 1) === zlib.crc32(raw)) {
        const up = data.slice(5)
        try {
          const text = utf8Strict.decode(up)
          if (text !== '') {
            name = text
            nameBytes = up
            nameFlags = flags | 0x800
          }
        } catch {
          throw new BadZipFile('Corrupt unicode path extra field (0x7075)')
        }
      }
      e += 4 + ln
    }
    out.push({ name, nameBytes, flags: nameFlags, method, crc, compressSize, fileSize, externalAttr, headerOffset: headerOffset + concat })
    p += 46 + nlen + xlen + clen
  }
  return out
}

/** The entries v1's `check` keeps, after every rule; throws v1's sentence naming the first one broken. */
function plan(file: string, infos: readonly ZipInfo[]): ZipInfo[] {
  const r = zipPlan(infos.map((i) => ({ name: i.nameBytes, flags: i.flags, uncompressedSize: i.fileSize, externalAttributes: i.externalAttr })))
  if (r.ok) return r.value.extract.flatMap((k) => (infos[k] === undefined ? [] : [infos[k]]))
  const { code, offset, message } = r.error
  const name = offset === null ? '' : (infos[offset]?.name ?? '')
  switch (code) {
    // v1's objzip.py words two rules differently from the server (whose sentences the kernel carries)
    case 'absolute': throw new MidstudyError(`the zip holds an absolute or Windows path (${name}): zip the folder's contents instead`)
    case 'obj-count': {
      const found = /found (\d+)/.exec(message)?.[1] ?? '0'
      throw new MidstudyError(`the zip must hold exactly one .obj (with its .mtl and textures), found ${found}`)
    }
    case 'bad-input': throw new MidstudyError(`${pathName(file)} isn't a readable zip (${message})`)
    default: throw new MidstudyError(message)
  }
}

/** v1's `check`: the entries to extract after every rule (refused as a whole, nothing extracted). */
export function check(file: string): ZipInfo[] {
  let infos: ZipInfo[]
  try {
    infos = readZip(new Uint8Array(fs.readFileSync(file)))
  } catch (e) {
    if (e instanceof BadZipFile) throw new MidstudyError(`${pathName(file)} isn't a readable zip (${e.message})`)
    throw e
  }
  return plan(file, infos)
}

/** One entry's bytes, stopped one byte past its declared size, its CRC checked as zipfile does. */
function entryBytes(d: Uint8Array, info: ZipInfo): Uint8Array {
  const h = info.headerOffset
  if (h + 30 > d.length) throw new BadZipFile('Truncated file header')
  if (!(d[h] === 0x50 && d[h + 1] === 0x4b && d[h + 2] === 3 && d[h + 3] === 4)) throw new BadZipFile('Bad magic number for file header')
  if (info.flags & 1) throw new UnexpectedError('RuntimeError', `File ${repr(info.name)} is encrypted, password required for extraction`)
  const start = h + 30 + u16(d, h + 26) + u16(d, h + 28)
  const packed = d.subarray(start, start + info.compressSize)
  const limit = info.fileSize + 1
  let out: Uint8Array
  if (info.method === 0) {
    out = packed.subarray(0, Math.min(packed.length, limit))
  } else if (info.method === 8) {
    const parts: Uint8Array[] = []
    let total = 0
    const inf = new Inflate((chunk) => {
      total += chunk.length
      parts.push(chunk)
      if (total >= limit) throw new MidstudyError(`the zip entry ${info.name} is bigger than it says`)
    })
    inf.push(packed, true)
    out = new Uint8Array(total)
    let at = 0
    for (const c of parts) {
      out.set(c, at)
      at += c.length
    }
  } else {
    throw new UnexpectedError('NotImplementedError', 'That compression method is not supported')
  }
  if (out.length >= limit) throw new MidstudyError(`the zip entry ${info.name} is bigger than it says`)
  if ((zlib.crc32(out) >>> 0) !== info.crc) throw new UnexpectedError('BadZipFile', `Bad CRC-32 for file ${repr(info.name)}`)
  return out
}

/** v1's `extract`: the checked entries into `dest`; returns the .obj's path. */
function extract(file: string, dest: string): string {
  const keep = check(file)
  fs.mkdirSync(dest, { recursive: true })
  const root = resolve(dest)
  const d = new Uint8Array(fs.readFileSync(file))
  let obj = ''
  for (const info of keep) {
    const out = resolve(path.join(dest, info.name))
    if (!out.startsWith(root + path.sep)) throw new MidstudyError(`the zip entry ${info.name} would land outside the folder`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, entryBytes(d, info))
    if (suffix(out).toLowerCase() === '.obj') obj = out
  }
  return obj
}

type Obj2gltf = (objPath: string, options: Readonly<Record<string, unknown>>) => Promise<unknown>

function isConverter(v: unknown): v is Obj2gltf {
  return typeof v === 'function'
}

/** v1's `to_glb`: the zip's OBJ (with its materials and textures) as a GLB at `out`. */
export async function toGlb(file: string, work: string, out: string): Promise<string> {
  const obj = extract(file, work)
  const objName = pathName(obj)
  const mod: unknown = createRequire(import.meta.url)('obj2gltf')
  if (!isConverter(mod)) throw new UnexpectedError('ImportError', 'obj2gltf is not a function')
  let glb: unknown
  try {
    glb = await mod(obj, { binary: true, secure: true, logger: () => undefined })
  } catch (e) {
    const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    throw new MidstudyError(`couldn't read ${objName} (${what}); export the OBJ again`)
  }
  if (!(glb instanceof Uint8Array)) throw new MidstudyError(`couldn't convert ${objName} to GLB (TypeError: no GLB)`)
  fs.writeFileSync(out, glb)
  return out
}
