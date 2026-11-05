#!/usr/bin/env node
// ui/bus.ts against an EventTarget: the shell's events used to be one (v1), so Bus must dispatch as it did. Each case runs
// the same listeners on both and compares what happened. Run: nix develop -c node planner/ui/test/bus.mjs
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bus-'))
await build({ entryPoints: [path.join(ROOT, 'planner/ui/bus.ts')], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'bus.mjs'), logLevel: 'error' })
const { Bus } = await import(path.join(dir, 'bus.mjs'))
fs.rmSync(dir, { recursive: true, force: true })

// An EventTarget reports a listener's exception (process 'uncaughtException' in Node, window 'error' in a page) and goes
// on; Bus calls reportError, as a page does. Both are captured here.
let reported = []
globalThis.reportError = (e) => { reported.push(String(e?.message ?? e)) }
process.on('uncaughtException', (e) => { reported.push(String(e?.message ?? e)) })

// The v1 way: an EventTarget, dispatchEvent(new CustomEvent(type, { detail, cancelable })).
function targetBus() {
  const t = new EventTarget()
  return {
    on: (type, fn) => t.addEventListener(type, fn),
    off: (type, fn) => t.removeEventListener(type, fn),
    emit: (type, detail, cancelable = false) => t.dispatchEvent(new CustomEvent(type, { detail, cancelable })),
  }
}
function busBus() {
  const b = new Bus()
  return { on: (type, fn) => b.addEventListener(type, fn), off: (type, fn) => b.removeEventListener(type, fn), emit: (type, detail, cancelable = false) => b.emit(type, detail, cancelable) }
}

const cases = {
  'order, details, a listener added twice called once'(bus, log) {
    const a = (e) => log.push(`a:${e.detail.n}`)
    bus.on('x', a); bus.on('x', (e) => log.push(`b:${e.detail.n}`)); bus.on('x', a); bus.on('y', () => log.push('y'))
    log.push(String(bus.emit('x', { n: 1 })))
    bus.off('x', a)
    log.push(String(bus.emit('x', { n: 2 })))
  },
  'cancelable: preventDefault makes emit false; not cancelable stays true'(bus, log) {
    bus.on('r', (e) => { e.preventDefault(); log.push(`seen:${e.defaultPrevented}`) })
    bus.on('r', (e) => log.push(`later:${e.defaultPrevented}`))
    log.push(String(bus.emit('r', {}, true)))
    log.push(String(bus.emit('r', {}, false)))
  },
  'a listener removed during dispatch is not called; one added is not called this time'(bus, log) {
    const c = () => log.push('c')
    const d = () => log.push('d')
    bus.on('z', () => { log.push('first'); bus.off('z', c); bus.on('z', d) })
    bus.on('z', c)
    bus.emit('z', {})
    bus.emit('z', {})
  },
  'a listener that removes itself (the sheet on mode)'(bus, log) {
    const once = () => { log.push('once'); bus.off('m', once) }
    bus.on('m', once); bus.on('m', () => log.push('other'))
    bus.emit('m', {}); bus.emit('m', {})
  },
  'a throwing listener is reported and the others run'(bus, log) {
    bus.on('t', () => log.push('before'))
    bus.on('t', () => { throw new Error('boom') })
    bus.on('t', () => log.push('after'))
    log.push(String(bus.emit('t', {})))
  },
}

let failed = 0
for (const [name, run] of Object.entries(cases)) {
  const runOn = async (make) => {
    const log = []
    reported = []
    run(make(), log)
    await new Promise((r) => setTimeout(r, 10)) // let an EventTarget's report land
    return JSON.stringify({ log, reported })
  }
  const want = await runOn(targetBus)
  const got = await runOn(busBus)
  const ok = want === got
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  EventTarget ${want}\n  Bus         ${got}`}`)
}
console.log(`bus: ${failed ? `FAIL, ${failed} case(s) differ` : `ok — ${Object.keys(cases).length} cases dispatch as an EventTarget does`}`)
process.exit(failed ? 1 : 0)
