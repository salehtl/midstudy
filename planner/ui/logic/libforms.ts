// The library manager's forms (ui/panels/libsheets.ts, contract §2.8): Add furniture's size fields, its meta (the
// X-Midstudy-Meta / from-url body), what is still missing, the Flat rug prefill, the price and budget words; Edit's
// patch. Pure, TScert-checked. Money is formatted by the shell's fmtUsd, passed in as usd.

import type { DimsCm } from '../../logic/text.js'
import { readSize } from './text.js'

/** The Model choice (handle lib-engine), in this order; Idol is the default. */
export const ENGINES = [
  { value: 'idol', label: 'Idol' },
  { value: 'sam3d', label: 'SAM 3D' },
  { value: 'trellis2', label: 'TRELLIS 2' },
  { value: 'rug', label: 'Flat rug' },
] as const

/** The W × D × H fields: a size when all three are numbers above 0, else null. */
export function dimsOf(w: string, d: string, h: string): DimsCm | null {
  const x = readSize(w)
  const y = readSize(d)
  const z = readSize(h)
  return x !== null && y !== null && z !== null && x > 0 && y > 0 && z > 0 ? { w: x, d: y, h: z } : null
}

/** A piece's id from its name: lower case, runs of anything but a–z and 0–9 to one '-', none at either end, ≤ 64. */
function idFromName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/** "$0.10", or "free" for nothing. */
export function priceWord(v: number, usd: (v: number) => string): string {
  return v > 0 ? usd(v) : 'free'
}

/** Add furniture's fields as the meta reads them. productSizes: the source is a product page with several sizes (each
 *  size made is its own piece: the same id would replace the other size). image: an image add (not a 3D file). */
export interface AddFields {
  readonly name: string
  readonly dims: DimsCm | null
  readonly category: string
  readonly productSizes: boolean
  readonly image: boolean
  readonly engine: string
  readonly resolution: number
}
/** The add's meta (sent as JSON), keys in v1's order: name, dims_cm, then id, category, engine and resolution when
 *  they apply. A key that does not apply is undefined, which JSON.stringify leaves out, as v1 left it unset. */
export interface AddMeta {
  readonly name: string
  readonly dims_cm: DimsCm | null
  readonly id: string | undefined
  readonly category: string | undefined
  readonly engine: string | undefined
  readonly resolution: number | undefined
}
export function addMeta(f: AddFields): AddMeta {
  const name = f.name.trim()
  const d = f.dims
  const id = idFromName(f.productSizes && d ? `${name} ${String(parseFloat(d.w.toFixed(1)))}x${String(parseFloat(d.d.toFixed(1)))}` : name)
  const category = f.category.trim()
  return {
    name,
    dims_cm: d,
    id: id || undefined,
    category: category || undefined,
    engine: f.image ? f.engine : undefined,
    resolution: f.image && f.engine === 'trellis2' ? f.resolution : undefined,
  }
}

/** What Add still needs, in the order the button asks for it, or null when it can go. */
export interface AddState {
  readonly source: string
  readonly productProblem: string | null
  readonly hasPhoto: boolean
  readonly hasModel: boolean
  readonly link: string
  readonly name: string
  readonly hasDims: boolean
}
export function addProblem(s: AddState): string | null {
  if (s.source === 'product' && s.productProblem) return s.productProblem
  if (s.source === 'photo' && !s.hasPhoto) return 'Choose a photo'
  if (s.source === 'model' && !s.hasModel) return 'Choose a 3D file'
  if (s.source === 'link' && !/^https?:\/\/\S+$/i.test(s.link.trim())) return 'Paste an image link'
  if (!s.name.trim()) return 'Give it a name'
  if (!s.hasDims) return 'Enter its size in cm'
  return null
}

/** Flat rug: H is the thickness, so 1 cm (and the category rug) go in when still empty. Another model takes back what
 *  the rug filled in, if it is still as filled (a paid Idol add mustn't come out 1 cm tall). filledH / filledCategory:
 *  what the rug put there, or null. */
export interface RugFill {
  readonly h: string
  readonly category: string
  readonly filledH: string | null
  readonly filledCategory: string | null
}
export function rugFill(engine: string, h: string, category: string, filledH: string | null, filledCategory: string | null): RugFill {
  if (engine !== 'rug') {
    return {
      h: filledH !== null && h === filledH ? '' : h,
      category: filledCategory !== null && category === filledCategory ? '' : category,
      filledH: null,
      filledCategory: null,
    }
  }
  const fillH = !h.trim()
  const fillCategory = !category.trim()
  return {
    h: fillH ? '1' : h,
    category: fillCategory ? 'rug' : category,
    filledH: fillH ? '1' : filledH,
    filledCategory: fillCategory ? 'rug' : filledCategory,
  }
}

/** The Model row's hint (with each model's price). */
export interface LibPrices {
  readonly idol: number
  readonly sam3d: number
  readonly trellisFrom: number
}
export function engineHint(rug: boolean, p: LibPrices, usd: (v: number) => string): string {
  return rug
    ? 'For a rug seen from straight above, like a shop’s picture: laid flat at W × D, H is its thickness (about 1 cm). No model call.'
    : `Idol (${priceWord(p.idol, usd)}) looks the most like your photo: it's made of soft coloured points rather than solid surfaces. `
      + `SAM 3D (${priceWord(p.sam3d, usd)}) is quick and cheap. TRELLIS 2 (from ${priceWord(p.trellisFrom, usd)}) makes a solid model with fine detail. `
      + 'Flat rug (free) is for a rug pictured from above.'
}

