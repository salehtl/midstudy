// v1's own product reader as an oracle (server/test/product/v1_oracle.py imports planner/product_page.py): many JSON
// requests pipelined to one Python process, one answer per line, in order. Skips itself (null) when planner/product_page.py
// is gone (after the cutover) or the dev shell's Python 3.12 isn't there.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export const REPO = path.resolve(import.meta.dirname, '../../..')
const ORACLE = path.join(REPO, 'server/test/product/v1_oracle.py')

/** What v1 answered: a value, or the name of the exception it raised. */
export type OracleAnswer = { readonly ok: unknown } | { readonly raised: string; readonly message: string }

/** Whether v1's reader is here to compare against. */
export function oracleAvailable(): boolean {
  return fs.existsSync(path.join(REPO, 'planner/product_page.py'))
}

function answerOf(v: unknown): OracleAnswer {
  if (typeof v === 'object' && v !== null && 'ok' in v) return { ok: Reflect.get(v, 'ok') }
  const raised: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, 'raised') : undefined
  const message: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, 'message') : undefined
  return { raised: typeof raised === 'string' ? raised : 'unknown', message: typeof message === 'string' ? message : '' }
}

/** Sends every request to one oracle process and returns the answers in order. */
export async function askV1(requests: readonly Readonly<Record<string, unknown>>[]): Promise<OracleAnswer[]> {
  const child = spawn('python3', ['-I', ORACLE], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] })
  const answers: OracleAnswer[] = []
  const done = new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const v: unknown = JSON.parse(line)
      answers.push(answerOf(v))
    })
    rl.on('close', () => {
      resolve()
    })
    child.on('error', reject)
  })
  for (const r of requests) {
    if (!child.stdin.write(JSON.stringify(r) + '\n')) {
      await new Promise<void>((resolve) => child.stdin.once('drain', () => {
        resolve()
      }))
    }
  }
  child.stdin.end()
  await done
  if (answers.length !== requests.length) throw new Error(`oracle answered ${String(answers.length)} of ${String(requests.length)} requests`)
  return answers
}

/** A small deterministic PRNG (mulberry32), so a failing case can be found again from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deep equality of JSON values (numbers exactly). */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    return same(ka, kb) && ka.every((k) => same(Reflect.get(a, k), Reflect.get(b, k)))
  }
  return false
}
