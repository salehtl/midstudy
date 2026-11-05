// Dates as the panels show them ("09:52", "26 Oct, 10:12", "Today, 09:52", "Sat 25 Oct, 18:31"), from a date's local
// parts (the shell reads them off a Date: panels/common.ts). Pure, TScert-checked.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** A local date: weekday 0–6 (Sunday first), day of the month, month 0–11, hours and minutes. */
export interface DateParts {
  readonly weekday: number
  readonly day: number
  readonly month: number
  readonly hours: number
  readonly minutes: number
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** "09:52". */
export function clockText(p: DateParts): string {
  return `${pad2(p.hours)}:${pad2(p.minutes)}`
}

/** "26 Oct, 10:12". */
export function shortDateText(p: DateParts): string {
  return `${String(p.day)} ${MONTHS[p.month] ?? ''}, ${clockText(p)}`
}

/** "Today, 09:52", "Yesterday, 18:31", else "Sat 25 Oct, 18:31"; daysAgo counts calendar days before today. */
export function dayDateText(p: DateParts, daysAgo: number): string {
  if (daysAgo === 0) return `Today, ${clockText(p)}`
  if (daysAgo === 1) return `Yesterday, ${clockText(p)}`
  return `${DAYS[p.weekday] ?? ''} ${String(p.day)} ${MONTHS[p.month] ?? ''}, ${clockText(p)}`
}
