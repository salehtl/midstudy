// An OBJ zip's checks before midstudy-add runs (contract §2.8 Bodies; v1 planner/serve.py `zip_problem`): the
// central directory read exactly as Python 3.12's zipfile reads it (v1 listed it with `zipfile.ZipFile(path).infolist()`,
// so the same zips are unreadable, with the same sentences), then the media kernel's policy (core/js/node.ts
// `zipPlan`: v1's rules and sentences; k-media refuses a name with a NUL or bad UTF-8 where v1 cut it or crashed).
import fsp from 'node:fs/promises'
import zlib from 'node:zlib'
import { pyFixed } from '../../../common/logic/pyfmt.ts'
import { zipPlan, type ZipEntry } from '../../../core/js/node.ts'
import { unreadableZip } from './logic/upload.ts'

/** Python's zipfile.BadZipFile: the zip can't be read (v1 answered 400 with its sentence). */
class BadZipFile extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadZipFile'
  }
}

/** A short read where zipfile expected a whole record (Python's `OSError("Unknown I/O error")`). */
class ShortRead extends Error {
  constructor() {
    super('Unknown I/O error')
    this.name = 'OSError'
  }
}

/** What v1 did not catch (Python's NotImplementedError for a newer zip version): the dispatcher answers 500. */
class NotImplementedZip extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

const SIZE_EOCD = 22
const SIZE_LOCATOR64 = 20
const SIZE_EOCD64 = 56
const SIZE_CENTRAL = 46
const MAX_COMMENT = 0xffff
const MAX_EXTRACT_VERSION = 63
const UTF8_FLAG = 0x800
const SIG_EOCD = Buffer.from('PK\x05\x06', 'latin1')
const SIG_LOCATOR64 = Buffer.from('PK\x06\x07', 'latin1')
const SIG_EOCD64 = Buffer.from('PK\x06\x06', 'latin1')
const SIG_CENTRAL = Buffer.from('PK\x01\x02', 'latin1')
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Positioned reads of a file, as Python's seek + read: fewer bytes at the end, none past it. */
interface Reader {
  readonly size: number
  read(position: number, length: number): Promise<Buffer>
}

/** The end record (v1 zipfile's `endrec`): where the central directory is and how big it says it is. */
interface EndRecord {
  size: bigint
  offset: bigint
  location: number
}

function startsWith(data: Buffer, sig: Buffer): boolean {
  return data.length >= sig.length && data.subarray(0, sig.length).equals(sig)
}

/** zipfile `_EndRecData64`: the zip64 end records, when a locator precedes the end record. */
async function endRecord64(r: Reader, at: number, rec: EndRecord): Promise<EndRecord> {
  let offset = at - SIZE_LOCATOR64
  if (offset < 0) return rec
  const loc = await r.read(offset, SIZE_LOCATOR64)
  if (loc.length !== SIZE_LOCATOR64) throw new ShortRead()
  if (!startsWith(loc, SIG_LOCATOR64)) return rec
  const diskno = loc.readUInt32LE(4)
  const reloff = loc.readBigUInt64LE(8)
  const disks = loc.readUInt32LE(16)
  if (diskno !== 0 || disks > 1) throw new BadZipFile('zipfiles that span multiple disks are not supported')
  offset -= SIZE_EOCD64
  if (reloff > BigInt(offset)) throw new BadZipFile('Corrupt zip64 end of central directory locator')
  let extra = offset - Number(reloff)
  let data = await r.read(Number(reloff), SIZE_EOCD64)
  if (data.length !== SIZE_EOCD64) throw new ShortRead()
  if (!startsWith(data, SIG_EOCD64) && Number(reloff) !== offset) {
    extra = 0
    data = await r.read(offset, SIZE_EOCD64)
    if (data.length !== SIZE_EOCD64) throw new ShortRead()
  }
  if (!startsWith(data, SIG_EOCD64)) throw new BadZipFile('Zip64 end of central directory record not found')
  const sz = data.readBigUInt64LE(4)
  const dirsize = data.readBigUInt64LE(40)
  const diroffset = data.readBigUInt64LE(48)
  if (diroffset + dirsize !== reloff || sz + 12n !== BigInt(SIZE_EOCD64 + extra)) throw new BadZipFile('Corrupt zip64 end of central directory record')
  return { size: dirsize, offset: diroffset, location: offset - extra }
}

