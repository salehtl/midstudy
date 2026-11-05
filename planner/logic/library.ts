// Library entries and jobs as the planner reads them (contract §2.8, §4.5 Splats): what a placed piece draws, its
// splat file, whether its GLB is a stand-in, valid dims, the placeholder for a piece the library lost, which pieces
// still need a thumbnail, and when a job is busy. v1's splatAsset, isStandIn, pickRender, validDims and the
// thumbnail filter (engine.js), busy (data.js). Pure, for TScert: the shell reads the JSON into a LibView.
import type { DimsCm } from './text.js'
import type { JsonObject } from './num.js'

/** A library entry's fields the engine decides on (the shell reads them from the entry as it is). */
export interface LibView {
  readonly id: string
  /** a non-empty name, else null (v1 shows the id instead) */
  readonly name: string | null
  /** assets.glb, assets.spz, assets.splat, assets.thumb: each a non-empty path or null */
  readonly glb: string | null
  readonly spz: string | null
  readonly splat: string | null
  readonly thumb: string | null
  readonly defaultRender: unknown
  /** source.engine */
  readonly engine: unknown
  /** a placeholder the planner made for a piece the library doesn't have (§2.8) */
  readonly missing: boolean
}

/** v1's splatAsset: the SPZ first (what phones can load), else the PLY. */
export function splatAsset(l: LibView): string | null {
  return l.spz ?? l.splat
}

/** v1's isStandIn: an Idol piece's GLB is a box at its dims, never drawn and never a thumbnail (§1). */
export function isStandIn(l: LibView): boolean {
  return l.engine === 'idol'
}

/** v1's pickRender: its splat when default_render is "splat" and it has one, else its GLB. */
export function pickRender(l: LibView): 'glb' | 'splat' {
  return !l.missing && l.defaultRender === 'splat' && splatAsset(l) !== null ? 'splat' : 'glb'
}

/** v1's validDims: w, d and h all positive finite numbers. */
export function validDims(d: JsonObject | null): DimsCm | null {
  if (d === null) return null
  const w = d['w']
  const dd = d['d']
  const h = d['h']
  if (typeof w !== 'number' || !Number.isFinite(w) || !(w > 0)) return null
  if (typeof dd !== 'number' || !Number.isFinite(dd) || !(dd > 0)) return null
  if (typeof h !== 'number' || !Number.isFinite(h) || !(h > 0)) return null
  return { w, d: dd, h }
}

/** A placeholder's size when the layout gave none (v1's MISSING_DIMS, 50 cm cubed). */
export const MISSING_DIMS: DimsCm = { w: 50, d: 50, h: 50 }

/** The name a piece goes by in messages: its name, else its id. */
export function libName(l: LibView): string {
  return l.name ?? l.id
}

/** v1's makeMissingThumbs filter: a GLB without a thumbnail that is what's drawn (not a splat, not a stand-in, not
 * a placeholder), not tried yet on this page. */
export function needsThumb(l: LibView, tried: ReadonlySet<string>): boolean {
  return l.glb !== null && l.thumb === null && !l.missing && !isStandIn(l) && pickRender(l) !== 'splat' && !tried.has(l.id)
}

/** A placed piece without a GLB and not drawn as a splat (v1's noGlb): drawn as the missing box. */
export function hasNoGlb(missing: boolean, glb: string | null, render: 'glb' | 'splat'): boolean {
  return !missing && glb === null && render !== 'splat'
}

/** A library job still queued or running (data.ts polls while one is). */
export function jobBusy(status: unknown): boolean {
  return status === 'queued' || status === 'running'
}

/** What a job's status change means: done (reload the library), failed, or nothing new. */
export function jobChange(before: unknown, now: unknown): 'done' | 'failed' | null {
  if (!before || before === now) return null
  if (now === 'done') return 'done'
  if (now === 'failed') return 'failed'
  return null
}
