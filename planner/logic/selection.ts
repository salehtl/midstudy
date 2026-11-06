// The selection as a set (main a292ee2): the pieces picked, in the order picked, the primary (the label, grip and
// height controls follow it) last; and how a group turns about the middle of its positions. engine.ts keeps the state.
// Pure, for TScert.

/** uids in the order picked; primary is the last one, or null when nothing is selected. */
export interface Selection {
  readonly uids: readonly string[]
  readonly primary: string | null
}
export const NO_SELECTION: Selection = { uids: [], primary: null }

const of = (uids: readonly string[]): Selection => ({ uids, primary: uids[uids.length - 1] ?? null })

/** select(uid, { toggle, add }): plain (only that piece, or none for an unknown one); toggle (Shift+click: in or out);
 *  add (keep the others; it becomes the primary). toggle and add ignore an unknown piece. */
export function selectStep(sel: Selection, uid: string | null, known: boolean, how: 'set' | 'toggle' | 'add'): Selection {
  const ok = uid !== null && uid !== '' && known
  if (how === 'set') return ok ? { uids: [uid], primary: uid } : NO_SELECTION
  if (!ok) return sel
  const rest = sel.uids.filter((u) => u !== uid)
  if (how === 'toggle' && rest.length < sel.uids.length) return { uids: rest, primary: sel.primary === uid ? (rest[rest.length - 1] ?? null) : sel.primary }
  return { uids: [...rest, uid], primary: uid }
}

/** selectMany: exactly these (known ones, once each, in order); the primary is the last. */
export function selectMany(uids: readonly string[], known: (uid: string) => boolean): Selection {
  const out: string[] = []
  for (const u of uids) if (known(u) && !out.includes(u)) out.push(u)
  return of(out)
}

/** A piece leaves the selection (it was removed). */
export function without(sel: Selection, uid: string): Selection {
  if (!sel.uids.includes(uid)) return sel
  const rest = sel.uids.filter((u) => u !== uid)
  return { uids: rest, primary: sel.primary === uid ? (rest[rest.length - 1] ?? null) : sel.primary }
}

/** The middle of the pieces' floor positions [x, z]. */
export function centreOf(points: readonly (readonly [number, number])[]): readonly [number, number] {
  let x = 0
  let z = 0
  for (const p of points) { x += p[0] / points.length; z += p[1] / points.length }
  return [x, z]
}

/** (x, z) turned by `deg` about c, counterclockwise seen from above (as rotation_y_deg). */
export function turnAbout(c: readonly [number, number], x: number, z: number, deg: number): readonly [number, number] {
  const t = (deg * Math.PI) / 180
  const cs = Math.cos(t)
  const sn = Math.sin(t)
  const dx = x - c[0]
  const dz = z - c[1]
  return [c[0] + dx * cs + dz * sn, c[1] - dx * sn + dz * cs]
}
