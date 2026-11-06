// Runs v1's own Python (server/test/library/v1_library_oracle.py, which imports planner/serve.py) on a list of cases.
// The tests skip themselves once planner/serve.py is gone (after the cutover) or when python3 isn't the dev shell's.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from '../helpers.ts'

export const V1 = path.join(REPO, 'planner/serve.py')
const ORACLE = path.join(REPO, 'server/test/library/v1_library_oracle.py')

/** Why the differential tests can't run here, or false. */
export const skipV1: string | false = fs.existsSync(V1) ? false : 'planner/serve.py is gone'

/** One case for the oracle. */
export interface OracleCase {
  readonly fn: string
  readonly args: readonly unknown[]
}

/** v1's answer to a case: `{ok: value}` or `{error: "<Class>: <message>"}`. */
export type OracleAnswer = { readonly ok: unknown } | { readonly error: string }

function isAnswer(v: unknown): v is OracleAnswer {
  return typeof v === 'object' && v !== null && ('ok' in v || ('error' in v && typeof v.error === 'string'))
}

/** v1's answers, in order. */
export function oracle(cases: readonly OracleCase[]): OracleAnswer[] {
  const r = spawnSync('python3', ['-I', ORACLE], { cwd: REPO, input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 256 << 20 })
  if (r.status !== 0) throw new Error('the v1 oracle failed: ' + r.stderr)
  const out: unknown = JSON.parse(r.stdout)
  if (!Array.isArray(out) || out.length !== cases.length) throw new Error('the v1 oracle answered ' + r.stdout.slice(0, 300))
  const answers: OracleAnswer[] = []
  for (const a of out) {
    if (!isAnswer(a)) throw new Error('the v1 oracle answered ' + JSON.stringify(a))
    answers.push(a)
  }
  return answers
}
