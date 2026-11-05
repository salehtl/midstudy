// Shared bits for the area C panels (Library, In the scene, Layouts, Scene, Renders): thumbnails, empty states,
// dates, money, and the "the server isn't answering" check. Styles: styles/panels.css. The words and numbers:
// logic/text.ts, logic/dates.ts, logic/renders.ts.
import { h } from '../kit.js'
import { icon, svgFrom } from '../icons.js'
import { RENDER_MODELS, type Engine, type LibItem } from '../seam.js'
import { isOfflineText, monogram } from '../logic/text.js'
import { clockText, dayDateText, shortDateText, type DateParts } from '../logic/dates.js'
import { strokeWidth } from '../logic/glyphs.js'
import { modelShort as shortName } from '../logic/renders.js'

// Extra icons the panels need (same 20 px grid and stroke as ui/icons.ts).
const EXTRA: ReadonlyMap<string, string> = new Map([
  ['sofa', '<path d="M4 9V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M3 15V11a1.5 1.5 0 0 1 3 0v1.5h8V11a1.5 1.5 0 0 1 3 0v4zM5 15v1.5M15 15v1.5"/>'],
  ['pick-floor', '<path d="M2.5 15.5h15M5 15.5l3-6h4l3 6M10 3v6.5"/><circle cx="10" cy="3" r="1.3" fill="currentColor" stroke="none"/>'],
  ['check-size', '<circle cx="4.5" cy="15.5" r="2"/><circle cx="15.5" cy="4.5" r="2"/><path d="M6 14l8-8" stroke-dasharray="2 2"/>'],
  ['check-circle', '<circle cx="10" cy="10" r="8"/><path d="M6.5 10.3l2.4 2.4 4.6-5"/>'],
  ['tilt', '<path d="M2.5 14.5l15-4M4 17.5h12"/><circle cx="11" cy="10.4" r="1.2" fill="currentColor" stroke="none"/>'],
  ['retry', '<path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2"/>'],
  ['bookmark', '<path d="M5.5 3.5h9v13l-4.5-3-4.5 3z"/>'],
  ['bookmark-fill', '<path d="M5.5 3.5h9v13l-4.5-3-4.5 3z" fill="currentColor"/>'],
  ['minus', '<path d="M4 10h12"/>'],
  ['chevron-left', '<path d="M12 6l-4 4 4 4"/>'],
  ['sliders', '<path d="M3 6h8M15 6h2M3 14h2M9 14h8"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/>'],
  ['external', '<path d="M11 3.5h5.5V9M16.5 3.5L9 11M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8"/>'],
  ['sun', '<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/>'],
])
export function pic(name: string, { size = 20, stroke = 1.5 }: { readonly size?: number; readonly stroke?: number } = {}): SVGSVGElement {
  const body = EXTRA.get(name)
  if (body === undefined) return icon(name, { size, stroke })
  return svgFrom(`<svg class="icon" width="${String(size)}" height="${String(size)}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${String(strokeWidth(size, stroke))}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`)
}

// A kit button with one of the icons above in front of its label.
export function withIcon<B extends HTMLElement>(btn: B, name: string, size = 18): B {
  btn.prepend(pic(name, { size }))
  return btn
}

// A library item's thumbnail, or its monogram when there's none (or it fails to load).
export function itemThumb(engine: Engine, lib: LibItem | null | undefined, cls = 'p-thumb'): HTMLElement {
  const mono = (): HTMLElement => h(`span.${cls}.is-mono`, { 'aria-hidden': 'true' }, monogram((lib?.name ?? '') || lib?.id))
  const rel = lib?.assets?.thumb
  if (!rel) return mono()
  const img = h(`img.${cls}`, { alt: '', loading: 'lazy', draggable: false, src: engine.assetUrl(rel) })
  img.addEventListener('error', () => { img.replaceWith(mono()) }, { once: true })
  return img
}

export function emptyState({ icon: ic, title, body, action }: { readonly icon: string; readonly title: string; readonly body?: string; readonly action?: Node }): HTMLDivElement {
  return h('div.p-empty', h('span.p-empty-icon', pic(ic, { size: 20 })), h('h3.p-empty-title', title), body ? h('p.p-empty-body', body) : null, action ?? null)
}

// An error's message: an Error's (else "Error"), or a string thrown as it is.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || String(err) : typeof err === 'string' ? err : ''
}
// Errors from fetch() failing (no HTTP status): the engine words them "the server isn't answering".
export const isOffline = (err: unknown): boolean => isOfflineText(errorMessage(err))
export const OFFLINE_BODY = "Your changes stay in this tab. Check the server is running and you're on its network, then retry."

type When = string | number | Date | null | undefined
// As `new Date(v)` reads it (null is 1970, undefined no date), or null when that is no date.
function toDate(v: When): Date | null {
  const d = v instanceof Date ? v : new Date(v === null ? 0 : v ?? NaN)
  return Number.isNaN(d.getTime()) ? null : d
}
function partsOf(d: Date): DateParts {
  return { weekday: d.getDay(), day: d.getDate(), month: d.getMonth(), hours: d.getHours(), minutes: d.getMinutes() }
}
const dayStart = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
// "10:12"
export function clock(v: When): string {
  const d = toDate(v)
  return d ? clockText(partsOf(d)) : ''
}
// "26 Oct, 10:12"
export function shortDate(v: When): string {
  const d = toDate(v)
  return d ? shortDateText(partsOf(d)) : ''
}
// "Today, 09:52" · "Yesterday, 18:31" · "Sat 25 Oct, 18:31"
export function dayDate(v: When): string {
  const d = toDate(v)
  if (!d) return ''
  return dayDateText(partsOf(d), Math.round((dayStart(new Date()) - dayStart(d)) / 864e5))
}

export { money } from '../logic/text.js'
export const modelShort = (m: string | null | undefined): string => shortName(m, m ? RENDER_MODELS[m]?.label : undefined)

// Fetch an image URL as a JPEG data URL plus its size (Render again from a past render's input).
export async function imageShot(url: string): Promise<{ readonly dataUrl: string; readonly width: number; readonly height: number }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned HTTP ${String(res.status)}`)
  const blob = await res.blob()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { resolve(typeof r.result === 'string' ? r.result : '') }
    r.onerror = () => { reject(r.error ?? new Error(`could not read ${url}`)) }
    r.readAsDataURL(blob)
  })
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  return { dataUrl, width: img.naturalWidth, height: img.naturalHeight }
}
