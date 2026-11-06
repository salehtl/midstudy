// Key combos (planner/keymap.ts uses them): how a combo is spelled, which combo a keydown is, and how a combo reads
// in the Shortcuts sheet and on tooltips (main a292ee2's keymap.js). Pure, for TScert: whether this is a Mac comes in
// as a parameter.
//
// Combos: '+'-joined, modifiers first: mod (⌘ on a Mac, Ctrl elsewhere), ctrl, alt, shift, then one key. Keys are
// lower-case letters, digits, punctuation as unshifted on a US keyboard ('/', '=', '-', ',' …) and named keys as
// KeyboardEvent.key spells them, lower-cased: escape, enter, delete, backspace, arrowup, pageup, home, tab, ' ' (space).
// So '?' is 'shift+/' and '+' is 'shift+='. Letters come from e.key (they follow the keyboard layout), punctuation and
// digits from e.code (the physical key: Shift and ⌘ don't change what it is). Modifiers must match exactly: 'r' doesn't
// fire on ⌘R, and 'mod+z' doesn't fire on ⌘⇧Z.

const MOD_ORDER = ['mod', 'ctrl', 'alt', 'shift'] as const
type Mod = (typeof MOD_ORDER)[number]

function codeKey(code: string): string | null {
  switch (code) {
    case 'Slash': case 'NumpadDivide': return '/'
    case 'Backslash': return '\\'
    case 'Period': case 'NumpadDecimal': return '.'
    case 'Comma': return ','
    case 'Semicolon': return ';'
    case 'Quote': return "'"
    case 'BracketLeft': return '['
    case 'BracketRight': return ']'
    case 'Minus': case 'NumpadSubtract': return '-'
    case 'Equal': return '='
    case 'Backquote': return '`'
    case 'NumpadAdd': return '+'
    case 'NumpadMultiply': return '*'
    case 'NumpadEnter': return 'enter'
    default: return null
  }
}

function alias(k: string): string {
  switch (k) {
    case 'esc': return 'escape'
    case 'del': return 'delete'
    case 'space': return ' '
    case 'cmd': case 'meta': return 'mod'
    case 'option': return 'alt'
    case 'up': return 'arrowup'
    case 'down': return 'arrowdown'
    case 'left': return 'arrowleft'
    case 'right': return 'arrowright'
    case 'pgup': return 'pageup'
    case 'pgdn': return 'pagedown'
    case 'plus': return '='
    default: return k
  }
}

const isMod = (m: string): m is Mod => m === 'mod' || m === 'ctrl' || m === 'alt' || m === 'shift'

/** A combo as parsed: its modifiers, its key and its canonical spelling (modifiers in MOD_ORDER). Throws on an unknown
 *  modifier (a typo in a registration). */
export interface Combo {
  readonly mods: readonly Mod[]
  readonly key: string
  readonly id: string
}
export function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+')
  // a trailing '+' is the '+' key itself ('mod++')
  if (parts.length > 1 && parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] = '+' }
  const key = alias(parts[parts.length - 1] ?? '')
  const given = parts.slice(0, -1).map(alias)
  const mods: Mod[] = []
  for (const m of given) {
    if (!isMod(m)) throw new Error(`keymap: unknown modifier "${m}" in "${combo}"`)
  }
  for (const m of MOD_ORDER) if (given.includes(m)) mods.push(m)
  return { mods, key, id: [...mods, key].join('+') }
}

/** What comboOf reads of a keydown. */
export interface KeyLike {
  readonly code: string
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** The canonical combo of a keydown, as parseCombo spells it. */
export function comboOf(e: KeyLike, isMac: boolean): string {
  let key: string
  const fromCode = codeKey(e.code)
  if (fromCode !== null) key = fromCode
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6)
  else if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(e.key)) key = e.code.slice(3).toLowerCase() // ⌥ or a non-Latin layout
  else key = (e.key === 'Spacebar' ? ' ' : e.key).toLowerCase()
  const mods: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('mod')
  if (isMac && e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  return [...mods, key].join('+')
}

function keyText(k: string): string {
  switch (k) {
    case 'escape': return 'Esc'
    case 'enter': return '↵'
    case 'delete': return 'Del'
    case 'backspace': return '⌫'
    case ' ': return 'Space'
    case 'tab': return 'Tab'
    case 'home': return 'Home'
    case 'end': return 'End'
    case 'arrowup': return '↑'
    case 'arrowdown': return '↓'
    case 'arrowleft': return '←'
    case 'arrowright': return '→'
    case 'pageup': return 'PgUp'
    case 'pagedown': return 'PgDn'
    // gestures (describe()): read as words
    case 'click': return 'Click'
    case 'drag': return 'Drag'
    case 'scroll': return 'Scroll'
    case 'pinch': return 'Pinch'
    case 'arrows': return '← ↑ → ↓'
    default: return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)
  }
}

function modText(m: Mod, isMac: boolean): string {
  if (!isMac) return m === 'mod' || m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : 'Shift'
  return m === 'mod' ? '⌘' : m === 'ctrl' ? '⌃' : m === 'alt' ? '⌥' : '⇧'
}

/** '⌘⇧Z' on a Mac, 'Ctrl+Shift+Z' elsewhere. Shift+/ reads '?', Shift+= reads '+' (what the key says). */
export function formatCombo(combo: string, isMac: boolean): string {
  const { mods, key } = parseCombo(combo)
  let k = key
  let shown: readonly Mod[] = mods
  if (shown.includes('shift') && (k === '/' || k === '=')) { shown = shown.filter((m) => m !== 'shift'); k = k === '/' ? '?' : '+' }
  const ms = shown.map((m) => modText(m, isMac))
  return isMac ? ms.join('') + keyText(k) : [...ms, keyText(k)].join('+')
}

/** The arrow keys' move on the floor, [x, z] steps: ↑ is away from the camera (−Z). */
export function arrowStep(key: string): readonly [number, number] | null {
  switch (key) {
    case 'arrowup': return [0, -1]
    case 'arrowdown': return [0, 1]
    case 'arrowleft': return [-1, 0]
    case 'arrowright': return [1, 0]
    default: return null
  }
}
