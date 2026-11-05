// The Layouts panel's rules and words (ui/panels/layouts.ts, contract §2.7): a typed name to its slug and back, the
// Save as new form's check, the "Now in the scene" card, the list's order and each row's meta. Pure, TScert-checked.

import { dots } from './text.js'

/** A layout as the panel lists it (GET /api/layouts details). */
export interface LayoutFacts {
  readonly name: string
  readonly items?: number | null
  readonly updated?: string | null
}

/** "Evening, lamp by the window" → "evening-lamp-by-the-window": lower case, accents dropped, runs of anything else to
 *  one '-', at most 64 characters, no '-' at either end. */
export function slugify(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
}

/** "evening-two-chairs" → "Evening two chairs". */
export function pretty(name: string | null | undefined): string {
  const s = (name ?? '').replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Save as new's check of the typed name: its slug, and an error or a hint. */
export interface NameCheck {
  readonly slug: string
  readonly error: string | null
  readonly hint: string
}
export function checkName(text: string, taken: readonly string[], shown: (slug: string) => string, isSlug: (s: string) => boolean): NameCheck {
  const slug = slugify(text)
  if (!text.trim()) return { slug, error: null, hint: 'Letters, numbers and spaces.' }
  if (!slug || !isSlug(slug)) return { slug, error: 'Use letters or numbers in the name.', hint: '' }
  if (taken.includes(slug)) return { slug, error: `${shown(slug)} already exists. Pick another name, or use its … menu to save over it.`, hint: '' }
  return { slug, error: null, hint: '' }
}

/** The card's title: the current layout's name, else whether anything is placed. */
export function cardTitle(currentShown: string | null, placed: number): string {
  return currentShown ?? (placed ? 'Not saved as a layout' : 'Nothing placed')
}

/** "2 items · changed since saved". */
export function cardMeta(placed: number, hasCurrent: boolean, dirty: boolean): string {
  const state = hasCurrent ? (dirty ? 'changed since saved' : 'saved') : placed ? 'not saved yet' : 'add furniture first'
  return `${String(placed)} ${placed === 1 ? 'item' : 'items'} · ${state}`
}

/** Load's question when the furniture has changes nobody saved. */
export function loadBody(currentShown: string | null): string {
  return currentShown === null
    ? "The furniture in the scene isn't saved as a layout. Loading replaces it."
    : `The furniture has changes that aren't saved to ${currentShown}. Loading replaces it.`
}

/** Newest saved first, then by name. */
export function sortLayouts<T extends LayoutFacts>(details: readonly T[]): T[] {
  return [...details].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.name.localeCompare(b.name))
}

/** A row's meta: "3 items · 26 Oct, 10:12", or null when there is neither. */
export function rowMeta(items: number | null | undefined, date: string | null): string | null {
  const count = typeof items === 'number' && Number.isFinite(items) ? `${String(items)} ${items === 1 ? 'item' : 'items'}` : null
  return dots([count, date]) || null
}

/** The note under the card: which scene the layouts belong to. */
export function savedWithText(sceneTitle: string | null): string {
  return sceneTitle ? `Saved with ${sceneTitle}. Other scenes keep their own.` : ''
}

/** The list's empty line. */
export function noLayoutsText(sceneOpen: boolean): string {
  return sceneOpen ? 'No layouts for this scene yet. Place some furniture, then Save layout.' : 'Open a scene to see its layouts.'
}
