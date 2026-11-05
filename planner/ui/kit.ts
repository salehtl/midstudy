// midstudy planner UI kit: tiny DOM builders for the kit.css elements, shared by every UI module. No state lives here.
//   h('div.row.is-selected', { onclick, title, dataset: {…}, style: {…}, …attrs }, ...children)   (children: nodes, strings, arrays, null)
//   button({ label, icon, kind: 'primary'|'secondary'|'quiet'|'danger', onClick, title, kbd, disabled, block })
//   iconButton(icon, { label (aria + tooltip), kind: 'quiet'|'secondary', onClick, kbd, size })
//   pill(status, text?)            status: queued|preparing|training|ready|failed|cancelled (icon + word; text overrides)
//   kbd(text)                      a keycap
//   toggle({ label, hint, checked, onChange })   → row with .switch; row.input is the checkbox
//   segmented(options [{ value, label, icon }], value, onChange, { small })   → .seg; seg.set(value)
//   slider({ label, min, max, step, value, format(v), onInput })   → .slider-row; row.set(value)
//   chip({ label, pressed, onClick })   → .chip; chip.set(pressed)
//   field({ label, value, placeholder, onInput, type })   → .field; field.input
//
// h() is typed by its selector: h('input.x') is an HTMLInputElement, h('label.y') an HTMLLabelElement. Its attributes
// work as in v1: null, undefined and false are left out; on<event> handlers are listened to (typed by the event);
// dataset and style are assigned; class is appended; a non-string value the element has as a property is set as the
// property (disabled, hidden, checked, value, min…); anything else is an attribute (true is the empty string).
import { icon, ring } from './icons.js'
import { fillPercent } from './logic/workspace.js'

type TagOf<S extends string> = S extends `${infer T}.${string}` ? T : S
/** The element h(selector) makes. */
export type ElementOf<S extends string> = TagOf<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagOf<S>] : HTMLElement

type Scalar = string | number | boolean | null | undefined
type Handlers = { readonly [K in keyof HTMLElementEventMap as `on${K}`]?: ((e: HTMLElementEventMap[K]) => void) | null | undefined }
interface Props {
  readonly dataset?: Readonly<Record<string, string | null | undefined>> | null | undefined
  readonly style?: Readonly<Record<string, string>> | null | undefined
  readonly class?: string | undefined
  readonly id?: string | undefined
  readonly role?: string | null | undefined
  readonly type?: string | undefined
  readonly title?: string | null | undefined
  readonly hidden?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly checked?: boolean | undefined
  readonly value?: string | number | undefined
  readonly placeholder?: string | undefined
  readonly min?: number | string | undefined
  readonly max?: number | string | undefined
  readonly step?: number | string | undefined
  readonly rows?: number | undefined
  readonly maxLength?: number | null | undefined
  readonly tabindex?: number | undefined
  readonly src?: string | undefined
  readonly alt?: string | undefined
  readonly href?: string | undefined
  readonly target?: string | undefined
  readonly rel?: string | undefined
  readonly loading?: string | undefined
  readonly draggable?: boolean | 'true' | 'false' | undefined
  readonly spellcheck?: boolean | undefined
  readonly autocomplete?: string | undefined
  readonly inputmode?: string | null | undefined
  readonly enterkeyhint?: string | undefined
  readonly accept?: string | undefined
}
/** h()'s attributes: the props above, aria-* attributes and on<event> handlers. */
export type Attrs = Props & Handlers & Readonly<Record<`aria-${string}`, Scalar>>
/** A child of h(): a node, text (numbers and true as text), nothing (null, undefined, false), or a list of them. */
export type Child = Node | string | number | boolean | null | undefined | readonly Child[]

function isAttrs(a: Attrs | Child): a is Attrs {
  return typeof a === 'object' && a !== null && !(a instanceof Node) && !Array.isArray(a)
}
function isList(c: Child): c is readonly Child[] {
  return Array.isArray(c)
}
function isListener(v: unknown): v is EventListener {
  return typeof v === 'function'
}

