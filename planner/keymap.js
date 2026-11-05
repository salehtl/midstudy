// midstudy planner keymap: one registry for every keyboard shortcut. Modules register commands; the Shortcuts sheet
// (ui/shortcuts.js) lists them, so a shortcut that works is a shortcut that is shown, and the other way round.
//
// createKeymap({ groups }) → keymap      groups: the sheet's group order (others follow, in first-registered order)
//   register(cmd) → unregister()      cmd = {
//     id          'item.rotate'           unique; a second register with the same id replaces the first
//     group       'Selection'             heading in the Shortcuts sheet (groups keep their first-registered order)
//     label       'Rotate 15°'            what it does, as the sheet shows it
//     keys        ['r', 'shift+r']        combos (below); the first is the one the sheet and tooltips show
//     display     optional                combos to show instead of `keys` (['arrows'] for the eight arrow combos)
//     run(e, combo)                       the action; return false to let the next command with that key try
//     when()      optional                false: skipped (as if not registered), e.g. "only with a selection"
//     priority    0                       higher runs first among commands sharing a key (Esc: leave the ruler, then
//                                         Adjust floor, then deselect)
//     repeat      true                    false: ignore auto-repeat (held keys)
//     inInputs    false                   true: also while typing in an input, textarea, select or contenteditable
//     hidden      false                   true: works, but is left out of the sheet
//   }
//   describe({ id, group, label, keys }) a gesture the sheet lists but the keymap doesn't run ('shift+click', 'drag')
//   handle(keydownEvent) → true when a command ran (it has had preventDefault)
//   list() → [{ group, items: [{ id, label, keys: [display strings] }] }]
//   format(combo) → '⌘⇧Z' / 'Ctrl+Shift+Z'      lookup(id) → the first combo's display string, or ''
//   events: 'change' when the registry changes (the sheet re-renders)
//
// Combos: '+'-joined, modifiers first: mod (⌘ on a Mac, Ctrl elsewhere), ctrl, alt, shift, then one key. Keys are
// lower-case letters, digits, punctuation as unshifted on a US keyboard ('/', '=', '-', ',' …) and named keys as
// KeyboardEvent.key spells them, lower-cased: escape, enter, delete, backspace, arrowup, pageup, home, tab, ' ' (space).
// So '?' is 'shift+/' and '+' is 'shift+='. Letters come from e.key (they follow the keyboard layout), punctuation and
// digits from e.code (the physical key: Shift and ⌘ don't change what it is). Modifiers must match exactly: 'r' doesn't
// fire on ⌘R, and 'mod+z' doesn't fire on ⌘⇧Z.

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const MOD_ORDER = ['mod', 'ctrl', 'alt', 'shift']
const CODE_KEY = {
  Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
  NumpadDecimal: '.', NumpadEnter: 'enter',
}
const ALIAS = { esc: 'escape', del: 'delete', space: ' ', cmd: 'mod', meta: 'mod', option: 'alt', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', pgup: 'pageup', pgdn: 'pagedown', plus: '=' }

// '⌘⇧Z' etc. Shift+/ reads '?', Shift+= reads '+' (what the key says, not how to type it).
const MAC_MOD = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
const PC_MOD = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const KEY_TEXT = {
  escape: 'Esc', enter: '↵', delete: 'Del', backspace: '⌫', ' ': 'Space', tab: 'Tab', home: 'Home', end: 'End',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', pageup: 'PgUp', pagedown: 'PgDn',
  // gestures (describe()): read as words
  click: 'Click', drag: 'Drag', scroll: 'Scroll', pinch: 'Pinch', arrows: '← ↑ → ↓',
}

function parse(combo) {
  const parts = String(combo).toLowerCase().split('+')
  // a trailing '+' is the '+' key itself ('shift++' is odd, but allow 'mod++')
  if (parts.at(-1) === '' && parts.length > 1) { parts.pop(); parts[parts.length - 1] = '+' }
  const key = ALIAS[parts.at(-1)] ?? parts.at(-1)
  const mods = new Set(parts.slice(0, -1).map((m) => ALIAS[m] || m))
  for (const m of mods) if (!MOD_ORDER.includes(m)) throw new Error(`keymap: unknown modifier "${m}" in "${combo}"`)
  return { mods, key, id: [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+') }
}

// The canonical combo of a keydown, as parse() spells it.
export function comboOf(e) {
  let key
  if (CODE_KEY[e.code]) key = CODE_KEY[e.code]
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6)
  else if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(e.key)) key = e.code.slice(3).toLowerCase() // ⌥ or a non-Latin layout
  else key = (e.key === 'Spacebar' ? ' ' : e.key || '').toLowerCase()
  const mods = []
  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  if (mod) mods.push('mod')
  if (IS_MAC && e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  return [...mods, key].join('+')
}

export function format(combo) {
  const { mods, key } = parse(combo)
  let k = key
  const shown = new Set(mods)
  if (shown.has('shift') && (k === '/' || k === '=')) { shown.delete('shift'); k = k === '/' ? '?' : '+' }
  const text = KEY_TEXT[k] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))
  const names = IS_MAC ? MAC_MOD : PC_MOD
  const ms = MOD_ORDER.filter((m) => shown.has(m)).map((m) => names[m])
  return IS_MAC ? ms.join('') + text : [...ms, text].join('+')
}

