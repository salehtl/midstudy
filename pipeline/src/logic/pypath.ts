// Python's PurePosixPath, as far as v1 prints and joins paths (the summary line's paths, messages): `str()` drops
// empty and `.` segments and a trailing slash, keeps `..` and exactly two leading slashes; `/` joins (an absolute
// right side wins); `.name`, `.suffix`, `.parent`, `.with_name`. Pure (functional core).

/** `str(PurePosixPath(p))`. */
export function normalize(p: string): string {
  const absolute = p.startsWith('/')
  const lead = absolute ? (p.startsWith('//') && !p.startsWith('///') ? '//' : '/') : ''
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.length === 0) return lead === '' ? '.' : lead
  return lead + parts.join('/')
}

/** `PurePosixPath(a) / b`. */
export function join(a: string, b: string): string {
  if (b.startsWith('/')) return normalize(b)
  const left = normalize(a)
  return left === '.' ? normalize(b) : normalize(`${left}/${b}`)
}

/** `.name`: the last segment ('' for `/` and `.`). */
export function name(p: string): string {
  const n = normalize(p)
  if (n === '.' || n === '/' || n === '//') return ''
  return n.slice(n.lastIndexOf('/') + 1)
}

/** `.suffix`: the name's last `.ext` (not a leading dot, not a trailing one). */
export function suffix(p: string): string {
  const n = name(p)
  const i = n.lastIndexOf('.')
  return i > 0 && i < n.length - 1 ? n.slice(i) : ''
}

/** `.parent`. */
export function parent(p: string): string {
  const n = normalize(p)
  if (n === '.' || n === '/' || n === '//') return n
  const i = n.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  if (i === 1 && n.startsWith('//')) return '//'
  return n.slice(0, i)
}

/** `.with_name(n)`. */
export function withName(p: string, n: string): string {
  return join(parent(p), n)
}
