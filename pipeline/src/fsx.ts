// File helpers only midstudy-add needs, with v1's semantics (Python's tempfile, shutil.copy2, expanduser). The ones
// the server uses too (is_file, resolve, move, rmtree, replace, atomic writes) are common/files.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `tempfile.mkdtemp(prefix=…)`: a new private folder in the system's temp folder. */
export function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** `shutil.copy2(src, dst)`: the data (cloned when the file system can), the mode bits and the times. */
export function copy2(src: string, dst: string): void {
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE)
  const st = fs.statSync(src)
  fs.chmodSync(dst, st.mode & 0o7777)
  fs.utimesSync(dst, st.atime, st.mtime)
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