function append(el: Element, kids: readonly Child[]): void {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue
    if (isList(c)) append(el, c)
    else el.append(c instanceof Node ? c : String(c))
  }
}

export function h<S extends string>(sel: S, attrs?: Attrs | Child, ...children: Child[]): ElementOf<S>
export function h(sel: string, attrs?: Attrs | Child, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = sel.split('.')
  const el = document.createElement((tag ?? '') || 'div')
  if (classes.length) el.className = classes.join(' ')
  if (attrs) {
    if (isAttrs(attrs)) setAttrs(el, attrs)
    else children.unshift(attrs)
  }
  append(el, children)
  return el
}
function setAttrs(el: HTMLElement, a: Attrs): void {
  for (const k of Object.keys(a)) {
    const v: unknown = Reflect.get(a, k)
    if (v === null || v === undefined || v === false) continue
    if (k.startsWith('on') && isListener(v)) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'class') el.className += ` ${attrText(v)}`
    else if (k in el && typeof v !== 'string') Reflect.set(el, k, v)
    else el.setAttribute(k, v === true ? '' : attrText(v))
  }
}
// An attribute's text: Attrs allows only strings, numbers and booleans here (an object would read "[object Object]").
function attrText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : ''
}

export interface ButtonOptions {
  readonly label?: string
  readonly icon?: string
  readonly kind?: string
  readonly onClick?: ((e: MouseEvent) => void) | undefined
  readonly title?: string
  readonly kbd?: string
  readonly disabled?: boolean
  readonly block?: boolean
  readonly type?: string
}
export function button({ label, icon: ic, kind = 'secondary', onClick, title, kbd: key, disabled, block, type = 'button' }: ButtonOptions = {}): HTMLButtonElement {
  return h(`button.btn.btn-${kind}${block ? '.btn-block' : ''}`, { type, onclick: onClick, disabled, title: (title ?? '') || null, dataset: key ? { tip: (title ?? '') || label, kbd: key } : null },
    ic ? icon(ic, { size: 20 }) : null, label ? h('span', label) : null)
}

export interface IconButtonOptions {
  readonly label?: string
  readonly kind?: string
  readonly onClick?: (e: MouseEvent) => void
  readonly kbd?: string
  readonly size?: number
}
export function iconButton(name: string, { label, kind = 'quiet', onClick, kbd: key, size = 20 }: IconButtonOptions = {}): HTMLButtonElement {
  return h(`button.btn.btn-icon.btn-${kind}`, { type: 'button', onclick: onClick, 'aria-label': label, dataset: label ? { tip: label, ...(key ? { kbd: key } : {}) } : null }, icon(name, { size }))
}

const PILL: ReadonlyMap<string, readonly [string | null, string]> = new Map([
  ['queued', ['clock', 'Queued']], ['preparing', [null, 'Preparing']], ['training', [null, 'Training']],
  ['ready', ['check', 'Ready']], ['failed', ['warning', 'Failed']], ['cancelled', ['cancelled', 'Cancelled']],
])
export function pill(status: string, text?: string, progress: number | null = null): HTMLSpanElement {
  const [ic, word] = PILL.get(status) ?? ['info', status]
  const glyph = ic ? icon(ic, { size: 14 }) : ring(status === 'training' ? progress : null, { size: 14 })
  return h(`span.pill.pill-${status}`, glyph, h('span', (text ?? '') || word))
}

export function kbd(text: string): HTMLElement {
  return h('kbd.kbd', text)
}

