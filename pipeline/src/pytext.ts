// How v1's Python words an OSError that ends up in midstudy-add's messages (`[Errno 21] Is a directory: '…'`). The
// strict UTF-8 decode with Python's UnicodeDecodeError message is shared with the server: common/utf8.ts.
import { pyRepr as repr } from '../../common/logic/pyfmt.ts'

// macOS's errno values and strerror texts, as Python prints them
const ERRNO: ReadonlyMap<string, readonly [number, string, string]> = new Map([
  ['EPERM', [1, 'Operation not permitted', 'PermissionError']],
  ['ENOENT', [2, 'No such file or directory', 'FileNotFoundError']],
  ['EIO', [5, 'Input/output error', 'OSError']],
  ['EACCES', [13, 'Permission denied', 'PermissionError']],
  ['EBUSY', [16, 'Resource busy', 'OSError']],
  ['EEXIST', [17, 'File exists', 'FileExistsError']],
  ['EXDEV', [18, 'Cross-device link', 'OSError']],
  ['ENOTDIR', [20, 'Not a directory', 'NotADirectoryError']],
  ['EISDIR', [21, 'Is a directory', 'IsADirectoryError']],
  ['EINVAL', [22, 'Invalid argument', 'OSError']],
  ['EMFILE', [24, 'Too many open files', 'OSError']],
  ['ENOSPC', [28, 'No space left on device', 'OSError']],
  ['EROFS', [30, 'Read-only file system', 'OSError']],
  ['EPIPE', [32, 'Broken pipe', 'BrokenPipeError']],
  ['EAGAIN', [35, 'Resource temporarily unavailable', 'BlockingIOError']],
  ['ELOOP', [62, 'Too many levels of symbolic links', 'OSError']],
  ['ENAMETOOLONG', [63, 'File name too long', 'OSError']],
  ['ENOTEMPTY', [66, 'Directory not empty', 'OSError']],
] as const)

function codeOf(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

function field(e: unknown, key: 'path' | 'dest'): string | null {
  if (!(e instanceof Error) || !(key in e)) return null
  const v: unknown = Reflect.get(e, key)
  return typeof v === 'string' ? v : null
}

/** `str(OSError)` as Python prints it: `[Errno N] Message: 'path'` (`file`, else the error's own path and dest). */
export function osError(e: unknown, file: string | null = null): string {
  const known = ERRNO.get(codeOf(e))
  if (known === undefined) return e instanceof Error ? e.message : String(e)
  const p = file ?? field(e, 'path')
  const dest = file === null ? field(e, 'dest') : null
  const where = p === null ? '' : `: ${repr(p)}${dest === null ? '' : ` -> ${repr(dest)}`}`
  return `[Errno ${String(known[0])}] ${known[1]}${where}`
}

/** Python's exception type for a Node system error code (OSError for the ones it has no subclass for). */
export function osErrorType(e: unknown): string {
  return ERRNO.get(codeOf(e))?.[2] ?? 'OSError'
}

/** Whether `e` is a Node system error Python would raise as an OSError. */
export function isOsError(e: unknown): boolean {
  return ERRNO.has(codeOf(e))
}
