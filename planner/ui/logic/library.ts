// The Library panel's lists and words (ui/panels/library.ts, contract §2.8, §4.5): search and the In the scene filter,
// counts of placed pieces, each row's marks, the jobs making pieces, and Recently removed. Pure, TScert-checked.

import { dots } from './text.js'
import { upText } from './workspace.js'

export type LibraryFilter = 'all' | 'inroom'

/** A library item, as far as the lists read it. */
export interface ItemFacts {
  readonly id: string
  readonly name?: string | null
  readonly category?: string | null
}

/** A job of the library manager (GET /api/library/jobs), as far as the list reads it. */
export interface JobFacts {
  readonly id: string
  readonly kind?: string | null
  readonly status?: string | null
  readonly message?: string | null
  readonly cost_usd?: number | null
  readonly cost_usd_estimate?: number | null
  readonly mock?: boolean | null
}

/** What the search box holds, as the filter compares it. */
export function searchQuery(text: string): string {
  return text.trim().toLowerCase()
}

/** A chip toggles its filter; All always shows all. */
export function nextFilter(current: LibraryFilter, chosen: LibraryFilter): LibraryFilter {
  return current === chosen && chosen !== 'all' ? 'all' : chosen
}

/** The items to list: In the scene keeps the ones placed; a query matches the name, the id or the category. */
export function shownItems<T extends ItemFacts>(all: readonly T[], filter: LibraryFilter, query: string, placed: ReadonlyMap<string, number>): T[] {
  return all.filter((l) => {
    if (filter === 'inroom' && !placed.get(l.id)) return false
    if (!query) return true
    return [l.name, l.id, l.category].some((s) => (s ?? '').toLowerCase().includes(query))
  })
}

/** Pieces placed from the library (not kinds of piece). */
export function placedCount(all: readonly ItemFacts[], placed: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const l of all) sum += placed.get(l.id) ?? 0
  return sum
}

/** The search box's placeholder: the phone counts the items. */
export function searchPlaceholder(count: number, phone: boolean): string {
  return count && phone ? `Search ${String(count)} ${count === 1 ? 'item' : 'items'}` : 'Search furniture'
}

/** A row's accessible name. */
export function addLabel(name: string, inRoom: boolean): string {
  return `Add ${name}${inRoom ? ' (in the scene)' : ''}`
}

/** The In the scene mark's tooltip and words. */
export function inRoomTip(n: number): string {
  return n > 1 ? `In the scene · ${String(n)}` : 'In the scene'
}
export function inRoomWord(n: number): string {
  return n > 1 ? `In scene · ${String(n)}` : 'In scene'
}

/** The list's empty line when nothing matches. */
export function nothingShown(query: string, typed: string): string {
  return query ? `Nothing matches "${typed}".` : 'Nothing from the library is in this scene yet.'
}

/** The jobs shown: queued, running or failed ones, and the ones that finished while this page was open (Place);
 *  never one dismissed here. */
export function shownJobs<T extends JobFacts>(jobs: readonly T[], dismissed: ReadonlySet<string>, finished: ReadonlySet<string>): T[] {
  return jobs.filter((j) => !dismissed.has(j.id) && (j.status === 'queued' || j.status === 'running' || j.status === 'failed' || finished.has(j.id)))
}

export type JobKind = 'ready' | 'failed' | 'running' | 'queued'
export function jobKind(status: string | null | undefined): JobKind {
  return status === 'done' ? 'ready' : status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'queued'
}

/** A job's line: what it is doing, and what it costs (not for a failed one, which costs nothing). */
export function jobLine(j: JobFacts, kind: JobKind, usd: (v: number) => string): string {
  const message = j.message ?? ''
  const what = j.kind === 'rescale' ? 'Refitting to its new size'
    : kind === 'queued' ? 'Waiting its turn'
      : kind === 'running' ? (message ? message.charAt(0).toUpperCase() + message.slice(1) : 'Making the model')
        : kind === 'ready' ? 'In the library' : message || 'It stopped on the server'
  const cost = j.cost_usd ?? j.cost_usd_estimate
  const price = typeof cost === 'number' && cost > 0 && kind !== 'failed' ? (j.mock ? `${usd(cost)} (mock, $0)` : usd(cost)) : null
  return dots([what, price])
}

/** "Making Oak chair · $0.10. It shows up here when it's ready." */
export function makingText(name: string, cost: number | null | undefined, usd: (v: number) => string): string {
  return `Making ${name}${typeof cost === 'number' && cost > 0 ? ` · ${usd(cost)}` : ''}. It shows up here when it's ready.`
}

/** A failed job's toast. */
export function jobFailedText(name: string, message: string | null | undefined): string {
  return `Couldn't make ${name}: ${(message ?? '') || 'it stopped on the server'}`
}

/** A placed piece's mark in the In the scene list: missing from the library, no GLB, raised, or nothing. */
export function placedMark(missing: boolean, noGlb: boolean, y: number): string {
  if (missing) return 'Missing'
  if (noGlb) return 'No GLB'
  return upText(y)
}
