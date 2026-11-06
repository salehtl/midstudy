// Files as v1 wrote and moved them (shared by the server and midstudy-add): atomic replaces (a temp file in the same
// folder, mode 0600 as Python's mkstemp made it, then a rename), JSON in Python's layouts, tolerant reads, and the
// pathlib / shutil / os operations both tools use with Python's meaning (`Path.is_file()`, `Path.resolve()`,
// `shutil.move`, `shutil.rmtree(ignore_errors=True)`, `os.replace`).
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function tempName(file: string): string {
  return path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomBytes(6).toString('hex') + '.tmp')
}

/** v1 `atomic_write_bytes`: the folder is made, the bytes go to `.<name>.<random>.tmp` beside the file, then replace
 *  it in one rename; the temp file is removed when anything fails. */
export async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = tempName(file)
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600, flag: 'wx' })
    await fsp.rename(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
}

/** The same, synchronously (for writes that must finish before the next statement, like a lock's owner file). */
export function atomicWriteSync(file: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = tempName(file)
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/** Every character outside ASCII as a `\uXXXX` escape (Python's `ensure_ascii=True`; JSON text is ASCII then, and
 *  a non-ASCII character can only stand inside a string). */
function asciiOnly(json: string): string {
  return json.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** How a JSON file is laid out: v1's two layouts (both indent 2 with a final newline). */
export type JsonStyle =
  /** `json.dump(data, f, indent=2)`: scene.json, layouts, renders/<name>.json, trash.json, entry.json. */
  | 'ascii'
  /** `json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False)`: library.json, as midstudy-add writes it. */
  | 'utf8'

/** JSON text in v1's layout. Numbers are JavaScript's (Python wrote `80.0` for a float; JSON readers see the same
 *  number). Non-finite numbers are refused, as `allow_nan=False` did. */
export function jsonText(data: unknown, style: JsonStyle): string {
  const text = JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Out of range float values are not JSON compliant')
    return value
  }, 2)
  return (style === 'ascii' ? asciiOnly(text) : text) + '\n'
}

/** v1 `read_json_file`: the parsed file, or null when it is missing or unreadable. */
export function readJsonFile(file: string): unknown {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value
  } catch {
    return null
  }
}

/** A private temporary folder (never under a served path), like Python's `tempfile.mkdtemp(prefix=…)`. */
export async function makeTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

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

/** `shutil.rmtree(p, ignore_errors=True)`. */
export function removeTree(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    // ignore_errors
  }
}

/** `shutil.move(src, dst)`: a rename (into `dst` when it is an existing folder), or a copy (links as links) and a
 *  removal across file systems. Returns where it went. */
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

/** `os.replace(src, dst)` of a file, which also works when `src` is on another file system (a temp folder): then a
 *  copy beside `dst` renamed over it (still one atomic replace for readers) and the source removed. */
export function replace(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst)
  } catch (e) {
    if (errorCode(e) !== 'EXDEV') throw e
    const tmp = tempName(dst)
    try {
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, dst)
    } catch (copyError) {
      fs.rmSync(tmp, { force: true })
      throw copyError
    }
    fs.rmSync(src, { force: true })
  }
}
