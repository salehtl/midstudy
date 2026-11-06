// window.midstudy from the first moment (contract §2.4: "exposed once the module has loaded"). v1 installed the hook
// while its module ran, before the page's load event, and the evals rely on it (E12 reads `window.midstudy.ready` right
// after a reload's load event). The planner's own modules wait for the renderer and the kernels first (engine.ts's
// top-level awaits), so main.ts installs the whole hook later. main.ts imports this module first: it has no await, so
// it runs before the engine's and puts the hook's `ready` (the same Promise) and `errors` there at once.
let settle: () => void = () => undefined
/** The hook's `ready` (contract §2.4): the first page state settled (a scene opened, or the Scenes page shown). */
export const ready = new Promise<void>((resolve) => { settle = resolve })
/** Settles `ready` (main.ts, once the first page state is shown). */
export function settleReady(): void { settle() }

/** What window.midstudy holds: `ready` and `errors` from the start, the whole hook once main.ts has run. */
interface StartingHook {
  readonly ready: Promise<void>
  readonly errors: readonly string[]
}
declare global {
  interface Window {
    midstudy: StartingHook
  }
}
window.midstudy = { ready, errors: [] }