/** The price box's words: what is being made and from what. */
export function costWord(model: boolean, rug: boolean, engine: string, resolution: number): string {
  if (model) return 'Your own model'
  if (rug) return 'Flat rug from the picture'
  if (engine === 'trellis2') return `TRELLIS 2 at ${String(resolution)}`
  const known = ENGINES.find((e) => e.value === engine)
  return `${known ? known.label : engine} from the photo`
}

/** Today's spend (GET /api/spend), as far as the forms read it. */
export interface SpendFacts {
  readonly spent_usd?: number | null
  readonly reserved_usd?: number | null
  readonly cap_usd?: number | null
}
/** The budget line under the price: still checking, over today's budget, or what is used and left. */
export interface BudgetLine {
  readonly over: boolean
  readonly text: string
}
export function budgetLine(spend: SpendFacts | null, cost: number, usd: (v: number) => string): BudgetLine {
  const cap = spend?.cap_usd
  if (!spend || typeof cap !== 'number' || !Number.isFinite(cap)) return { over: false, text: 'Today’s budget: checking…' }
  const used = ((spend.spent_usd ?? 0) || 0) + ((spend.reserved_usd ?? 0) || 0)
  const left = Math.max(0, cap - used)
  const over = cost > 0 && cost > left + 1e-9
  return over
    ? { over, text: `Over today’s fal budget: ${usd(left)} of ${usd(cap)} left. Try a cheaper model, or tomorrow.` }
    : { over, text: `Today: ${usd(used)} of ${usd(cap)} used · ${usd(left)} left` }
}

/** Whether Make is held back by the budget (an image add that costs more than what is left today). */
export function overBudget(spend: SpendFacts | null, cost: number): boolean {
  if (!spend) return false
  const used = ((spend.spent_usd ?? 0) || 0) + ((spend.reserved_usd ?? 0) || 0)
  const cap = spend.cap_usd === null ? 0 : spend.cap_usd ?? NaN // as JS subtracts them: null is 0, a missing cap NaN
  return cost > Math.max(0, cap - used) + 1e-9
}

/** The Make button's words. */
export function goLabel(busy: boolean, problem: string | null, cost: number, usd: (v: number) => string): string {
  return busy ? 'Sending…' : (problem ?? '') || (cost > 0 ? `Make it · ${usd(cost)}` : 'Add · free')
}

/** Re-adding an id replaces that piece (§2.8): the note says so before Make. */
export function replacesText(name: string): string {
  return `“${name}” is already in your library: this replaces it.`
}

/** A name from a chosen file: no extension, '-' and '_' as spaces, a capital first, at most 120 characters. */
export function nameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 120)
}

/** "chair.glb · 12.3 MB". */
export function modelFileText(name: string, size: number): string {
  return `${name} · ${(size / 1e6).toFixed(1)} MB`
}

/** Edit's fields and the item as it is. */
export interface EditFields {
  readonly name: string
  readonly category: string
  readonly dims: DimsCm | null
  readonly turn: number
  readonly render: string
  readonly canSwitch: boolean
  readonly itemName: string | null
  readonly itemCategory: string | null
  readonly itemDims: DimsCm | null
  readonly itemRender: string
}
/** What Edit changes (PATCH /api/library/items/<id>, sent as JSON), keys in v1's order; a key that does not change is
 *  undefined, which JSON.stringify leaves out, as v1 left it unset. */
export interface EditPatch {
  readonly name: string | undefined
  readonly category: string | null | undefined
  readonly dims_cm: DimsCm | undefined
  readonly yaw: number | undefined
  readonly default_render: string | undefined
}
export function editPatch(f: EditFields): EditPatch {
  const n = f.name.trim()
  const c = f.category.trim()
  const d = f.dims
  const was = f.itemDims
  const w0 = was === null ? 0 : was.w
  const d0 = was === null ? 0 : was.d
  const h0 = was === null ? 0 : was.h
  const resized = d !== null && (Math.abs(d.w - w0) > 1e-6 || Math.abs(d.d - d0) > 1e-6 || Math.abs(d.h - h0) > 1e-6)
  return {
    name: n && n !== f.itemName ? n : undefined,
    category: c !== (f.itemCategory ?? '') ? c || null : undefined,
    dims_cm: d !== null && resized ? { w: d.w, d: d.d, h: d.h } : undefined,
    yaw: f.turn ? f.turn : undefined,
    default_render: f.canSwitch && f.render !== f.itemRender ? f.render : undefined,
  }
}

/** Whether Edit changes anything. */
export function changes(p: EditPatch): boolean {
  return p.name !== undefined || p.category !== undefined || p.dims_cm !== undefined || p.yaw !== undefined || p.default_render !== undefined
}

/** A new size or turn refits the model on the server. */
export function refits(p: EditPatch): boolean {
  return p.dims_cm !== undefined || !!p.yaw
}

/** Edit's Save button. */
export function saveLabel(busy: boolean, refit: boolean): string {
  return busy ? 'Saving…' : refit ? 'Save and refit · free' : 'Save'
}

/** After Save: refitting, or saved. */
export function editedText(rescale: boolean, name: string): string {
  return rescale ? `Refitting ${name}…` : `${name} saved`
}
