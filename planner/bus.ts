// Typed events for the planner: the engine's (engine.events, EngineEvents), the data stores' (scenes.events,
// lib.events: data.ts) and the shell's (shell.events). Events<M> is how a listener sees them: addEventListener and
// removeEventListener by name, the listener getting a CustomEvent with that event's detail. Bus<M> is the emitter
// behind each: listeners per type in registration order, each called once even if added twice, one removed during a
// dispatch not called; a listener that throws is reported (window.reportError, as an EventTarget does) and the others
// still run. emit() returns false when a cancelable event was cancelled, as dispatchEvent does (ui/test/bus.mjs checks
// it against an EventTarget: v1's engine, stores and shell each sent CustomEvents from one).

export type Listener<D> = (e: CustomEvent<D>) => void

export interface Events<M> {
  addEventListener<K extends keyof M & string>(type: K, listener: Listener<M[K]>): void
  removeEventListener<K extends keyof M & string>(type: K, listener: Listener<M[K]>): void
}

type Registry<M> = { [K in keyof M]?: Set<Listener<M[K]>> }

export class Bus<M> implements Events<M> {
  #listeners: Registry<M> = {}

  addEventListener<K extends keyof M & string>(type: K, listener: Listener<M[K]>): void {
    const set = this.#listeners[type]
    if (set) set.add(listener)
    else this.#listeners[type] = new Set([listener])
  }

  removeEventListener<K extends keyof M & string>(type: K, listener: Listener<M[K]>): void {
    this.#listeners[type]?.delete(listener)
  }

  emit<K extends keyof M & string>(type: K, detail: M[K], cancelable = false): boolean {
    const e = new CustomEvent(type, { detail, cancelable })
    const set = this.#listeners[type]
    if (set) {
      for (const fn of [...set]) {
        if (!set.has(fn)) continue
        try { fn(e) } catch (err) { reportError(err) }
      }
    }
    return !e.defaultPrevented
  }
}
