// An OBJ zip's checks against v1 itself: v1's oracle writes a corpus of zips (zipfile output and byte surgery: the
// §2.8 rules, unreadable and truncated zips, end records with comments, prepended data, zip64 end records and extra
// fields, Info-ZIP Unicode Path fields, versions zipfile refuses), and for each one v1's `zip_problem` (planner/serve.py,
// Python 3.12's zipfile) and the TypeScript zipProblem (its central-directory reader and the media kernel's policy)
// must say the same: null, the same sentence, or the same exception v1 didn't catch.
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { zipProblem } from '../../src/library/zip.ts'
import { SCRATCH } from '../helpers.ts'
import { oracle, skipV1, type OracleAnswer } from './oracle.ts'

const DIR = path.join(SCRATCH, 'library-zips-' + String(process.pid))

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
})

async function mine(file: string): Promise<OracleAnswer> {
  try {
    return { ok: await zipProblem(file) }
  } catch (e) {
    return { error: e instanceof Error ? e.name + ': ' + e.message : String(e) }
  }
}

void test('zipProblem equals v1 zip_problem on every zip of the corpus', { skip: skipV1 }, async () => {
  const [made] = oracle([{ fn: 'make_zips', args: [DIR] }])
  assert.ok(made !== undefined && 'ok' in made && Array.isArray(made.ok), JSON.stringify(made))
  const names = made.ok.filter((n: unknown): n is string => typeof n === 'string')
  assert.ok(names.length >= 50, String(names.length))
  const v1 = oracle(names.map((n) => ({ fn: 'zip_problem', args: [path.join(DIR, n + '.zip')] })))
  const diffs: string[] = []
  const seen = new Set<string>()
  for (const [i, name] of names.entries()) {
    const ours = await mine(path.join(DIR, name + '.zip'))
    const theirs = v1[i]
    seen.add(JSON.stringify(theirs))
    try {
      assert.deepEqual(ours, theirs)
    } catch {
      diffs.push(name + '\n  v1: ' + JSON.stringify(theirs) + '\n  v2: ' + JSON.stringify(ours))
    }
  }
  assert.equal(diffs.length, 0, String(diffs.length) + ' of ' + String(names.length) + ' differ:\n' + diffs.join('\n'))
  // The corpus reaches every kind of answer: accepted, each rule, unreadable, and the uncaught version error.
  const all = [...seen].join('\n')
  for (const want of ['{"ok":null}', 'absolute path', 'climbs out', 'a link', 'only .obj', 'exactly one .obj', 'unpacks to', 'entries, at most',
    'File is not a zip file', 'Bad magic number', 'Truncated central directory', 'Bad offset', 'Corrupt extra field', 'Corrupt zip64 extra field',
    'Corrupt unicode path', 'span multiple disks', 'Corrupt zip64 end of central directory', 'NotImplementedError']) {
    assert.ok(all.includes(want), 'the corpus has no answer with ' + want)
  }
})
