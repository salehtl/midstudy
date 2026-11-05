// String methods (labels, file names; v1: engine.js dimsText, data.js fmtBytes).
export function fmtCm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export function dimsText(w: number, d: number, h: number): string {
  return `${fmtCm(w)} × ${fmtCm(d)} × ${fmtCm(h)} cm`
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function fmtBytes(n: number): string {
  if (!(n > 0)) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0)
}

export function capitalized(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

export function joinIds(ids: readonly string[]): string {
  return ids.join(', ')
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
