// File helpers with v1's semantics (Python's pathlib, shutil and os): atomic writes through a `.name.tmp-<pid>` file,
// temporary folders, moves that fall back to copying across devices, copy2 (data, mode, times), expanduser.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** v1's `atomic_write`: a temp file beside the target (`.<name>.tmp-<pid>`), then a rename. */
export function atomicWrite(file: string, data: string | Uint8Array): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${String(process.pid)}`)
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/** `tempfile.mkdtemp(prefix=…)`: a new private folder in the system's temp folder. */
export function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** `shutil.rmtree(p, ignore_errors=True)`. */
export function rmtree(p: string): void {
  fs.rmSync(p, { recursive: true, force: true })
}

function code(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** `shutil.move(src, dst)`: a rename, or a copy and delete across devices. */
export function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst)
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true })
    rmtree(src)
  }
}

/** `os.replace(src, dst)` (a copy and delete across devices). */
export function replace(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst)
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e
    fs.copyFileSync(src, dst)
    fs.rmSync(src, { force: true })
  }
}

/** `shutil.copy2(src, dst)`: the data (cloned when the file system can), the mode bits and the times. */
export function copy2(src: string, dst: string): void {
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE)
  const st = fs.statSync(src)
  fs.chmodSync(dst, st.mode & 0o7777)
  fs.utimesSync(dst, st.atime, st.mtime)
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** `Path(p).expanduser()`: a leading `~` (or `~/`) is the home folder ($HOME first, as Python does); `~user` is that
 *  user's home when it is the current user. */
export function expanduser(p: string): string {
  if (!p.startsWith('~')) return p
  const slash = p.indexOf('/')
  const user = slash < 0 ? p.slice(1) : p.slice(1, slash)
  const rest = slash < 0 ? '' : p.slice(slash)
  if (user === '') return (process.env['HOME'] ?? os.homedir()) + rest
  if (user === os.userInfo().username) return os.homedir() + rest
  return p
}

/** `os.path.realpath`-like resolution that tolerates a missing tail (pathlib's `resolve()` in non-strict mode). */
export function resolve(p: string): string {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch {
    const parent = path.dirname(abs)
    return parent === abs ? abs : path.join(resolve(parent), path.basename(abs))
  }
}
