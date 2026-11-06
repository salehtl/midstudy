// Scenes (contract §4.4, §4.5): where the planner lands on load (?scene=, else the scene last opened on this device,
// else the Scenes page), when a scene is still calibrating, and what its calibration finishing means for the list.
// v1's startScene choice (engine.js) and busy / the ready-failed transitions (data.js). Pure, for TScert.

/** Where the first page state goes (§4.5). */
export type Landing =
  | { readonly kind: 'open'; readonly name: string }
  | { readonly kind: 'missing'; readonly name: string }
  | { readonly kind: 'none' }

/** v1's startScene: `want` is ?scene=, `last` this device's last scene, `names` the scenes the server lists (null when
 * the list couldn't be read). */
export function landing(want: string | null, last: string | null, names: readonly string[] | null): Landing {
  const has = (n: string | null): boolean => n !== null && n !== '' && (names?.includes(n) ?? false)
  if (want) return has(want) ? { kind: 'open', name: want } : { kind: 'missing', name: want }
  if (last !== null && has(last)) return { kind: 'open', name: last }
  return { kind: 'none' }
}

/** A scene whose calibration is queued or running. */
export function sceneBusy(status: unknown): boolean {
  return status === 'pending' || status === 'running'
}

/** v1's waitForScene: done or failed ends the wait. */
export function calibFinished(status: unknown): boolean {
  return status === 'done' || status === 'failed'
}

/** A scene that was calibrating and isn't now: 'ready' when it is done, else 'failed'; null otherwise. */
export function sceneFinished(was: unknown, now: unknown): 'ready' | 'failed' | null {
  if (!sceneBusy(was) || sceneBusy(now)) return null
  return now === 'done' ? 'ready' : 'failed'
}

/** The lighting backfill's poll interval: quick for the first four tries, then 1.5 s (v1's inferLighting). */
export function lightPollMs(i: number): number {
  return i < 4 ? 600 : 1500
}
