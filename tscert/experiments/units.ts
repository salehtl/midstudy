// Units (CLAUDE.md: meters in 3D, centimeters in dims_cm): imported by importer.ts.
export interface DimsCm {
  readonly w: number
  readonly d: number
  readonly h: number
}

export function cmToM(cm: number): number {
  return cm / 100
}

export function mToCm(m: number): number {
  return Math.round(m * 1000) / 10
}
