// More forms Phase 2 will reach for: injected math, common array and string methods, JSON and URL helpers.
export interface TrigMethods {
  tan(x: number): number
  atan(x: number): number
}
export interface TrigFields {
  readonly tan: (x: number) => number
  readonly atan: (x: number) => number
}

export function focalFromFovMethods(fovRad: number, trig: TrigMethods): number {
  return 0.5 / trig.tan(fovRad / 2)
}

export function focalFromFovFields(fovRad: number, trig: TrigFields): number {
  return 0.5 / trig.tan(fovRad / 2)
}

export function includesId(ids: readonly string[], id: string): boolean {
  return ids.includes(id)
}

export function indexOfId(ids: readonly string[], id: string): number {
  return ids.indexOf(id)
}

export function lastId(ids: readonly string[]): string | undefined {
  return ids.at(-1)
}

export function sortedNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function sortedNumbers(xs: readonly number[]): number[] {
  return xs.toSorted((a, b) => a - b)
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

export function keyCount(rec: Readonly<Record<string, number>>): number {
  return Object.keys(rec).length
}

export function toJson(v: readonly number[]): string {
  return JSON.stringify(v)
}

export function sceneUrl(name: string): string {
  return `/api/scenes/${encodeURIComponent(name)}`
}

export function isJpegName(name: string): boolean {
  return name.endsWith('.jpg') || name.endsWith('.jpeg')
}

export function hasSpace(s: string): boolean {
  return s.includes(' ')
}

export function bar(n: number): string {
  return '#'.repeat(Math.max(0, Math.min(40, Math.round(n))))
}

export function isNotNumber(v: number): boolean {
  return Number.isNaN(v)
}
