// A form sheet for the v4 flows (library add / edit, retrain): a centred dialog on the desktop, a bottom sheet on the
// phone (scrolling body, actions pinned at the bottom, lifted above the keyboard). One at a time; Esc, the scrim or
// Cancel close it, and the engine's keys are swallowed while it's open. Styles: styles/manage.css.
//   openSheet(shell, { title, sub, body: Node, actions: [Node], cls, onClose, label }) →
//     { el, body, close(), setActions(nodes), setTitle(text, sub), isOpen() }
import { h, type Child } from './kit.js'
import { icon } from './icons.js'
import { keyboardInset } from './logic/chrome.js'
import type { Shell } from './shell.js'

export interface SheetOptions {
  readonly title?: string
  readonly sub?: string
  readonly body?: Node | null
  readonly actions?: readonly Child[]
  readonly cls?: string
  readonly onClose?: () => void
  readonly label?: string
}
export interface Sheet {
  readonly el: HTMLDivElement
  readonly body: HTMLDivElement
  readonly isOpen: () => boolean
  readonly close: () => void
  readonly setActions: (nodes: Child) => void
  readonly setTitle: (title: string, sub?: string) => void
}

let current: Sheet | null = null
let filterAdded = false

export function openSheet(shell: Shell, { title = '', sub = '', body = null, actions = [], cls = '', onClose, label }: SheetOptions = {}): Sheet {
  current?.close()
  if (!filterAdded) {
    filterAdded = true
    shell.addKeyFilter((e) => {
      if (!current) return false
      if (e.key === 'Escape') { e.preventDefault(); current.close() }
      return true
    })
  }
  const phone = shell.isPhone()
  const titleEl = h('h2.ms-title', title)
  const subEl = h('p.ms-sub', { hidden: !sub }, sub)
  const close = h('button.ms-close', { type: 'button', 'aria-label': 'Close', onclick: () => { api.close() } }, h('span', icon('close', { size: 16, stroke: 2 })))
  const bodyEl = h('div.ms-body', body)
  const foot = h('div.ms-foot', actions)
  const el = h(`div.ms${phone ? '.is-phone' : '.is-desktop'}${cls ? `.${cls}` : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': (label ?? '') || title },
    phone ? h('div.sheet-grab', { 'aria-hidden': 'true' }) : null,
    h('header.ms-head', h('div.ms-titles', titleEl, subEl), close),
    bodyEl, foot)
  const scrim = h('div.scrim.ms-scrim', { onclick: () => { api.close() } })
  // ride the phone keyboard
  const vv = window.visualViewport
  const place = (): void => {
    if (!phone) return
    const kb = keyboardInset(window.innerHeight, vv ? vv.height : null, vv ? vv.offsetTop : 0)
    el.style.bottom = `${String(kb)}px`
    el.style.maxHeight = `${String(Math.max(240, (vv ? vv.height : window.innerHeight) - 24))}px`
  }
  vv?.addEventListener('resize', place)
  shell.mounts.layer.append(scrim, el)
  place()
  const onMode = (): void => { api.close() }
  shell.events.addEventListener('mode', onMode)
  const api: Sheet = {
    el,
    body: bodyEl,
    isOpen: () => current === api,
    close() {
      if (current !== api) return
      current = null
      vv?.removeEventListener('resize', place)
      shell.events.removeEventListener('mode', onMode)
      scrim.remove()
      el.remove()
      onClose?.()
    },
    setActions(nodes: Child) { foot.replaceChildren(...flat(nodes)) },
    setTitle(t: string, s?: string) {
      titleEl.textContent = t
      if (s !== undefined) { subEl.textContent = s || ''; subEl.hidden = !s }
    },
  }
  current = api
  if (!phone) {
    requestAnimationFrame(() => {
      const first = el.querySelector('input:not([type="file"]), button.ms-primary')
      if (first instanceof HTMLElement) first.focus({ preventScroll: true })
    })
  }
  return api
}

function isList(c: Child): c is readonly Child[] {
  return Array.isArray(c)
}
// [nodes].flat().filter(Boolean): one level of a list, without the empty ones.
function flat(nodes: Child): (Node | string)[] {
  const out: (Node | string)[] = []
  for (const n of isList(nodes) ? nodes : [nodes]) {
    if (n instanceof Node || (typeof n === 'string' && n !== '')) out.push(n)
    else if (n === true || (typeof n === 'number' && n !== 0 && !Number.isNaN(n))) out.push(String(n))
  }
  return out
}

// Small form helpers shared by the sheets.
export function formRow(label: string, control: Node, hint?: string): HTMLLabelElement {
  return h('label.ms-row', h('span.ms-label', label), control, hint ? h('span.ms-hint', hint) : null)
}
export interface TextInputOptions {
  /** A number is set as the property, a string as the attribute (as h() does, and v1 did). */
  readonly value?: string | number
  readonly placeholder?: string
  readonly type?: string
  readonly inputmode?: string
  readonly maxLength?: number
  readonly onInput?: (value: string) => void
  readonly label?: string
}
export function textInput({ value = '', placeholder = '', type = 'text', inputmode, maxLength, onInput, label }: TextInputOptions = {}): HTMLInputElement {
  const input: HTMLInputElement = h('input.ms-input', { type, value, placeholder, inputmode: (inputmode ?? '') || null, maxLength: (maxLength ?? 0) || null, spellcheck: false, autocomplete: 'off', 'aria-label': (label ?? '') || null, oninput: () => { onInput?.(input.value) } })
  return input
}
