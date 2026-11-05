// Loads the contract's JSON Schemas (contract/*.schema.json for files, contract/api/*.schema.json for HTTP payloads)
// and contract/api/routes.json, and answers which schema a request or response must match. Used by
// scripts/gen-contract.mjs, the contract tests and the recordings check; plain Node, no build.
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'

export const CONTRACT = path.resolve(import.meta.dirname, '..')
export const REPO = path.resolve(CONTRACT, '..')

// RFC 3339 date-time, as every midstudy writer emits it (ISO-8601 UTC, seconds or milliseconds, Z or an offset).
// The same rule is compiled into contract/gen/validate.js.
export const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/

// Every schema, sorted by $id: files first, then api/ (a stable order for codegen).
export function loadSchemas() {
  const read = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.schema.json')).sort()
    .map((f) => ({ file: path.relative(CONTRACT, path.join(dir, f)), schema: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
  const all = [...read(CONTRACT), ...read(path.join(CONTRACT, 'api'))]
  for (const { file, schema } of all) {
    const want = `midstudy/${file}`
    if (schema.$id !== want) throw new Error(`${file}: $id is ${schema.$id}, expected ${want}`)
  }
  return all
}

export const loadRoutes = () => JSON.parse(fs.readFileSync(path.join(CONTRACT, 'api/routes.json'), 'utf8'))

// An Ajv (draft 2020-12, strict, all errors) holding every schema, with the date-time format.
export function makeAjv(opts = {}) {
  // strictRequired off: `not: {required: [...]}` (a key that must be absent) names keys the schema doesn't define.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, ...opts })
  ajv.addFormat('date-time', DATE_TIME)
  for (const { schema } of loadSchemas()) ajv.addSchema(schema)
  return ajv
}

// The route of a request: {route, params} or null. `p` may carry a query string. contract/gen/routes.js has the same
// rules, generated for the server (the contract test checks they agree).
export function matchRoute(routes, method, p) {
  let pathname
  try { pathname = decodeURIComponent(String(p).split('?')[0].split('#')[0]) } catch { return null }
  const segs = pathname.split('/')
  for (const route of routes.routes) {
    if (route.method !== method) continue
    const tpl = route.path.split('/')
    if (tpl.length !== segs.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < tpl.length && ok; i++) {
      const m = /^\{(\w+)\}$/.exec(tpl[i])
      if (m) { if (segs[i] === '') ok = false; else params[m[1]] = segs[i] } else ok = tpl[i] === segs[i]
    }
    if (ok) return { route, params }
  }
  return null
}

// The schema URI a response with `status` must match, or null when the route doesn't allow that status.
export function responseSchema(routes, route, status) {
  const r = route.responses
  const s = String(status)
  if (r[s]) return r[s]
  if (r[`${s[0]}xx`]) return r[`${s[0]}xx`]
  return status >= 400 ? routes.errors : null
}

// One line per Ajv error.
export const errorText = (errors) => (errors || []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ')
