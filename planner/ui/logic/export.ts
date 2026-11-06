// Export's choices and names (ui/export.ts, main a292ee2): the size presets, formats and pictures, the output size,
// Before and after's shape, the file name, and the choices remembered on this device. Pure, TScert-checked.

export interface SizeChoice { readonly id: string; readonly label: string; readonly long: number | null }
const SIZES: readonly SizeChoice[] = [
  { id: 'full', label: 'Full', long: null },
  { id: 'l', label: '2048 px', long: 2048 },
  { id: 'm', label: '1280 px', long: 1280 },
  { id: 's', label: '800 px', long: 800 },
]
export interface FormatChoice { readonly id: string; readonly label: string; readonly type: 'image/jpeg' | 'image/png'; readonly ext: string; readonly note: string }
export const FORMATS: readonly FormatChoice[] = [
  { id: 'jpeg', label: 'JPEG', type: 'image/jpeg', ext: 'jpg', note: 'smaller file' },
  { id: 'png', label: 'PNG', type: 'image/png', ext: 'png', note: 'lossless, larger' },
]
export const LAYOUTS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'scene', label: 'Scene' },
  { id: 'pair', label: 'Before and after' },
]

export const formatOf = (id: string): FormatChoice => FORMATS.find((f) => f.id === id) ?? { id: 'jpeg', label: 'JPEG', type: 'image/jpeg', ext: 'jpg', note: 'smaller file' }

/** The sizes that make sense for a photo whose longer side is `long`: Full, then the presets smaller than it. */
export function sizesFor(long: number): SizeChoice[] {
  return SIZES.filter((s) => s.long === null || s.long < long)
}

/** The scene's size at a preset (never larger than the photo), and the preset's long edge (null: the photo's own). */
export function dimsFor(sizeId: string, w: number, h: number): { w: number; h: number; long: number | null } {
  const s = SIZES.find((x) => x.id === sizeId) ?? { id: 'full', label: 'Full', long: null }
  const k = s.long !== null ? Math.min(1, s.long / Math.max(w, h)) : 1
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), long: s.long }
}

/** Before and after: a wide photo stacks (photo above the scene), an upright one sits side by side. */
export function pairShape(w: number, h: number): { w: number; h: number; stacked: boolean } {
  return w >= h ? { w, h: h * 2, stacked: true } : { w: w * 2, h, stacked: false }
}

/** A name part: lower case, runs of anything else as one '-', at most 48 characters. */
function slugPart(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/** '<scene>-<layout>-[before-after-]<w>x<h>.<ext>' */
export function exportName(scene: { readonly title?: string | null; readonly name: string } | null, layoutTitle: string, pair: boolean, formatId: string, w: number, h: number): string {
  const parts = [slugPart(scene?.title) || (scene?.name ?? '') || 'scene', slugPart(layoutTitle), pair ? 'before-after' : '', `${String(w)}x${String(h)}`]
  return `${parts.filter((p) => p !== '').join('-')}.${formatOf(formatId).ext}`
}

/** The remembered choices (localStorage midstudy.export), each checked against what this photo offers. */
export function rememberedChoices(stored: unknown, sizes: readonly SizeChoice[]): { size: string; format: string; layout: string } {
  const get = (k: string): unknown => (typeof stored === 'object' && stored !== null ? Reflect.get(stored, k) : undefined)
  const size = get('size'), format = get('format'), layout = get('layout')
  return {
    size: sizes.some((s) => s.id === size) && typeof size === 'string' ? size : 'full',
    format: FORMATS.some((f) => f.id === format) && typeof format === 'string' ? format : 'jpeg',
    layout: LAYOUTS.some((l) => l.id === layout) && typeof layout === 'string' ? layout : 'scene',
  }
}
