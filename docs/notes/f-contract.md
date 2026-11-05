# f-contract (v2 Phase 1)

The contract made machine-checkable, and the eval switches that let v2's server and CLI be judged by v1's evals.
Branch `v2-f-contract`, from `v2` at 0d40ff5.

## What exists

- **API schemas** `contract/api/*.schema.json` (draft 2020-12, `$id` `midstudy/api/<file>`, `title` = the type name):
  every JSON payload of CONTRACT.md §2.6–2.11 and §4.4, requests and answers, 36 files. `contract/api/routes.json`
  maps each of the 28 routes (and each status) to its schemas. `contract/api/README.md`: the table, and every place a
  schema follows v1 because the contract is silent.
- **File schemas**: the five gained named `$defs` (`scene.schema.json`: camera, look, upload; `layout.schema.json`:
  item; `library.schema.json`: dims) and `title`s on their `$defs`, so the API can `$ref` them and the types get names.
  Same verdicts as before on 4,834 instances (below). New: `trash.schema.json` (scene `trash.json`, library
  `entry.json`) and `add-summary.schema.json` (`midstudy-add`'s summary line), so strict mode covers every JSON file the
  server writes and every line it reads.
- **Codegen** `scripts/gen-contract.mjs` (deterministic, idempotent, `--check`): `contract/gen/types.ts` (76
  `export type`s, deeply readonly, no `any`, `unknown` for free-form), `contract/gen/validate.js` + `.d.ts` (Ajv
  standalone, ESM, no runtime import; a type guard `is<Type>` per type, `validators` by schema URI, `violation(uri,
  data)` → `{schema, path, message} | null`), `contract/gen/routes.js` + `.d.ts` (routes.json with `matchRoute`,
  `responseSchema`: strict mode is `violation(responseSchema(route, status), body)`), and
  `core/crates/contract/schema.json`, the bundle typify reads.
- **Rust crate** `core/crates/contract` (package `midstudy-contract`): `build.rs` runs typify 0.8 on `schema.json`
  (serde types; chrono for date-time, regress for patterns); `tests/examples.rs` round-trips every example.
- **Examples** `contract/examples/<method>-<path>.json` (+ `files-trash.json`, `cli-midstudy-add.json`): 97 real
  requests and answers of all 28 routes, recorded from v1 by `contract/tools/record-examples.mjs` (the harness's
  server with the eval mocks, the golden scenes, fixtures/models, fixtures/fal, fixtures/product-pages; never
  fixtures/photos; it refuses to write a file holding a local path).
- **Tests**: `contract/test/contract.test.mjs` (node:test, 11 tests), `contract/test/typecheck.mjs` (tsc on gen/ and
  every example via `satisfies`), `contract/tools/check-recordings.mjs` (validates `MIDSTUDY_RECORD_API` output).
- **Harness switches** (`evals/lib/harness.mjs`, `evals/library_api.sh`, `evals/pipeline_offline.sh`):
  `MIDSTUDY_SERVER=legacy|next`, `MIDSTUDY_ADD=legacy|next`, `MIDSTUDY_STRICT=1` with either `next`, `node
  scripts/build.mjs` once per eval process when it exists (as a check), a first line naming server and CLI,
  `MIDSTUDY_RECORD_API=<dir>`. Exports for others: `SERVER`, `SERVER_CMD`, `ADD`, `ADD_CMD`, `STRICT`,
  `serverCommand(flags)`, `ensureBuilt(ev)`, `RECORD_DIR`.
- **CONTRACT.md**: §0 v2 (stack, normative API schemas, generated code, strict mode, examples, switches), §2.1 and
  §3.1 the v2 commands, §5.1/§5.3 headless Chrome and the WebGPU flags, §5.3 the switches. §4.3 untouched (calib).
- `evals/README.md` "How they run": the lock, browser, switches, build step, recording. `package.json`: `gen:contract`,
  `test:contract`, `contract:examples`.

## Run and check

```
nix develop -c node scripts/gen-contract.mjs [--check]              # regenerate / drift check
nix develop -c node --test contract/test/contract.test.mjs         # schemas, routes, gen fresh, examples, refusals
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
nix shell $NP#typescript $NP#nodejs_22 -c node contract/test/typecheck.mjs   # until tsc is in the dev shell
cd core && nix shell $NP#cargo $NP#rustc $NP#clippy -c cargo test -p midstudy-contract
cd core && nix shell $NP#cargo $NP#rustc $NP#clippy -c cargo clippy -p midstudy-contract --all-targets -- -D warnings
nix develop -c node scripts/eval-lock.mjs -- node contract/tools/record-examples.mjs [--check]
MIDSTUDY_RECORD_API=$PWD/evals/out/recordings nix develop -c node scripts/eval-lock.mjs -- npm run eval:scenes-api
nix develop -c node contract/tools/check-recordings.mjs evals/out/recordings
MIDSTUDY_SERVER=next MIDSTUDY_ADD=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:all   # once v2 exists
```

## Measured (this session)

- Every v1 answer matches on the first recording: 97 examples, 0 problems (`record-examples.mjs`: 82/82).
- Recordings: eval:scenes-api 219/219, eval:library 78/78, eval:product 408/408 with `MIDSTUDY_RECORD_API` on;
  `check-recordings`: 397 `/api` calls, 493 bodies (answers, accepted requests, meta headers), 0 problems. Only
  `render-list` was not exercised by those three (the examples cover it).
- Defaults change nothing: eval:scenes-api 219/219, eval:library 78/78, eval:pipeline 72/72 (the counts docs/STATUS.md
  has for v1; run twice, the second time at the final commit), eval:selftest 22/22, eval:planner 55/55; each prints
  `… server legacy (python3 planner/serve.py), furniture CLI legacy (uv run --project pipeline midstudy-add)` first.
- File-schema restructure: old (HEAD) and new schemas give the same verdict on 4,834 instances (26 fixture and
  recorded documents and every one-key mutation: drop, null, string, ±1e6, unknown key), 1,565 accepted
  (`evals/out/schema-equivalence/check.mjs`, scratch).
- Node tests 11/11; tsc 5.9.3 with the REFACTOR §3 flags: gen/ and 97 examples type-check (a negative control with an
  unknown key, a missing key and a wrong enum fails 3/3); Rust: 97 examples round-trip, clippy `-D warnings` and
  `cargo fmt --check` clean, crate builds in ~12 s cold.
- Sizes: validate.js 558 KB (allErrors off; about 7 % more with it), types.ts 35 KB, schema.json 79 KB, examples 168 KB.
- `next` without v2 code fails cleanly: E1 `server/src/main.ts exited (1)`, E7 `node server/src/main.ts did not answer`,
  E8 `pipeline/src/cli.ts not found`; `MIDSTUDY_SERVER=foo` throws `must be legacy or next`. The build step: a passing
  and a failing temporary `scripts/build.mjs` give PASS / FAIL with its stderr, once for two servers (file removed).
- E8's next-only splat-cover check, dry-run with v1's CLI: passes (ratio > 0.95); thinning by opacity alone would give
  0.297, so it catches the regression it is for.

## Decisions

- **Own TS generator**, not json-schema-to-typescript: `export type`, deep `readonly`, `unknown`, tuples, no new
  dependency, and the same bundle as Rust. Checked by tsc on every example.
- **Names**: a schema's `title` when it is an identifier (API schemas, `$defs`), else the file name; identical `$defs`
  (calib's and scene's Camera, the two Slugs) become one type. Pointer refs into `properties` (scene-detail reusing
  scene-object's fields) are inlined; a ref into an object schema must go through `$defs` (the generator refuses).
- **Types are looser than validators by design**: patterns, ranges, `not` (PublicCalib = Calib), assertion-only
  anyOf branches are validation only. Rust: an optional nullable key is `Option<T>`, so null and absent read the
  same; everything else round-trips exactly, open objects' unknown keys kept in a flattened `extra` (the bundle gives
  open objects `additionalProperties: {}` for that). The test allows only optional nulls to vanish (62 of them).
- **Bundle in the crate** (`core/crates/contract/schema.json`, draft-07 `definitions`: typify reads schemars 0.8), so
  the crate builds from its own folder (Nix packaging). typify 0.8.0 (the latest stable; 0.10 is alpha).
- **Validators**: Ajv 8.20 standalone with `allErrors: false` (strict mode reports the first error), `inlineRefs:
  false`, the `ucs2length` helper inlined (no `require`), date-time as one RFC 3339 regex (also in
  `contract/tools/schemas.mjs`). `strictRequired` off (a `not: {required}` names keys the schema doesn't define).
- **Strict mode** (CONTRACT §0): 500 `contract violation: <schema URI> <JSON pointer>`; the CLI exits 1 with
  `midstudy-add: contract violation: …`. Files: scene.json, layouts, library.json, renders/<name>.json, trash.json,
  entry.json; the CLI: library.json and its summary line.
- **Harness**: `--midstudy-add` is now passed explicitly, also for legacy (the same string as serve.py's default).
  E8 with `next` adds `NODE_USE_ENV_PROXY=1` (Node ignores HTTP_PROXY otherwise; the dead proxies are the money
  guard). E8's splat-cover check calls v1's Python module; with `next` it runs the same 400,000 splats through a
  mocked SAM 3D add instead (the legacy check is unchanged). `uv sync --project pipeline` only for legacy.
- The recorder lives in `contract/tools/` (tracked, so v2 can be re-recorded and diffed), its scratch in `evals/out/`.

## Requests

- **f-toolchain**: `check:gen` = `node scripts/gen-contract.mjs --check` (it also covers
  `core/crates/contract/schema.json`); put `node --test contract/test/contract.test.mjs` and
  `node contract/test/typecheck.mjs` in `npm run check` (or call them from your gates); eslint and knip must ignore
  `contract/gen/**` (generated; validate.js is Ajv output); tsconfig needs `allowImportingTsExtensions` (validate.d.ts
  imports `./types.ts`); with `typescript` in package.json, typecheck.mjs uses `node_modules/.bin/tsc`. My crate is
  formatted with rustfmt defaults; re-run `cargo fmt` if core/rustfmt.toml changes them. Union `core/Cargo.lock`.
- **server-core / server-routes**: strict mode is `violation(responseSchema(matchRoute(method, path).route, status),
  body)` from `contract/gen/routes.js` and `contract/gen/validate.js` (typed by their .d.ts); keep
  the v1 details listed in `contract/api/README.md` (delete answers' extra keys, renders' `mock`, light jobs'
  `calib: null`, …); `trash.json`/`entry.json` as `trash.schema.json`.
- **pipeline**: strict mode for `node pipeline/src/cli.ts` (library.json, the summary line); accept `--source-input`
  (v1's server passes it); read a SAM 3D PLY with only the 14 standard properties (E8's next cover check feeds one).
- **integration**: switch E1's two direct spawns of `planner/serve.py` (`evals/scenes_api.mjs` lines 712, 719) and
  `evals/product_live.mjs` line 47 to the harness's `serverCommand()`; then record v2 with `MIDSTUDY_SERVER=next node
  contract/tools/record-examples.mjs --check` and compare with `contract/examples/`.
- **calib**: calib.schema.json and lighting.schema.json only gained `title`s on their `$defs` (no validation change);
  regenerate any types made from them.

## Left / open

- The `next` paths are only tested for clean failure: there is no v2 server or CLI yet.
- validate.js is 558 KB; the server loads all of it, the planner bundle should import only the guards it uses.
- The Rust crate is built and tested natively only (the pinned toolchain has no wasm32 std).
- `check:gen` is not wired into `npm run check` yet (f-toolchain).
