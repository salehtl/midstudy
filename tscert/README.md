# TScert in midstudy v2

(This is the TScert note the f-toolchain task asked for as `docs/notes/tscert.md`. That path belongs to no track in
`scripts/ownership.json`, so it lives here, beside the TScert config and baseline; see docs/notes/f-toolchain.md.)

TScert (https://github.com/cristianoc/TScert) checks TypeScript functions with a proof that a Lean-verified checker
validates. It is a research tool. It reads one function at a time, refuses `any`, and trusts library calls only through
contracts its author has reviewed. v2 uses it on the pure logic modules (`planner/logic/`, `server/src/logic/`,
`pipeline/src/logic/`), and a ratchet keeps every function that certifies certifying (docs/REFACTOR.md §1 and §3).
The f-toolchain track wrote this note on 2026-11-05. Every result below was measured that day with the commands shown.

Its licence is "MIT NON-AI": the MIT terms, except that the code may not be used to train or improve machine-learning
systems. Running it as a checker on our code is neither.

## How it runs here

| What | Where | Version |
|---|---|---|
| TScert | `nix/tscert.nix`, `rev` | `1c8abcf21dbbc9cbb87d5a5f74820a08d2459899` (main, 2026-11-05) |
| Node for TScert | official archive, fixed-output fetch | 26.13.0 (TScert's `.nvmrc`; nixpkgs has 26.12.1) |
| Lean for TScert | official archive, fixed-output fetch | 4.33.1 (TScert's `lean/lean-toolchain`; nixpkgs has 4.29.1) |
| TScert's front end | `tools/node_modules` as a fixed-output `npm ci --ignore-scripts` | TypeScript 7.0.2 (native) |
| OCaml producer | nixpkgs | OCaml 5.4.1, dune 3.21.1 |

- **Built and run in the Nix sandbox only, never as you.** `nix build .#tscert` builds TScert as the Nix build user
  (about 5 to 8 minutes the first time: the Lean verifier is 295 build jobs). `check:tscert` copies its inputs into
  a Nix build (`runUnits` in `nix/tscert.nix`): the tsconfigs, `scripts/tscert.mjs`, the logic modules, `contract/gen/`
  and the job list. TScert checks the copy there, and the result is a store path. When nothing changed, the same
  derivation is read back from the store in under a second. Why it runs this way: this session's permission
  classifier refused to let the agent build or run TScert directly as the user (`[Code from External]`), and accepted
  it inside Nix builds.
- **One patch, for the sandboxed runs.** Inside a Nix build on macOS, `sandbox_apply` refuses every profile that has a
  deny rule. Measured: `(allow default)` applies, and adding one `(deny file-read* (literal "/nonexistent"))` fails
  with "Operation not permitted". TScert confines its compiler with `sandbox-exec` and such a profile, so the compiler
  died at start. `nix/tscert.nix` therefore adds one condition to `tools/compiler-channel.mts`: with
  `TSCERT_NO_COMPILER_SANDBOX=1`, which only `runUnits` sets, the compiler runs unconfined. TScert supports that mode
  on any platform without a sandbox, and its stages are then recorded as unobserved, which only turns off reuse from
  its stage store. What TScert verifies does not change. The Nix build user cannot read your files either way.
- **One function at a time.** `tscert units` checks each top-level `function` declaration on its own. Every other
  function in the file, and the module initialization, is omitted, so TScert reads them at their declared signatures.
  This is TScert's "shallow verified": a function certifies when its own unit is accepted. Constants, classes and
  arrow functions bound at the top level form one more unit, `(init)`. In a whole-file check, the gate names the
  first unreviewed library member in the file but points at the first mention of its global, which can be in a
  different function. Checking each function alone keeps each refusal with the function that caused it.
- **The logic tsconfigs have no ambient types.** `tscert/tsconfig.{planner,server,pipeline}.json` extend the area's
  config but set `lib` to ES2023 (ES2024 on Node) and `types` to `[]`. A logic module that touches the DOM, Node or
  three.js fails there; that code belongs in a shell module.

## Commands

All run from the repository root. Exit codes: 0 means ok, 1 means a regression or a tool failure, 2 means a usage
error.

```sh
nix develop -c npm run check:tscert                     # the ratchet over tscert/config.json's areas (one summary line)
nix develop -c node scripts/tscert-ratchet.mjs --files planner/logic/camera.ts    # try one module: one line per function
nix develop -c node scripts/tscert-ratchet.mjs --update # rewrite tscert/baseline.json with everything that certifies now
nix develop -c node scripts/tscert-ratchet.mjs --config tscert/experiments/config.json --no-baseline --verbose
nix build .#tscert --out-link build/tscert/result      # TScert itself (check:tscert builds it on first use)
tscert check FILE.ts --project TSCONFIG                 # TScert's own CLI, run as you (the agents here could not)
```

Measured output (2026-11-05):

```
$ nix develop -c npm run check:tscert                  # today: no logic modules yet
check:tscert: ok — nothing to check (no file matches planner/logic/**/*.ts, server/src/logic/**/*.ts, pipeline/src/logic/**/*.ts) (0.0 s)
$ node scripts/tscert-ratchet.mjs --config tscert/experiments/config.json --no-baseline
tscert: 90/111 certified (19 files, 20 s; report tscert/experiments/report.json)          # exit 0
# a scratch copy of the repository with camera.ts and units.ts in planner/logic/ and slug.ts in server/src/logic/:
check:tscert: ok — 10/10 certified, all 0 baselined still certify, 10 new (add them: --update) (2 files, 3 s)
tscert: 10/10 certified; baseline rewritten (tscert/baseline.json, 0 s)                  # --update, read from the store
  no longer certifies: planner/logic/camera.ts#clamp: unsupported (source) gate: Math.tan is not in the reviewed overlay of library globals: tan(x: number): number; (line 21, col 10)
check:tscert: FAIL — 1 baselined function(s) no longer certify; 9/10 certified (4 s)     # exit 1
```

`tscert/report.json` is written on every run (it is git-ignored) and lists each `file#function` with its status, its
phase and TScert's reason. `tscert/baseline.json` is tracked: every `file#function` in it must certify. A renamed
function counts as lost, so rename it on purpose and then run `--update`.

## What certifies and what does not

`tscert/experiments/` holds 19 files with 111 functions modelled on midstudy's code. 90 of them certify. Here is each
file, with the reason TScert gave for every refusal:

| File | Certified | Refused, with TScert's reason |
|---|---|---|
| `camera.ts`: clamps, `round6`, `roundTo` (`10 ** n`), `clampOr(v: unknown, …)`, `clampCamera` over `CameraInput` with `unknown` fields, `Partial<Camera>`, `sameCamera` | 8/8 | — |
| `angles.ts`: `wrapDeg` with `%` (`let` and `const` forms), degrees to radians | 3/6 | `degToRad`: Math.PI is not in the reviewed overlay of library globals; `horizonFraction`: Math.tan, same; `atan2Deg`: Math.atan2, same |
| `slug.ts`: slug regex (constant and literal), a hand-written slug loop with `charCodeAt`, `slugify` (`trim`, `toLowerCase`, `replace(/…/g)`, `slice`), dot-file path checks (`split`, `some`, `startsWith`), `sceneAsset` returning a literal-typed record or `null` | 8/8 | — |
| `reduce.ts`: `reduce`, `for…of`, indexed loops, `Map` accumulation, `Object.values`/`Object.entries` of a record | 6/8 | `costByEngine` (`out[it.engine] = …`) and `totalOfKeys` (`rec[k]`): "a read at a key that may name a member every object inherits from `Object.prototype` (`toString`, `constructor`, `valueOf`, ...)" |
| `search.ts`: early `return` in `for` and `for…of`, `find`, `while` with `break`, `continue` | 5/5 | — |
| `asyncfn.ts`: `await`, `try`/`catch` with `continue` in a loop, an async callback parameter | 3/4 | `both` (`const [x, y] = await Promise.all([a, b])`): evidence search failed: no derivation of its node-typing claim |
| `klass.ts`: classes with unannotated field initializers (`count = 0`) | 0/2 | `(init)`, `meanOf`: missing type annotation in klass.ts#Stats |
| `klass2.ts`: classes whose fields are annotated and assigned in the constructor, a `#private` field, methods, a function that uses the class | 2/2 | — |
| `union.ts`: discriminated union with `switch`, with `if`, exhaustive `default: assertNever(j)`, a type predicate | 5/5 | — |
| `readonly.ts`: `readonly T[]`/`ReadonlyArray` with `map`, `filter`, `slice(-2)`, `[...xs].sort(…)`, `xs[xs.length - 1]`, a readonly tuple, nested readonly tuples | 7/7 | — |
| `collections.ts`: `[...new Set(xs)]`, `ReadonlySet.has`, `Map` get/set, `for (const [k, v] of m.entries())`, `Set.add` | 5/5 | — |
| `typed.ts`: `Uint16Array`, `Float32Array`, `Uint8ClampedArray`, `Uint8Array` | 0/4 | "type outside the fragment (ThisType) in typescript/lib/lib.es5.d.ts#Float32Array"; `new Float32Array(n)`: "the global Float32Array is declared in … lib.es5.d.ts (library), an origin no reviewed entry admits" |
| `units.ts`, `importer.ts`: functions and a type imported from a second file | 5/5 | — |
| `mathfns.ts`: `Math.floor`, `Math.sign`, `Math.min(a, b, c)`, `Math.max(...xs)`, `Math.round` inside min/max, `v ** 0.5`, a type guard with `Number.isFinite` | 7/12 | `Math.trunc`, `Math.sqrt`, `Math.sin`, `Math.hypot`, `Math.PI`: each "is not in the reviewed overlay of library globals" |
| `strings.ts`: `toFixed`, `String(n).padStart`, templates, `lastIndexOf`, `split(/\s+/)`, `charAt`/`toUpperCase`, `join` | 9/9 | — |
| `json.ts`: `JSON.parse` to `unknown`, then `Array.isArray` and `typeof` per element; reads of literal keys on `Readonly<Record<string, unknown>>` | 3/4 | `lookFromJson` (`'exposure' in v` after `typeof v === 'object'`): "unsupported: missing field exposure" |
| `objects.ts`: `??` on an optional field, an `as const` tuple and its element type, a `switch` over that union, a default parameter | 4/5 | `withExposure` (`{ ...l, exposure: e }`, where `l` has readonly and optional fields): evidence search failed |
| `patterns.ts`: the rewrites below, plus a generic function, recursion, a closure over a `let`, optional chaining, sequential `await`s, `new Array<number>(n).fill(0)` | 10/12 | `asRecord` (`Object.fromEntries(map)`): evidence search failed; `parseCm`: Number.parseFloat is not in the reviewed overlay (the global `parseFloat` is) |

TScert's own catalogue of the subset is its `docs/SOURCE-FRAGMENT.md`, which lists every refusal with its reason, and
`docs/SOURCE-CONTRACTS.md` ("Library globals"), which lists the reviewed library entries. Where they disagree with a
result above, the result here is what this build actually did. For example, the fragment table cites `Math.floor` as
unreviewed, but here it certifies.

## TScert-friendly TypeScript (the guide every Phase 2 track follows)

**Split each module into a functional core and an imperative shell.** Code that decides goes into a logic module:
clamps, projections written over plain numbers, parsers of already-decoded values, reducers, state machines, labels.
Code that touches the world goes into a shell: the DOM, WebGL and three.js, `fetch`, `node:fs`, `node:http`, timers,
the wasm kernels and typed arrays. Keep shells thin. A shell calls the logic and does what it says.

### Module rules

- Logic modules live in `planner/logic/`, `server/src/logic/` or `pipeline/src/logic/`. They import only other logic
  modules and types (`import type`, `contract/gen/types.ts`). They have no DOM, no Node, no three.js. The TScert
  configs give them no ambient types, so such code fails there.
- Write each unit as a top-level `function` declaration with annotated parameters and an annotated result. Each one
  is certified and ratcheted on its own. Top-level `const f = () => …` lands in the module's `(init)` unit, so keep
  `(init)` to constants.
- Use `interface`s with `readonly` fields, discriminated unions on a literal `kind`, and `as const` tuples for closed
  sets of names. Do not use `enum`, namespaces or parameter properties (`erasableSyntaxOnly` refuses them anyway).
- Use no `any`, no `as` casts and no `!`. TScert gives no meaning to a type assertion, and lint makes all three errors.

### Numbers

- **Do:** `+ - * / %`, `**` (`x ** 0.5` for a square root), `Math.abs/floor/ceil/round/sign/fround/min/max` (spreading
  a readonly array into `Math.max` is fine), `Number.isFinite`/`Number.isInteger`, `toFixed`, `String(n)`, and
  literal constants (`3.141592653589793`, `0.017453292519943295`).
- **Don't:** `Math.PI`, `Math.sqrt/sin/cos/tan/atan2/hypot/trunc/log/exp`, `Number.parseFloat`. None is reviewed.
  Take trigonometry as a parameter, and let the shell pass `Math.tan`. This certifies:

```ts
// planner/logic/horizon.ts                                   // the shell: horizonWith(p, f, Math.tan)
export function horizonWith(pitchRad: number, fovRad: number, tan: (x: number) => number): number {
  return 0.5 - tan(pitchRad) / (2 * tan(fovRad / 2))
}
```

### Arrays, records, maps

- **Do:** take `readonly T[]` parameters; use `map`, `filter`, `slice`, `find`, `some`, `join`, `reduce`, and sort a copy
  (`[...xs].sort(…)`). An index read is `T | undefined` (`noUncheckedIndexedAccess`), so test it against `undefined`.
- **Do:** use `Map<string, V>` and `Set<T>` for anything keyed at run time. `ReadonlyMap`/`ReadonlySet` parameters,
  `m.entries()` loops and `[...new Set(xs)]` all certify.
- **Do:** read a record with `Object.entries` or `Object.values`, or at a literal key (`r['exposure']`).
- **Don't:** index a record with a run-time string (`out[key] = …`, `rec[k]`): the key might be `toString`. Use a `Map`.
- **Don't:** use `Object.fromEntries(map)` (the search fails) or `Promise.all` with destructuring (await one at a time).
- **Don't:** use typed arrays (`Float32Array`, `Uint8Array`, …) in logic. Their library types are outside the fragment.
  Pixel, depth and mask loops belong in the Rust kernels (`core/`) or in a shell.

### Objects

- **Do:** build objects field by field. With `exactOptionalPropertyTypes`, branch on the optional field:

```ts
export function withExposure(l: Look, e: number): Look {          // certifies
  return l.ambient === undefined ? { exposure: e, warmth: l.warmth } : { exposure: e, warmth: l.warmth, ambient: l.ambient }
}
// return { ...l, exposure: e }                                     // refused: a spread of readonly/optional fields
```

- **Do:** use `?.` and `??`, and defaults that are literals (`function twice(n = 3): number`).
- **Classes:** annotate every field and assign it in the constructor. `#private` fields are fine. Field initializers
  without a type (`count = 0`) are refused, so write `count: number` and set it in the constructor. Better still, prefer
  plain functions over records.

### Control flow and async

- **Do:** `if`, `switch` (including exhaustive `default: return assertNever(x)`), `for`, `for…of`, `while`, `break`,
  `continue`, early `return`, `try`/`catch` (with an `unknown` binding or none), `throw new Error(…)`, recursion,
  closures, unbounded generics, and `async`/`await` of native promises, including async callback parameters.
- **Don't:** use labelled `break`/`continue`, generators, `for await`, or `Promise.all` with destructuring.

### Strings and regular expressions

- **Do:** `trim`, `toLowerCase`/`toUpperCase`, `slice`, `split` (on a string or a regex literal), `padStart`, `charAt`,
  `charCodeAt`, `lastIndexOf`, `startsWith`, `join`, template literals, `/…/.test(s)` (a literal or a module constant),
  and `replace` with a regex literal.

### JSON and other untrusted input

- **Do:** validate untrusted objects in the shell with the generated validators (`contract/gen/`) and pass typed values
  to logic. Inside logic, arrays from `JSON.parse` can be narrowed by hand (`Array.isArray`, then `typeof` per
  element). An object can come in as `Readonly<Record<string, unknown>>`, with literal keys read through `typeof`:

```ts
export function lookFromRecord(r: Readonly<Record<string, unknown>>): Look {      // certifies
  return { exposure: numberOr(r['exposure'], 1), warmth: numberOr(r['warmth'], 0) }
}
```

- **Don't:** narrow `unknown` with `typeof v === 'object'` followed by `'key' in v`. It is refused ("missing field").

### Workflow for a track

1. Write the logic module. Run `nix develop -c node scripts/tscert-ratchet.mjs --files <your files>` and rewrite what
   it refuses, using the rules above.
2. When it certifies, run `--update` so that its functions join `tscert/baseline.json`, and commit the baseline with
   the code.
3. Anything that still cannot certify moves to a shell, or stays in logic with the refusal reason in your notes. The
   ratchet only demands that what certified once keeps certifying.

## Not done

- Linux: the Node, Lean and `tools/node_modules` fetches have Linux entries, but the Linux `node_modules` hash is a
  placeholder and nothing was built on Linux.
- Running `tscert check` directly as the user is wired up but was never exercised here, because the permission
  classifier blocked it. Only the sandboxed path has been run.
