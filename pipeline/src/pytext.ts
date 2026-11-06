// How v1's Python words two kinds of low-level failure that end up in midstudy-add's messages: a strict UTF-8 decode
// (`bytes.decode("utf-8")`, `Path.read_text(encoding="utf-8")`) and an OSError (`[Errno 21] Is a directory: '…'`).
import { repr } from './logic/pyformat.ts'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** `bytes.decode("utf-8")`: the text, or Python's UnicodeDecodeError message. */
export function decodeUtf8(b: Uint8Array): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, text: decoder.decode(b) }
  } catch {
    return { ok: false, error: utf8Error(b) }
  }
}

function utf8Error(b: Uint8Array): string {
  const hex = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`
  let i = 0
  while (i < b.length) {
    const c = b[i] ?? 0
    if (c < 0x80) {
      i++
      continue
    }
    let need: number
    let lo = 0x80
    let hi = 0xbf
    if (c >= 0xc2 && c <= 0xdf) need = 1
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2
      if (c === 0xe0) lo = 0xa0
      if (c === 0xed) hi = 0x9f
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3
      if (c === 0xf0) lo = 0x90
      if (c === 0xf4) hi = 0x8f
    } else return `'utf-8' codec can't decode byte ${hex(c)} in position ${String(i)}: invalid start byte`
    for (let k = 1; k <= need; k++) {
      if (i + k >= b.length) {
        const end = b.length - 1
        return end > i
          ? `'utf-8' codec can't decode bytes in position ${String(i)}-${String(end)}: unexpected end of data`
          : `'utf-8' codec can't decode byte ${hex(c)} in position ${String(i)}: unexpected end of data`
      }
      const d = b[i + k] ?? 0
      const okRange = k === 1 ? d >= lo && d <= hi : d >= 0x80 && d <= 0xbf
      if (!okRange) {
        return k === 1
          ? `'utf-8' codec can't decode byte ${hex(c)} in position ${String(i)}: invalid continuation byte`
          : `'utf-8' codec can't decode bytes in position ${String(i)}-${String(i + k - 1)}: invalid continuation byte`
      }
    }
    i += need + 1
  }
  return "'utf-8' codec can't decode the data"
}

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