/** zipfile `_EndRecData`: the end record at the very end, else the last one within a comment's reach; null when none. */
async function endRecord(r: Reader): Promise<EndRecord | null> {
  if (r.size < SIZE_EOCD) return null
  const tail = await r.read(r.size - SIZE_EOCD, SIZE_EOCD)
  if (tail.length === SIZE_EOCD && startsWith(tail, SIG_EOCD) && tail[20] === 0 && tail[21] === 0) {
    const rec = { size: BigInt(tail.readUInt32LE(12)), offset: BigInt(tail.readUInt32LE(16)), location: r.size - SIZE_EOCD }
    return endRecord64(r, r.size - SIZE_EOCD, rec)
  }
  const from = Math.max(r.size - MAX_COMMENT - SIZE_EOCD, 0)
  const data = await r.read(from, MAX_COMMENT + SIZE_EOCD)
  const start = data.lastIndexOf(SIG_EOCD)
  if (start < 0) return null
  const raw = data.subarray(start, start + SIZE_EOCD)
  if (raw.length !== SIZE_EOCD) return null
  const rec = { size: BigInt(raw.readUInt32LE(12)), offset: BigInt(raw.readUInt32LE(16)), location: from + start }
  return endRecord64(r, from + start, rec)
}

/** A cursor over the central directory's bytes (zipfile reads it through io.BytesIO: short reads aren't errors). */
class Cursor {
  readonly #data: Buffer
  #at = 0
  constructor(data: Buffer) {
    this.#data = data
  }

  take(n: number): Buffer {
    const out = this.#data.subarray(this.#at, this.#at + n)
    this.#at += out.length
    return out
  }
}

/** zipfile `ZipInfo._decodeExtra`: the zip64 sizes and the Info-ZIP Unicode Path field (0x7075). Returns the entry's
 *  uncompressed size and, when the Unicode Path applies, the name's UTF-8 bytes. */
function decodeExtra(extraField: Buffer, sizes: { fileSize: bigint; compressSize: bigint; headerOffset: bigint }, nameCrc: number): { readonly fileSize: bigint; readonly unicodeName: Buffer | null } {
  let extra = extraField
  let unicodeName: Buffer | null = null
  let { fileSize, compressSize, headerOffset } = sizes
  while (extra.length >= 4) {
    const tp = extra.readUInt16LE(0)
    const ln = extra.readUInt16LE(2)
    if (ln + 4 > extra.length) throw new BadZipFile('Corrupt extra field ' + tp.toString(16).padStart(4, '0') + ' (size=' + String(ln) + ')')
    let data = extra.subarray(4, ln + 4)
    if (tp === 0x0001) {
      if (fileSize === 0xffffffffffffffffn || fileSize === 0xffffffffn) {
        if (data.length < 8) throw new BadZipFile('Corrupt zip64 extra field. File size not found.')
        fileSize = data.readBigUInt64LE(0)
        data = data.subarray(8)
      }
      if (compressSize === 0xffffffffn) {
        if (data.length < 8) throw new BadZipFile('Corrupt zip64 extra field. Compress size not found.')
        compressSize = data.readBigUInt64LE(0)
        data = data.subarray(8)
      }
      if (headerOffset === 0xffffffffn) {
        if (data.length < 8) throw new BadZipFile('Corrupt zip64 extra field. Header offset not found.')
        headerOffset = data.readBigUInt64LE(0)
      }
    } else if (tp === 0x7075) {
      if (data.length < 5) throw new BadZipFile('Corrupt unicode path extra field (0x7075)')
      if (data[0] === 1 && data.readUInt32LE(1) === nameCrc) {
        const bytes = data.subarray(5)
        try {
          strictUtf8.decode(bytes)
        } catch {
          throw new BadZipFile('Corrupt unicode path extra field (0x7075): invalid utf-8 bytes')
        }
        if (bytes.length > 0) unicodeName = bytes
      }
    }
    extra = extra.subarray(ln + 4)
  }
  return { fileSize, unicodeName }
}