const typingIn = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

export function createKeymap({ groups: order = [] } = {}) {
  const cmds = new Map() // id -> { ...cmd, combos: [{ id }], seq }
  const gestures = new Map()
  const groups = [] // first-registered order
  const events = new EventTarget()
  let seq = 0
  let changeQueued = false
  const changed = () => {
    if (changeQueued) return
    changeQueued = true
    queueMicrotask(() => { changeQueued = false; events.dispatchEvent(new CustomEvent('change')) })
  }
  const noteGroup = (g) => { if (g && !groups.includes(g)) groups.push(g) }

  function register(cmd) {
    if (!cmd?.id || typeof cmd.run !== 'function' || !Array.isArray(cmd.keys) || !cmd.keys.length) throw new Error('keymap.register needs { id, keys: [..], run }')
    const entry = { priority: 0, repeat: true, inInputs: false, hidden: false, group: 'General', ...cmd, combos: cmd.keys.map((k) => parse(k).id), seq: ++seq }
    cmds.set(cmd.id, entry)
    noteGroup(entry.group)
    changed()
    return () => { if (cmds.get(cmd.id) === entry) { cmds.delete(cmd.id); changed() } }
  }
  function describe(g) {
    gestures.set(g.id, { group: 'General', ...g, seq: ++seq })
    noteGroup(g.group || 'General')
    changed()
  }

  function handle(e) {
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return false
    const combo = comboOf(e)
    const typing = typingIn(e.target)
    const hits = [...cmds.values()]
      .filter((c) => c.combos.includes(combo) && (!typing || c.inInputs) && (c.repeat || !e.repeat))
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    for (const c of hits) {
      if (c.when && !c.when()) continue
      let res
      try { res = c.run(e, combo) } catch (err) { console.error(`shortcut ${c.id} failed`, err); res = undefined }
      if (res === false) continue
      e.preventDefault()
      return true
    }
    return false
  }

  function list() {
    const all = [...[...cmds.values()].filter((c) => !c.hidden), ...gestures.values()].sort((a, b) => a.seq - b.seq)
    const rank = (g) => { const i = order.indexOf(g); return i < 0 ? order.length + groups.indexOf(g) : i }
    return [...groups].sort((a, b) => rank(a) - rank(b))
      .map((group) => ({ group, items: all.filter((c) => c.group === group).map((c) => ({ id: c.id, label: c.label, keys: (c.display || c.keys).map(format) })) }))
      .filter((g) => g.items.length)
  }
  const lookup = (id) => { const c = cmds.get(id) || gestures.get(id); return c ? format((c.display || c.keys)[0]) : '' }

  return { register, describe, handle, list, format, lookup, comboOf, events, isMac: IS_MAC }
}
