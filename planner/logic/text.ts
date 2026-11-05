// What the planner writes for people: sizes, prices, dates, byte counts, scene titles, error lines and file names.
// v1's fmtCm, dimsText, fmtUsd (engine.js), friendlyDate, clock, relDate, sceneTitle, fmtBytes (data.js), reportError's
// line and the upload name. Pure, for TScert (tscert/README.md): the shells read Dates and pass their parts.

export interface DimsCm {
  readonly w: number
  readonly d: number
  readonly h: number
}

/** v1's fmtCm: whole centimetres as they are, else one decimal. */
export function fmtCm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** v1's dimsText: "W × D × H cm", '' without dims. */
export function dimsText(d: DimsCm | null | undefined): string {
  if (!d) return ''
  return `${fmtCm(d.w)} × ${fmtCm(d.d)} × ${fmtCm(d.h)} cm`
}

/** v1's fmtUsd: cents as $0.10, anything finer to four places ($0.0398). */
export function fmtUsd(v: number): string {
  return `$${Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4)}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** A local date as the shell read it (Date's getDay, getDate, getMonth, getHours, getMinutes). */
export interface DateParts {
  readonly weekday: number
  readonly day: number
  readonly month: number
  readonly hours: number
  readonly minutes: number
}

/** Two digits (v1's pad). */
export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** v1's friendlyDate: "Sun 26 Oct, 09:36". */
export function friendlyText(p: DateParts): string {
  return `${DAYS[p.weekday] ?? 'undefined'} ${String(p.day)} ${MONTHS[p.month] ?? 'undefined'}, ${pad2(p.hours)}:${pad2(p.minutes)}`
}

/** v1's clock: "09:36". */
export function clockText(p: DateParts): string {
  return `${pad2(p.hours)}:${pad2(p.minutes)}`
}

/** v1's relDate: "Today, 09:36", "Yesterday, 09:36", else the friendly date; `daysAgo` counts local midnights. */
export function relText(daysAgo: number, p: DateParts): string {
  if (daysAgo === 0) return `Today, ${clockText(p)}`
  if (daysAgo === 1) return `Yesterday, ${clockText(p)}`
  return friendlyText(p)
}

/** v1's sceneTitle: the title as typed, else the date it was made, else its name. */
export function sceneTitleText(title: string, friendlyCreated: string, name: string): string {
  return title.trim() || friendlyCreated || name || ''
}

/** v1's fmtBytes: '' for nothing, then KB (at least 1), MB or GB. */
export function fmtBytes(n: number): string {
  if (!(n > 0)) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${String(Math.max(1, Math.round(n / 1e3)))} KB`
}

/** v1's reportError line: the message, then the error's own text unless the message already says it. */
export function errorLine(msg: string, detail: string): string {
  return detail && !msg.includes(detail) ? `${msg}: ${detail}` : msg
}

/** v1's upload name: printable ASCII only, photo.jpg (or `fallback`) when the file has none. */
export function uploadName(name: string, fallback: string): string {
  return (name || fallback).replace(/[^\x20-\x7e]/g, '_')
}
