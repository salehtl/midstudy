// An import from a second file (units.ts).
import { cmToM, mToCm, type DimsCm } from './units.js'

export interface Size {
  readonly x: number
  readonly y: number
  readonly z: number
}

export function sizeOf(d: DimsCm): Size {
  return { x: cmToM(d.w), y: cmToM(d.h), z: cmToM(d.d) }
}

export function volumeM3(d: DimsCm): number {
  const s = sizeOf(d)
  return s.x * s.y * s.z
}

export function dimsOf(s: Size): DimsCm {
  return { w: mToCm(s.x), d: mToCm(s.z), h: mToCm(s.y) }
}
