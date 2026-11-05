// Text the planner UI shows, from plain values: numbers with a typographic minus, plurals, money, monograms, clipped and
// capitalised server sentences, sizes, and the forms' number parsing. Pure (no DOM), checked by TScert
// (tscert/README.md); every function keeps the v1 expression it replaces (planner/ui/*.js at the fork), edge cases
// included.

/** toFixed output with its sign as the typographic minus U+2212 (v1: `.replace('-', '−')`). */
function minusSign(s: string): string {
  return s.replace('-', '−')
}

/** One decimal, typographic minus: 1.25 → "1.3", −2 → "−2.0" (workspace fmt1, Scene panel f1). */
export function signed1(v: number): string {
  return minusSign((Math.round(v * 10) / 10).toFixed(1))
}

/** `digits` decimals, typographic minus (the Adjust floor sliders, the number fields). */
export function fixedMinus(v: number, digits: number): string {
  return minusSign(v.toFixed(digits))
}

/** "1 layout", "3 layouts". */
export function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`
}

/** "$0.04"; anything that is not a number (or is 0 or NaN) is "$0.00" (panels/common money). */
export function money(v: number | null | undefined): string {
  return `$${((v ?? 0) || 0).toFixed(2)}`
}

/** "1.25×" (the Look's strength, ambient and exposure). */
export function times(v: number): string {
  return `${v.toFixed(2)}×`
}

/** "Bookcase 80" → "B8", "Oak reading lamp" → "OR", nothing → "?" (a thumbnail's stand-in). */
export function monogram(name: string | null | undefined): string {
  const words = ((name ?? '') || '?').trim().split(/[\s_-]+/).filter((w) => w !== '')
  const first = words[0]
  const second = words[1]
  const a = first === undefined ? '?' : first.charAt(0)
  const b = second !== undefined ? second.charAt(0) : first === undefined ? '' : first.charAt(1)
  return (a + b).toUpperCase()
}

/** White space collapsed, cut to n characters with an ellipsis. */
export function clipText(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The first letter (after any leading space) upper-cased. */
export function cap(s: string | null | undefined): string {
  return (s ?? '').replace(/^\s*\S/, (c) => c.toUpperCase())
}

/** A server note as a sentence: capitalised, with a full stop unless it ends in punctuation already. */
export function sentence(s: string | null | undefined): string {
  const t = cap((s ?? '').trim())
  return /[.!?…:”"')]$/.test(t) ? t : `${t}.`
}

/** "a", "a and b", "a, b and c". */
export function andList(xs: readonly string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1] ?? ''}` : xs[0] ?? ''
}

/** A pasted page's size: "2.4 MB", "12 KB" (at least 1 KB). */
export function pageSize(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${String(Math.max(1, Math.round(n / 1e3)))} KB`
}

/** Centimetres to one decimal, without trailing zeros ("80", "80.5"); "" when not a number. */
export function cmText(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : ''
}

/** A size reading: "200 × 140 × 1 cm", or "200 × 140 cm, no height". */
export interface SizeCm {
  readonly w: number
  readonly d: number
  readonly h?: number | null
}
export function dimsLabel(c: SizeCm): string {
  return typeof c.h === 'number' && c.h > 0
    ? `${cmText(c.w)} × ${cmText(c.d)} × ${cmText(c.h)} cm`
    : `${cmText(c.w)} × ${cmText(c.d)} cm, no height`
}

/** The ruler's real length and the product size fields: a decimal comma read as a point, then parseFloat. */
export function readDecimal(text: string): number {
  return parseFloat(text.replace(',', '.'))
}

/** The height field and the Add form's sizes: a decimal comma and a typographic minus, then parseFloat. */
export function readSigned(text: string): number {
  return parseFloat(text.replace(',', '.').replace('−', '-'))
}

/** The Add form's number reading: readSigned, or null when that is not a finite number. */
export function readSize(text: string): number | null {
  const x = readSigned(text)
  return Number.isFinite(x) ? x : null
}

/** An error message that means the server did not answer (fetch failed): the panels word it as offline. */
export function isOfflineText(message: string): boolean {
  return /isn't answering|could not reach|Failed to fetch|NetworkError/i.test(message)
}

/** The parts that are not empty, joined with " · ". */
export function dots(parts: readonly (string | null | undefined | false)[]): string {
  const out: string[] = []
  for (const p of parts) if (typeof p === 'string' && p !== '') out.push(p)
  return out.join(' · ')
}
