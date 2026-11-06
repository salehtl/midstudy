// Strict mode (contract §0; MIDSTUDY_STRICT=1, which the eval harness sets for the v2 server): every JSON answer is
// checked against the schema contract/api/routes.json names for its route and status, and every JSON file the server
// writes against its own schema, with the validators generated in contract/gen/. A violation is never sent or
// written: the answer becomes `500 {"error": "contract violation: <schema> <path>"}` and stderr gets one line.
// Without strict mode nothing is loaded or checked.
import { flagOn } from '../../common/logic/env.ts'
import { atomicWrite, jsonText, type JsonStyle } from '../../common/files.ts'
import type { SchemaUri } from '../../contract/gen/validate.js'

/** A value that breaks its schema (strict mode). */
export class ContractViolation extends Error {
  readonly schema: string
  readonly pointer: string
  readonly detail: string
  constructor(schema: string, pointer: string, detail: string) {
    super('contract violation: ' + schema + ' ' + pointer)
    this.name = 'ContractViolation'
    this.schema = schema
    this.pointer = pointer
    this.detail = detail
  }
}

type ValidateModule = typeof import('../../contract/gen/validate.js')
type RoutesModule = typeof import('../../contract/gen/routes.js')

interface Contract {
  readonly validate: ValidateModule
  readonly routes: RoutesModule
}

let contract: Contract | null = null

/** MIDSTUDY_STRICT is on (any value but empty or `0`). */
export function strictRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env['MIDSTUDY_STRICT'])
}

/** Loads the generated validators and routes (once): strict mode is on from then. */
export async function enableStrict(): Promise<void> {
  if (contract !== null) return
  const validate = await import('../../contract/gen/validate.js')
  const routes = await import('../../contract/gen/routes.js')
  contract = { validate, routes }
}

/** @public Whether answers and files are being checked. */
export function strictOn(): boolean {
  return contract !== null
}

function report(v: ContractViolation, where: string): void {
  process.stderr.write('midstudy server: ' + v.message + ' (' + v.detail + ') ' + where + '\n')
}

/** The violation of `data` against the schema at `uri`, or null (also when strict mode is off). */
function violationOf(uri: SchemaUri, data: unknown): ContractViolation | null {
  if (contract === null) return null
  const v = contract.validate.violation(uri, data)
  return v === null ? null : new ContractViolation(v.schema, v.path === '' ? '/' : v.path, v.message)
}

/** Checks an /api answer (strict mode): the schema routes.json names for this route and status, the error schema
 *  for an error status of a path no route matches, and a violation for a success status no route allows. A HEAD
 *  request is checked as its GET. Null when it conforms or strict mode is off. */
export function answerViolation(method: string, target: string, status: number, body: unknown): ContractViolation | null {
  if (contract === null) return null
  const { routes } = contract
  const m = routes.matchRoute(method === 'HEAD' ? 'GET' : method, target)
  let uri: SchemaUri | null
  if (m === null) {
    uri = status >= 400 ? routes.routes.errors : null
    if (uri === null) {
      const v = new ContractViolation('midstudy/api/routes.json', '/', 'no route answers ' + method + ' ' + target + ' with ' + String(status))
      report(v, method + ' ' + target)
      return v
    }
  } else {
    uri = routes.responseSchema(m.route, status)
    if (uri === null) {
      const v = new ContractViolation('midstudy/api/routes.json', '/', m.route.method + ' ' + m.route.path + ' has no ' + String(status) + ' answer')
      report(v, method + ' ' + target)
      return v
    }
  }
  const v = violationOf(uri, body)
  if (v !== null) report(v, method + ' ' + target + ' ' + String(status))
  return v
}

/** The violation of `data` against the schema at `uri` (strict mode), with a stderr line naming `what`; null when it
 *  conforms or strict mode is off. For what the server reads from its tools (midstudy-calib's results). */
export function conformance(uri: SchemaUri, data: unknown, what: string): ContractViolation | null {
  const v = violationOf(uri, data)
  if (v !== null) report(v, what)
  return v
}

/** Whether `data` passes the schema at `uri` (always true when strict mode is off), without reporting it: for files the
 *  server only reads and serves as they are (a room's align.json, written by midstudy-calib). */
export function conforms(uri: SchemaUri, data: unknown): boolean {
  return violationOf(uri, data) === null
}

/** @public Throws ContractViolation when `data` breaks the schema at `uri` (strict mode), with a stderr line naming `what`. */
export function assertConforms(uri: SchemaUri, data: unknown, what: string): void {
  const v = conformance(uri, data, what)
  if (v !== null) throw v
}

/** Writes a JSON file the server owns, in v1's layout, atomically; in strict mode only after it passes its schema
 *  (scene.json `midstudy/scene.schema.json`, layouts `midstudy/layout.schema.json`, library.json
 *  `midstudy/library.schema.json`, renders/<name>.json `midstudy/api/render-meta.schema.json`, trash.json
 *  `midstudy/trash.schema.json#/$defs/scene`, entry.json `midstudy/trash.schema.json#/$defs/item`). */
export async function writeJsonFile(file: string, data: unknown, schema: SchemaUri, style: JsonStyle = 'ascii'): Promise<void> {
  assertConforms(schema, data, 'writing ' + file)
  await atomicWrite(file, jsonText(data, style))
}