/** zipfile `ZipFile._RealGetContents`: every central-directory entry as the kernel's policy takes it. */
async function centralDirectory(r: Reader): Promise<ZipEntry[]> {
  let rec: EndRecord | null
  try {
    rec = await endRecord(r)
  } catch (e) {
    // zipfile turns any OSError while looking for the end record into "File is not a zip file".
    if (e instanceof ShortRead || errorCode(e) !== '') throw new BadZipFile('File is not a zip file')
    throw e
  }
  if (rec === null) throw new BadZipFile('File is not a zip file')
  const concat = BigInt(rec.location) - rec.size - rec.offset
  const startDir = rec.offset + concat
  if (startDir < 0n) throw new BadZipFile('Bad offset for central directory')
  const start = Number(startDir)
  const length = Math.max(0, Math.min(Number(rec.size > BigInt(r.size) ? BigInt(r.size) : rec.size), r.size - start))
  const cursor = new Cursor(start >= r.size ? Buffer.alloc(0) : await r.read(start, length))
  const entries: ZipEntry[] = []
  let total = 0n
  while (total < rec.size) {
    const head = cursor.take(SIZE_CENTRAL)
    if (head.length !== SIZE_CENTRAL) throw new BadZipFile('Truncated central directory')
    if (!startsWith(head, SIG_CENTRAL)) throw new BadZipFile('Bad magic number for central directory')
    const extractVersion = head[6] ?? 0
    const flags = head.readUInt16LE(8)
    const compressSize = BigInt(head.readUInt32LE(20))
    const fileSize = BigInt(head.readUInt32LE(24))
    const nameLength = head.readUInt16LE(28)
    const extraLength = head.readUInt16LE(30)
    const commentLength = head.readUInt16LE(32)
    const externalAttributes = head.readUInt32LE(38)
    const headerOffset = BigInt(head.readUInt32LE(42))
    const name = cursor.take(nameLength)
    const extra = cursor.take(extraLength)
    cursor.take(commentLength)
    if (extractVersion > MAX_EXTRACT_VERSION) throw new NotImplementedZip('zip file version ' + pyFixed(extractVersion / 10, 1))
    const decoded = decodeExtra(extra, { fileSize, compressSize, headerOffset }, zlib.crc32(name))
    entries.push(decoded.unicodeName === null
      ? { name, flags, uncompressedSize: decoded.fileSize, externalAttributes }
      : { name: decoded.unicodeName, flags: flags | UTF8_FLAG, uncompressedSize: decoded.fileSize, externalAttributes })
    total += BigInt(SIZE_CENTRAL + nameLength + extraLength + commentLength)
  }
  return entries
}

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** v1 `zip_problem`: the first broken §2.8 zip rule (or why the zip can't be read), as v1 worded it; null when the zip
 *  may go to midstudy-add. A zip newer than zipfile reads throws (v1 answered 500). */
export async function zipProblem(file: string): Promise<string | null> {
  let entries: ZipEntry[]
  try {
    const handle = await fsp.open(file, 'r')
    try {
      const size = (await handle.stat()).size
      const reader: Reader = {
        size,
        read: async (position, length) => {
          if (position >= size || length <= 0) return Buffer.alloc(0)
          const buf = Buffer.alloc(Math.min(length, size - position))
          const { bytesRead } = await handle.read(buf, 0, buf.length, position)
          return buf.subarray(0, bytesRead)
        },
      }
      entries = await centralDirectory(reader)
    } finally {
      await handle.close()
    }
  } catch (e) {
    if (e instanceof BadZipFile) return unreadableZip(e.message)
    if (errorCode(e) !== '' && e instanceof Error) return unreadableZip(e.message)
    throw e
  }
  const plan = zipPlan(entries)
  return plan.ok ? null : plan.error.message
}
