// A JSON.parse result narrowed by hand (a scene's look, a list of ids).
export interface Look {
  readonly exposure: number
  readonly warmth: number
}

export function lookFromJson(text: string): Look | null {
  const v: unknown = JSON.parse(text)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  if (!('exposure' in v) || !('warmth' in v)) return null
  const e = v.exposure
  const w = v.warmth
  if (typeof e !== 'number' || typeof w !== 'number') return null
  return { exposure: e, warmth: w }
}

export function idsFromJson(text: string): string[] {
  const v: unknown = JSON.parse(text)
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) if (typeof x === 'string') out.push(x)
  return out
}

export function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function lookFromRecord(r: Readonly<Record<string, unknown>>): Look {
  return { exposure: numberOr(r['exposure'], 1), warmth: numberOr(r['warmth'], 0) }
}
