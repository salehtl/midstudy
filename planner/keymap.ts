// midstudy planner keymap: one registry for every keyboard shortcut (main a292ee2). Modules register commands; the
// Shortcuts sheet (ui/shortcuts.ts) lists them, so a shortcut that works is a shortcut that is shown, and the other way
// round. Combos and how they read: logic/keymap.ts.
//
// createKeymap({ groups }) → Keymap      groups: the sheet's group order (others follow, in first-registered order)
//   register(cmd) → unregister()      a second register with the same id replaces the first. cmd:
//     id, group, label                 'item.rotate', 'Move and turn', 'Turn 15°'
//     keys                             combos; the first is the one the sheet and tooltips show (display overrides)
//     run(e, combo)                    the action; return false to let the next command with that key try
//     when()                           false: skipped (as if not registered)
//     priority (0)                     higher runs first among commands sharing a key (Esc: leave the ruler 20, then
//                                      Adjust floor 10, then deselect 0)
//     repeat (true)                    false: ignore auto-repeat (held keys)
//     inInputs (false)                 true: also while typing in an input, textarea, select or contenteditable
//     hidden (false)                   true: works, but is left out of the sheet
//   describe({ id, group, label, keys }) a gesture the sheet lists but the keymap doesn't run ('shift+click', 'drag')
//   handle(keydownEvent) → true when a command ran (it has had preventDefault)
//   list() → [{ group, items: [{ id, label, keys: [display strings] }] }]
//   format(combo) → '⌘⇧Z' / 'Ctrl+Shift+Z'      lookup(id) → the first combo's display string, or ''
//   events: 'change' when the registry changes (the sheet re-renders)
import { comboOf as comboOfLike, formatCombo, parseCombo } from './logic/keymap.js'
import { isTypingTarget } from './logic/input.js'

// eslint-disable-next-line @typescript-eslint/no-deprecated -- v1 reads navigator.platform first to tell a Mac (⌘, not Ctrl)
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

interface KeyCommand {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly keys: readonly string[]
  readonly display?: readonly string[]
  readonly run: (e: KeyboardEvent, combo: string) => unknown
  readonly when?: () => boolean
  readonly priority?: number
  readonly repeat?: boolean
  readonly inInputs?: boolean
  readonly hidden?: boolean
}
interface Gesture {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly keys: readonly string[]
}
interface KeyGroup {
  readonly group: string
  readonly items: readonly { readonly id: string; readonly label: string; readonly keys: readonly string[] }[]
}

interface Entry {
  readonly cmd: KeyCommand
  readonly combos: readonly string[]
  readonly seq: number
}

export function createKeymap({ groups: order = [] }: { groups?: readonly string[] } = {}): Keymap {
  const cmds = new Map<string, Entry>()
  const gestures = new Map<string, { readonly g: Gesture; readonly seq: number }>()
  const groups: string[] = [] // first-registered order
  const events = new EventTarget()
  let seq = 0
  let changeQueued = false
  const changed = (): void => {
    if (changeQueued) return
    changeQueued = true
    queueMicrotask(() => { changeQueued = false; events.dispatchEvent(new CustomEvent('change')) })
  }
  const noteGroup = (g: string): void => { if (!groups.includes(g)) groups.push(g) }
  const format = (combo: string): string => formatCombo(combo, IS_MAC)
  const comboOf = (e: KeyboardEvent): string => comboOfLike(e, IS_MAC)

  function register(cmd: KeyCommand): () => void {
    if (!cmd.id || !cmd.keys.length) throw new Error('keymap.register needs { id, keys: [..], run }')
    const entry: Entry = { cmd, combos: cmd.keys.map((k) => parseCombo(k).id), seq: ++seq }
    cmds.set(cmd.id, entry)
    noteGroup(cmd.group)
    changed()
    return () => { if (cmds.get(cmd.id) === entry) { cmds.delete(cmd.id); changed() } }
  }
  function describe(g: Gesture): void {
    gestures.set(g.id, { g, seq: ++seq })
    noteGroup(g.group)
    changed()
  }

  function handle(e: KeyboardEvent): boolean {
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return false
    const combo = comboOf(e)
    const t = e.target
    const typing = t instanceof HTMLElement && isTypingTarget(t.tagName, t.isContentEditable)
    const hits = [...cmds.values()]
      .filter((c) => c.combos.includes(combo) && (!typing || c.cmd.inInputs === true) && (c.cmd.repeat !== false || !e.repeat))
      .sort((a, b) => (b.cmd.priority ?? 0) - (a.cmd.priority ?? 0) || a.seq - b.seq)
    for (const c of hits) {
      if (c.cmd.when && !c.cmd.when()) continue
      let res: unknown
      try { res = c.cmd.run(e, combo) } catch (err) { console.error(`shortcut ${c.cmd.id} failed`, err); res = undefined }
      if (res === false) continue
      e.preventDefault()
      return true
    }
    return false
  }

  function list(): KeyGroup[] {
    const all = [
      ...[...cmds.values()].filter((c) => c.cmd.hidden !== true).map((c) => ({ id: c.cmd.id, group: c.cmd.group, label: c.cmd.label, keys: c.cmd.display ?? c.cmd.keys, seq: c.seq })),
      ...[...gestures.values()].map(({ g, seq: s }) => ({ id: g.id, group: g.group, label: g.label, keys: g.keys, seq: s })),
    ].sort((a, b) => a.seq - b.seq)
    const rank = (g: string): number => { const i = order.indexOf(g); return i < 0 ? order.length + groups.indexOf(g) : i }
    return [...groups].sort((a, b) => rank(a) - rank(b))
      .map((group) => ({ group, items: all.filter((c) => c.group === group).map((c) => ({ id: c.id, label: c.label, keys: c.keys.map(format) })) }))
      .filter((g) => g.items.length > 0)
  }
  function lookup(id: string): string {
    const c = cmds.get(id)
    const first = c ? (c.cmd.display ?? c.cmd.keys)[0] : gestures.get(id)?.g.keys[0]
    return first === undefined ? '' : format(first)
  }

  return { register, describe, handle, list, format, lookup, comboOf, events, isMac: IS_MAC }
}

export interface Keymap {
  readonly register: (cmd: KeyCommand) => () => void
  readonly describe: (g: Gesture) => void
  readonly handle: (e: KeyboardEvent) => boolean
  readonly list: () => KeyGroup[]
  readonly format: (combo: string) => string
  readonly lookup: (id: string) => string
  readonly comboOf: (e: KeyboardEvent) => string
  readonly events: EventTarget
  readonly isMac: boolean
}
