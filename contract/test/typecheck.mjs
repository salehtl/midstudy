// Type-checks contract/gen/ under the strict flags of docs/REFACTOR.md §3, and every example in contract/examples/
// against its generated type (`<example> as const satisfies <Type>`, so an unknown key in a closed type is an error).
// Writes evals/out/contract-typecheck/ and runs tsc there: node_modules/.bin/tsc when the repo has it, else tsc on PATH
// (until the dev shell has TypeScript: NP=github:nixos/nixpkgs/<rev>; nix shell $NP#typescript -c node <this>).
//
// Usage: node contract/test/typecheck.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CONTRACT, REPO } from '../tools/schemas.mjs'

const out = path.join(REPO, 'evals/out/contract-typecheck')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const gen = path.relative(out, path.join(CONTRACT, 'gen'))
const lines = [
  `import type * as T from '${gen}/types.ts'`,
  `import { validators, violation, isSceneDetail, type Validator } from '${gen}/validate.js'`,
  `import { matchRoute, responseSchema } from '${gen}/routes.js'`,
  '',
  '// Strict mode, as the server does it: the schema of an answer, then its first violation.',
  'export function strict(method: string, path: string, status: number, body: unknown): string | null {',
  '  const m = matchRoute(method, path)',
  '  const uri = m ? responseSchema(m.route, status) : null',
  '  const v = uri ? violation(uri, body) : null',
  '  return v ? `contract violation: ${v.schema} ${v.path}` : null',
  '}',
  '',
  '// The guards narrow, and the URI map is typed.',
  'export function guarded(x: unknown): string | null {',
  '  if (isSceneDetail(x)) return x.calib?.camera.fov_y_deg.toFixed(1) ?? x.name',
  "  const v: Validator<T.LibraryItem> = validators['midstudy/library.schema.json#/$defs/item']",
  "  return v(x) ? x.dims_cm.w.toString() : violation('midstudy/api/spend.schema.json', x)?.path ?? null",
  '}',
  '',
]
let n = 0
for (const f of fs.readdirSync(path.join(CONTRACT, 'examples')).filter((x) => x.endsWith('.json')).sort()) {
  for (const e of JSON.parse(fs.readFileSync(path.join(CONTRACT, 'examples', f), 'utf8')).examples) {
    lines.push(`// ${f}: ${e.kind} ${e.status ?? ''} ${e.note ?? ''}`.trimEnd(), `export const e${n++} = ${JSON.stringify(e.body)} as const satisfies T.${e.type}`)
  }
}
fs.writeFileSync(path.join(out, 'examples.ts'), `${lines.join('\n')}\n`)
fs.writeFileSync(path.join(out, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2023', module: 'nodenext', moduleResolution: 'nodenext', noEmit: true, allowImportingTsExtensions: true,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
    noPropertyAccessFromIndexSignature: true, useUnknownInCatchVariables: true, verbatimModuleSyntax: true,
    erasableSyntaxOnly: true, skipLibCheck: false, types: [],
  },
  files: ['examples.ts', `${gen}/types.ts`, `${gen}/validate.d.ts`, `${gen}/routes.d.ts`],
}, null, 2))
const local = path.join(REPO, 'node_modules/.bin/tsc')
const tsc = fs.existsSync(local) ? local : 'tsc'
try {
  const v = execFileSync(tsc, ['--version'], { encoding: 'utf8' }).trim()
  execFileSync(tsc, ['-p', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`typecheck: contract/gen/ and ${n} examples type-check (${v}, the REFACTOR.md §3 flags)`)
} catch (e) {
  if (e.code === 'ENOENT') { console.log('typecheck: SKIP, no tsc (node_modules/.bin/tsc or PATH)'); process.exit(0) }
  console.log(`${e.stdout || ''}${e.stderr || ''}`.split('\n').slice(0, 40).join('\n'))
  console.log('typecheck: FAIL')
  process.exit(1)
}