export interface ToggleOptions {
  readonly label: string
  readonly hint?: string
  readonly checked?: boolean
  readonly onChange?: (checked: boolean) => void
}
export type Toggle = HTMLLabelElement & { readonly input: HTMLInputElement }
export function toggle({ label, hint, checked = false, onChange }: ToggleOptions): Toggle {
  const input: HTMLInputElement = h('input.switch', { type: 'checkbox', checked, onchange: () => { onChange?.(input.checked) } })
  const row = h('label.toggle-row', h('span.toggle-text', h('span.toggle-label', label), hint ? h('span.toggle-hint', hint) : null), input)
  return Object.assign(row, { input })
}

export interface SegOption<V> {
  readonly value: V
  readonly label?: string
  readonly icon?: string
  readonly kbd?: string
  readonly tip?: string
}
export type Segmented<V> = HTMLDivElement & { readonly set: (v: V) => void }
export function segmented<V extends string | number>(options: readonly SegOption<V>[], value: V, onChange?: (v: V) => void, { small = false, label }: { readonly small?: boolean; readonly label?: string } = {}): Segmented<V> {
  const seg = h(`div.seg${small ? '.seg-sm' : ''}`, { role: 'group', 'aria-label': (label ?? '') || null })
  const set = (v: V): void => {
    for (const b of seg.children) if (b instanceof HTMLElement) b.setAttribute('aria-pressed', String(b.dataset['value'] === String(v)))
  }
  for (const o of options) {
    seg.append(h('button', { type: 'button', dataset: { value: String(o.value), ...(o.kbd ? { tip: (o.tip ?? '') || o.label, kbd: o.kbd } : {}) }, onclick: () => { set(o.value); onChange?.(o.value) } },
      o.icon ? icon(o.icon, { size: 20 }) : null, o.label ? h('span', o.label) : null))
  }
  set(value)
  return Object.assign(seg, { set })
}

export interface SliderOptions {
  readonly label: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly value?: number
  readonly format?: (v: number) => string
  readonly onInput?: (v: number) => void
}
export type Slider = HTMLDivElement & { readonly set: (v: number | string) => void; readonly input: HTMLInputElement }
export function slider({ label, min = 0, max = 1, step = 0.01, value = 0, format = (v: number) => String(v), onInput }: SliderOptions): Slider {
  const out = h('span.slider-value')
  const input = h('input.slider', { type: 'range', min, max, step, 'aria-label': label })
  // v is a number from the panel, or the input's own string while it is dragged (v1 set both).
  const set = (v: number | string): void => {
    input.value = String(v)
    out.textContent = format(Number(v))
    input.style.setProperty('--fill', fillPercent(Number(v), min, max))
  }
  input.addEventListener('input', () => { set(input.value); onInput?.(Number(input.value)) })
  set(value)
  const row = h('div.slider-row', h('div.slider-head', h('span.slider-label', label), out), input)
  return Object.assign(row, { set, input })
}

export interface ChipOptions {
  readonly label: string
  readonly pressed?: boolean
  readonly onClick?: (e: MouseEvent) => void
}
export type Chip = HTMLButtonElement & { readonly set: (on: boolean) => void }
export function chip({ label, pressed = false, onClick }: ChipOptions): Chip {
  const c = h('button.chip', { type: 'button', onclick: onClick })
  const set = (on: boolean): void => {
    c.setAttribute('aria-pressed', String(on))
    c.replaceChildren(...(on ? [icon('check', { size: 16 })] : []), h('span', label))
  }
  set(pressed)
  return Object.assign(c, { set })
}

export interface FieldOptions {
  readonly label?: string
  readonly value?: string
  readonly placeholder?: string
  readonly onInput?: (value: string) => void
  readonly type?: string
}
export type Field = HTMLLabelElement & { readonly input: HTMLInputElement }
export function field({ label, value = '', placeholder = '', onInput, type = 'text' }: FieldOptions = {}): Field {
  const input: HTMLInputElement = h('input.input', { type, value, placeholder, spellcheck: false, autocomplete: 'off', oninput: () => { onInput?.(input.value) } })
  const f = h('label.field', label ? h('span.field-label', label) : null, input)
  return Object.assign(f, { input })
}
