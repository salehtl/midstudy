// Drift check for the differential tests' reference: every block lifted into ./v1/*.mjs (between `// <<v1 file:a-b`
// and `// v1>>`) must still be v1's text in planner/. Exact at its recorded lines, or (planner/ edited around it) found
// verbatim elsewhere in the file; anything else means v1 changed and ./v1/lift.py must be re-run and the diff re-checked.
// After the cutover (planner/*.js removed) there is nothing to drift from: the check says so and passes.
// Usage (repo root): nix develop -c node core/crates/wasm-web/tests/v1-sync.mjs
import fs from 'node:fs'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '../../../..')
let exact = 0, moved = 0, changed = 0, gone = 0
for (const f of ['engine.mjs', 'lighting.mjs']) {
  const src = fs.readFileSync(path.join(HERE, 'v1', f), 'utf8')
  for (const m of src.matchAll(/\/\/ <<v1 planner\/([\w.]+):(\d+)-(\d+)\n([\s\S]*?)\n\/\/ v1>>/g)) {
    const [, file, a, b, body] = m
    const p = path.join(REPO, 'planner', file)
    if (!fs.existsSync(p)) { gone++; continue }
    const text = fs.readFileSync(p, 'utf8')
    if (text.split('\n').slice(Number(a) - 1, Number(b)).join('\n') === body) exact++
    else if (text.includes(body)) { moved++; console.log(`note: planner/${file}:${a}-${b} moved (text unchanged)`) }
    else { changed++; console.log(`FAIL planner/${file}:${a}-${b} is no longer v1's text: re-run tests/v1/lift.py and the diff`) }
  }
}
console.log(`${changed ? 'FAIL' : 'PASS'} v1 sync: ${exact} blocks exact, ${moved} moved, ${changed} changed, ${gone} with planner/ gone`)
process.exit(changed ? 1 : 0)
