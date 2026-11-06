// The file operations of the scenes, layouts and renders routes, synchronous on purpose: each route's work on the scene
// folders happens in one turn of the event loop, so it is atomic for this server as v1's SceneService lock made it
// (another request can't run between a read and the write that depends on it). The files are small (scene.json,
// layouts, calib.json; a thumbnail ≤ 2 MB; a render ≤ a few MB). Reads are tolerant as v1's `read_json_file`.
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteSync, jsonText } from '../../../common/files.ts'
import type { SchemaUri } from '../../../contract/gen/validate.js'
import { assertConforms } from '../strict.ts'
import { pyTimestamp } from './logic/time.ts'
import { isRecord } from './logic/values.ts'

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** `Path.is_file()`: a regular file (symlinks followed); false on any error. */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** `Path.is_dir()`: a folder (symlinks followed); false on any error. */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** `Path.exists()`: anything there (symlinks followed, so a dangling link is not). */
export function exists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** CPython's `st_mtime` of `p` (a float in seconds), or null when it can't be read. */
export function mtimeOf(p: string): number | null {
  let ns: bigint
  try {
    ns = fs.statSync(p, { bigint: true }).mtimeNs
  } catch {
    return null
  }
  let sec = ns / 1_000_000_000n
  let nsec = ns % 1_000_000_000n
  if (nsec < 0n) {
    sec -= 1n
    nsec += 1_000_000_000n
  }
  return pyTimestamp(Number(sec), Number(nsec))
}

/** The names in a folder (none when it can't be read). */
export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** v1 `read_json_file`: the parsed file, or null when it is missing, isn't UTF-8 (a BOM included: Python's json refuses
 *  one) or isn't JSON. */
export function readJson(file: string): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file))
  } catch {
    return null
  }
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return null
  }
}

/** The file parsed as a JSON object, or null (v1: `data if isinstance(data, dict) else None`). */
export function readRecord(file: string): Readonly<Record<string, unknown>> | null {
  const v = readJson(file)
  return isRecord(v) ? v : null
}

/** v1 `atomic_write_json` (`json.dump(indent=2)` and a newline) after strict mode's check of its schema; the same as
 *  server/src/strict.ts writeJsonFile, synchronously. */
export function writeJsonSync(file: string, data: unknown, schema: SchemaUri): void {
  assertConforms(schema, data, 'writing ' + file)
  atomicWriteSync(file, jsonText(data, 'ascii'))
}

/** v1 `atomic_write_bytes`. */
export function writeBytesSync(file: string, data: Uint8Array): void {
  atomicWriteSync(file, data)
}

/** Up to `max` bytes from the start of a file, or null when it can't be read. */
export function readHead(file: string, max: number): Buffer | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.allocUnsafe(max)
    let got = 0
    while (got < max) {
      const n = fs.readSync(fd, buf, got, max - got, got)
      if (n === 0) break
      got += n
    }
    return buf.subarray(0, got)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** `shutil.rmtree(p, ignore_errors=True)`. */
export function removeTree(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    // ignore_errors
  }
}

/** `shutil.move(src, dst)`: a rename (into `dst` when it is an existing folder), or a copy and a removal across file
 *  systems. Returns where it went. */
export function move(src: string, dst: string): string {
  const target = isDir(dst) ? path.join(dst, path.basename(src)) : dst
  try {
    fs.renameSync(src, target)
  } catch (e) {
    if (errorCode(e) !== 'EXDEV') throw e
    fs.cpSync(src, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
  return target
}

/** Python's `Path.resolve()` (not strict): symlinks resolved as far as the path exists, the rest appended. */
export function resolvePath(p: string): string {
  const rest: string[] = []
  let at = path.resolve(p)
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest.reverse())
    } catch {
      const parent = path.dirname(at)
      if (parent === at) return path.join(at, ...rest.reverse())
      rest.push(path.basename(at))
      at = parent
    }
  }
}

/** `os.replace(src, dst)`. */
export function replace(src: string, dst: string): void {
  fs.renameSync(src, dst)
}

/** Makes a folder and its parents (`mkdir(parents=True, exist_ok=True)`). */
export function makeDirs(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Makes one folder; false when something is already there (`mkdir()` raising FileExistsError). */
export function makeDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir)
    return true
  } catch (e) {
    if (errorCode(e) === 'EEXIST') return false
    throw e
  }
}
