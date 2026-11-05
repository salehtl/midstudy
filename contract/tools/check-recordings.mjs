// Checks what the evals recorded with MIDSTUDY_RECORD_API=<dir> (evals/lib/harness.mjs, evals/library_api.sh: one
// JSON line per /api call) against contract/api/routes.json: every answer against the schema of its route and status,
// and every accepted (2xx) JSON request and X-Midstudy-Meta header against the route's request schemas.
//
// Usage: node contract/tools/check-recordings.mjs <dir|file.jsonl>... [--verbose]
// Prints a summary per eval and per schema, then each problem; exits 1 when there is one.
import fs from 'node:fs'
import path from 'node:path'
import { errorText, loadRoutes, makeAjv, matchRoute, responseSchema } from './schemas.mjs'

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const inputs = args.filter((a) => !a.startsWith('--'))
if (!inputs.length) { console.error('usage: node contract/tools/check-recordings.mjs <dir|file.jsonl>...'); process.exit(2) }
const files = inputs.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(p, f)) : [p])).sort()

const ajv = makeAjv()
const routes = loadRoutes()
const problems = []
const perSchema = new Map()
const perEval = new Map()
let calls = 0, checked = 0, skipped = 0
const count = (m, k) => m.set(k, (m.get(k) || 0) + 1)
const validate = (uri, data, what, rec) => {
  const v = ajv.getSchema(uri)
  if (!v) { problems.push(`${what}: ${uri} is not a schema`); return }
  checked++
  count(perSchema, uri)
  if (!v(data)) problems.push(`${rec.eval}: ${rec.method} ${rec.path} → ${rec.status}: ${what} doesn't match ${uri}: ${errorText(v.errors)}\n    ${JSON.stringify(data).slice(0, 300)}`)
}

for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line)
    calls++
    count(perEval, rec.eval)
    if (!rec.status) { skipped++; continue } // no answer (a refused connection, a timeout the eval wanted)
    if (rec.method === 'HEAD') { skipped++; continue }
    const m = matchRoute(routes, rec.method, rec.path)
    if (!m) {
      // an endpoint the contract doesn't have: it must answer an error
      if (rec.status >= 400 && rec.response.body !== null) validate(routes.errors, rec.response.body, 'the answer', rec)
      else problems.push(`${rec.eval}: ${rec.method} ${rec.path} → ${rec.status}: no such route in routes.json, yet not an error`)
      continue
    }
    const schema = responseSchema(routes, m.route, rec.status)
    if (!schema) problems.push(`${rec.eval}: ${rec.method} ${rec.path} → ${rec.status}: the contract has no ${rec.status} for ${m.route.method} ${m.route.path}`)
    else if (rec.response.body === null) problems.push(`${rec.eval}: ${rec.method} ${rec.path} → ${rec.status}: not JSON (${rec.response.contentType}): ${rec.response.text ?? ''}`)
    else validate(schema, rec.response.body, 'the answer', rec)
    if (rec.status >= 200 && rec.status < 300) {
      const body = m.route.request?.body
      const sent = rec.request?.body
      const rawUpload = sent && typeof sent === 'object' && !Array.isArray(sent) && Object.keys(sent).length === 1 && 'bytes' in sent
      if (body && body !== 'raw' && sent !== undefined && !rawUpload) validate(body, sent, 'the request', rec)
      const meta = m.route.request?.headers?.['X-Midstudy-Meta']
      if (meta && rec.request?.meta !== undefined) validate(meta, rec.request.meta, 'X-Midstudy-Meta', rec)
    }
  }
}

console.log(`check-recordings: ${calls} /api calls in ${files.length} file(s); ${checked} bodies checked, ${skipped} without an answer or body skipped`)
for (const [e, n] of [...perEval].sort()) console.log(`  ${e.padEnd(20)} ${n} calls`)
if (verbose) for (const [s, n] of [...perSchema].sort()) console.log(`  ${String(n).padStart(5)}  ${s}`)
const unused = routes.routes.flatMap((r) => Object.values(r.responses)).filter((u) => !perSchema.has(u))
if (unused.length) console.log(`  answers never seen: ${[...new Set(unused)].join(', ')}`)
for (const p of problems.slice(0, 50)) console.log(`PROBLEM ${p}`)
console.log(problems.length ? `check-recordings: ${problems.length} problem(s)` : 'check-recordings: every recorded body matches its schema')
process.exit(problems.length ? 1 : 0)
