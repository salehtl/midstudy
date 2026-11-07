// UI epochs: counters an async UI action captures before its await and checks after it, acting (or toasting) only when
// nothing changed underneath (docs/notes/state-machines-plan.md, the shared epoch).
//   uiEpoch(engine) → { now(), items(), on(kind, fn) → off }
//   now()    moves on every change of the shown photo: engine 'scene' loading, opened, closed or failed (a room's photo
//            switch emits 'opened' only, and counts). For photo-scoped actions: renders, Looks right, layouts save, the
//            Scene panel, Scenes open / upload.
//   items()  moves only when the pieces are cleared: 'scene' loading or closed. A room photo switch keeps the pieces
//            (engine.ts openSceneAs, contract §4.9), so it does not move. For piece-scoped actions: Undo / ⌘Z.
//   on(kind, fn)  fn() after each move of that epoch; returns the remover.
// The shell keeps one (shell.epoch); a module may make its own. planner/engine.ts is not touched: its sceneToken stays
// private.
import type { Engine } from './seam.js'

type EpochKind = 'now' | 'items'
export interface UiEpoch {
  readonly now: () => number
  readonly items: () => number
  readonly on: (kind: EpochKind, fn: () => void) => () => void
}

export function uiEpoch(engine: Pick<Engine, 'events'> | null): UiEpoch {
  const count: Record<EpochKind, number> = { now: 0, items: 0 }
  const fns: Record<EpochKind, Set<() => void>> = { now: new Set(), items: new Set() }
  const bump = (k: EpochKind): void => {
    count[k]++
    for (const f of [...fns[k]]) f()
  }
  engine?.events.addEventListener('scene', (e) => {
    const p = e.detail.phase
    if (p === 'loading' || p === 'opened' || p === 'closed' || p === 'failed') bump('now')
    if (p === 'loading' || p === 'closed') bump('items')
  })
  return {
    now: () => count.now,
    items: () => count.items,
    on: (kind, fn) => {
      fns[kind].add(fn)
      return () => { fns[kind].delete(fn) }
    },
  }
}
