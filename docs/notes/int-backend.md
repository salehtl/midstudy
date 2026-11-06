# int-backend (v2 Phase 3, integration: the backend half)

Branch `v2-int-backend`, from `v2` at `979677c` (worktree `.claude/worktrees/rf-int-backend`). It merges the Phase 2
backend tracks, makes them one program (one `common/` for the server and `midstudy-add`), wires the calibration worker
end to end with its schema in the contract, and checks the result with `MIDSTUDY_SERVER=next MIDSTUDY_ADD=next` (strict
mode on). Everything below was run on rabbit on 2026-11-06 (05:20–), fal mocked (`MIDSTUDY_FAL_MOCK=fixtures/fal`,
`MIDSTUDY_NO_DOTENV=1`, no FAL_KEY anywhere, never `.env`), headless Chrome from `$PUPPETEER_EXECUTABLE_PATH` only,
never `fixtures/photos/private/`. Nothing was pushed. The planner half is int-planner's (`v2-int-planner`); this branch
does not touch `planner/`.

## What merged

`git merge --no-ff`, in this order, onto `979677c`:

| # | Branch | Tip | Merge | Conflicts |
|---|---|---|---|---|
| 1 | `v2-server-core` | `22eb9b1` | `e37737c` | none |
| 2 | `v2-server-scenes` | `2bc2028` | `ae15b4b` | none |
| 3 | `v2-server-library` | `0948aed` | `201c1fe` | `package.json` (shared-append): `test:scenes` + `test:library`, unioned |
| 4 | `v2-product` | `ef7c0f3` | `7a3ac2f` | `package.json` again (`test:product`), unioned |
| 5 | `v2-pipeline` | `19970f0` | `ce2c9d8` | `core/Cargo.lock` (add/add: `midstudy-wasm-pipeline` and `midstudy-wasm-product`, both kept); `tscert/baseline.json` (union of both sides' functions, written as the ratchet writes it) |
| 6 | `v2-kernels-hardening` | `8cdeb9c` | `4bed9e1` | none |

`v2-calib` (`40d1058`) is already in `979677c` (merged at `9a250e5`): nothing to merge. `npm run build`
(`cargo build --locked`) accepted the merged `Cargo.lock` unchanged. On the merged tree, before any change of mine:
test:server 93/94 (the stub assertion, expected), test:scenes 29/29, test:library 10/10, test:product 3/3, pipeline 24/24,
and with next/next E1 220/220, E7 78/79 (the `costs.csv.lock` check: the v2 CLI's own lock didn't create v1's file),
E8 72/72, E14 409/409, E13 51/51, H0 22/22.

## What int-backend changed, and why

### One `common/` for the server and `midstudy-add`

`common/` (server-core's, in the server's and now also the pipeline's tsconfig and TScert projects) is the one copy of
what both tools need; the CLI's copies are deleted. Every move kept v1's observable behaviour; where the two copies
differed, the difference and the choice are below.

| What | Now | Deleted copies | Notes |
|---|---|---|---|
| The v2 lock (contract §2.8 One writer) | `common/lock.ts`: `acquireLock`/`withLock`/`withLibraryLock` + `onWait` (called once when found held: midstudy-add's "waiting for another library write to finish (<library>/.lock)") + a per-process list of held locks with `releaseAllSync()` (the CLI's Ctrl-C and SIGTERM handlers) + a synchronous release | `pipeline/src/lock.ts`, `pipeline/src/logic/lock.ts` | The pipeline's copy lacked the 10 s grace for a folder without `owner.json` (it waited an hour) and v1's lock files beside the folders: with the shared one, midstudy-add also creates `costs.csv.lock`, which closes E7's "cost rows use their own lock file" failure under `MIDSTUDY_ADD=next` without changing the eval. The server and the CLI now exclude each other for certain (same code), which the switch needs. |
| costs.csv rows | `common/costs.ts` `appendCost(file, row, cmd)`; `CostRow.format: 'server' \| 'add'` | `pipeline/src/library.ts`'s appender; `pipeline/src/logic/pyformat.ts` `costText`, `csvRow` | v1 had two `fmt_cost`s: serve.py's (`0.10`) and midstudy-add's (`0.1`, the shortest to four places). Both are kept, per writer (`fmtCost`, `fmtCostShort` in `common/logic/pyfmt.ts`), so the rows stay byte for byte (compare_v1: cost rows identical). The file is read strictly as both v1 tools read it (`common/utf8.ts`: a `UnicodeDecodeError` with Python's message; the server used to replace bad bytes). `csvLine([''])` is `""` as Python's csv writes it. |
| UTF-8 as Python decodes it | `common/utf8.ts` `decodeUtf8`/`utf8Text` | `pipeline/src/pytext.ts`'s decoder; the library service's private `TextDecoder` | Python's exact UnicodeDecodeError messages, a BOM kept. |
| fal: key, mock switches, request log, download | `common/fal.ts`: `falKey`, `falMock`/`falMockDir`/`mockCost`/`countsAgainstCap`, `mockSlug`, `logFal` + `uploadRecord`, `falRunUrl`, `falQueueUrl`, `falCall` (now logs each call), `download(url, {userAgent, timeoutMs, fetchFn})` with `HTTPError` | the CLI's `loadFalKey`, `mockCost`, `queueUrl`, `mockSlug`, its log writer and `download`'s fetch; common's unused `logMockCall`, `readMockAnswer`, `mockFilePath` | **One request log** (`MIDSTUDY_FAL_MOCK_LOG`): `{"op": "upload", "file", "content_type", "bytes", "sha256", "url"}`, `{"op": "call", "endpoint", "url", "args"}`, `{"op": "fetch", "url", "file"}`, one per line in Python's `json.dumps` layout (`common/logic/jsonline.ts`), from both tools. It replaces two formats: the product reader's `{"endpoint", "args"}` (E14 reads `endpoint` and `args`, still there) and the CLI's `{…, "arguments"}` (`pipeline/test/v1_mock_log.py` now writes `args` for v1 too). The server's live calls are logged as well (v1 logged only the product reader's mock calls); the key never is. midstudy-add's queue client (fal-client's protocol) and its mock replay stay in `pipeline/src/fal.ts`: the server never queues, and the replay's file rules are v1 midstudy-add's. |
| Files | `common/files.ts`: `atomicWrite(Sync)`, `isFile`, `isDir`, `exists`, `resolvePath` (`Path.resolve`), `removeTree` (`shutil.rmtree`, ignoring errors unless asked not to), `move` (`shutil.move`), `replace` (`os.replace`) | `pipeline/src/fsx.ts` (all but `mkdtemp`, `copy2`, `expanduser`), `server/src/scenes/files.ts`'s seven, `server/src/library/service.ts`'s `isDir`/`resolved`/`rmTree`/`move`, `main.ts`'s `realish` | Four `Path.resolve` ports and three `shutil.move` ports became one. `move` moves *into* an existing folder as `shutil.move` does (the library's and the CLI's copies didn't; no caller meets that case). `replace` across file systems copies beside the target and renames, so it stays atomic for readers. midstudy-add's atomic writes are common's (`.<name>.<random>.tmp`, mode 0600, as the server's always were; git ignores the mode). |
| The tool runner | `common/tools.ts` (was `server/src/tools.ts`) | — | midstudy-add runs no tools today; the worker client and the queues import it from common. |
| Slugs, ISO dates | `common/logic/slug.ts`, `common/logic/time.ts` | `pipeline/src/logic/inputs.ts` `isSlug`, `slugify`, `mockSlug`; the CLI's `utcStamp` body | Equal by construction (checked: same regexes and NFKD step). |
| Python's formatting | `common/logic/pyfmt.ts` | the pipeline's `fixed`, `pyRound`, `general`, `strip`, `repr`, `pyFloat`, `numText`, `floatRepr` | A differential over 120,000 numbers and 50,000 strings (scratch) found differences only on inputs no add meets, and Python decided each: common's were right (`'%.1f'` and `round()` past 2^50, `repr('\u1680')`), except `num_text` of an integral float past 2^53, where the pipeline's printed every digit as `str(int(x))` does; common's now does too. `floatRepr` and `pyFloatRepr`: 0 differences on 400,000 values. |

### The calibration worker end to end, and its schema in the contract

- `contract/calib-cli.schema.json` is calib's former `schemas/calib-cli.schema.json` (`git mv`, history kept); calib's
  copy is now generated like the other two (`calib/scripts/gen_contract_types.py`: the one-line `SOURCES` change);
  calib's tests read the contract's. `"type": "object"` was added to `run`'s second `allOf` branch: Ajv's strict mode
  (the generator's) refuses `required` without a type; jsonschema validates the same either way. `contract/gen/`
  regenerated: 85 types from 44 schemas (9 new: `CalibCliRun`, `CalibCliError`, `CalibCliLight`, …, `CalibCliRequest`),
  the validators and the Rust bundle (`midstudy-contract` builds; typify takes it).
- The server checks every calib result against it in strict mode (`server/src/scenes/calib.ts` `checked()`, through
  `strict.ts`'s new `conformance()`): the one-shot command's last stdout line and the worker's answer (with its `id`),
  as `#/$defs/run` / `light` / `align` for `ok: true`, `#/$defs/error` otherwise. A violation fails the job with
  `contract violation: <schema> <path> (<why>)` and a stderr line; the worker isn't counted as failing (it answered).
  A render's `align` result is checked the same way (a violation: not applied, with that reason). New test
  `server/test/scenes/calib-contract.test.ts` (a fake calib that drops `camera`, through the worker and one-shot).
- The worker client (server-scenes') and `midstudy-calib serve` (calib's) meet: `npm run test:scenes` runs the real
  `midstudy-calib serve` under `MIDSTUDY_CALIB_MOCK` (same `calib.json` as the one-shot), and E17's calib suite runs
  it with real MoGe-2 through HTTP (below). It is on by default: the server tries `<calib> serve` on the first
  calibration and keeps it while it answers. `fixtures/stub_calib.py` still works as a one-shot `--calib`: it has no
  `serve` (argparse exits 2), so the first three jobs fall back to one-shot and no worker is tried again.

### Smaller changes

| File | Change | Why |
|---|---|---|
| `server/src/routes/stub.ts`, `server/src/logic/http.ts` `NOT_IMPLEMENTED`, `router.ts` `ApiMethod` export | deleted / module-local | every route is implemented; knip |
| `server/test/server.test.ts` | "every stage-B route answers 501" → every mutation 403 without `X-Midstudy`, and no route answers 501; the `.lock.d` folders and `costs.csv.lock` are never served (W4) | the one failing test of test:server on every stage-B branch (their requests); the lock folders are new on v2 |
| `.gitignore` | the `library/…` patterns anchored (`/library/…`), `.lock.d` folders added | knip read them as matching at any depth and skipped `server/src/library/**` and `server/test/library/**` (server-library's request) |
| `evals/scenes_api.mjs` (the two startup-refusal spawns), `evals/product_live.mjs` (`--live --llm`'s server) | the harness's `serverCommand()` instead of `python3 planner/serve.py` | they tested v1 under `MIDSTUDY_SERVER=next` (server-core's and gate-1's requests); "where the harness starts things" |
| `tscert/config.json`, `tscert/tsconfig.{server,pipeline}.json` | areas for `server/src/{scenes,library,product}/logic`; `common/logic` in the pipeline's TScert project | their requests; the pipeline's logic now imports common/logic; the two private `tscert.json` projects deleted |
| `package.json`, `scripts/check.mjs` | `test:pipeline`; `check:tests` runs every `test:*` suite (FAL_KEY dropped) and is part of `npm run check` | the tracks' requests (test:server, test:scenes, test:library, test:contract into the gates) |
| `scripts/check.mjs`, `core/miri.txt`, `core/crates/splat/src/eigen.rs` | Kani `-j 4 --output-format terse`; Miri also on `midstudy-splat` and `midstudy-imaging`; splat's proptest block gets the hardened crates' Miri config (4 cases, no failure file) | kernels-hardening's and pipeline's requests; without the config splat's proptest aborted under Miri's isolation (`getcwd`) — the pipeline's "no proptest blocks" was not quite right |
| `package.json`, `package-lock.json`, `knip.json` | `@gltf-transform/functions` uninstalled (nothing imports it; it brought `sharp` and its native builds, 17 packages); `ignoreDependencies` only `libheif-js` and `obj2gltf` (loaded through `createRequire`) | knip without the ignores; product's request (parse5) |
| `contract/CONTRACT.md` | §2.8: one lock implementation; §2.11: the v2 extractor, "within 0.5 cm **or 1 %**" (v1's rule, product's finding); §3.3: `MIDSTUDY_FAL_MOCK_LOG`; §3.4: `.lock.d`; §4.3 Worker: the schema's place and the strict check | the tracks' requests |
| `core/js/node.ts` `decodeImageDataUri`, `server/src/http/context.ts` `jsonTooDeep` | a payload that re-encodes to itself (canonical base64, what `toDataURL` makes) is decoded by Node's `Buffer`; everything else still by the kernel. The depth walk runs only when the body has more than 990 brackets (`indexOf`, native) | E17's A/B found `render_capture_server` 1.39× v1 (7.5 → 10.4 ms). `--cpu-prof` of 300 renders: the kernel's data URI decoder (CPython's strict `a2b_base64` with Python's whitespace, in wasm) 2.5 ms per 260 kB composite, the depth walk 0.4 ms. On canonical base64 Node's decoder and CPython's agree byte for byte; a differential over 6,000 payloads (`server/test/infra.test.ts`) pins it. POST /api/render (mock, 195 kB JPEG, 60 interleaved rounds): v1 3.72 ms, v2 2.08 ms (was 5.11 ms). Thumbnail PUTs (scenes, library) take the same path |

RESULTS-PLACEHOLDER

## Decisions and deviations

- **The harness default stays `legacy`.** Every check here ran with `MIDSTUDY_SERVER=next MIDSTUDY_ADD=next`; flipping
  the default (evals/lib/harness.mjs, evals/library_api.sh, evals/pipeline_offline.sh) and deleting v1
  (`planner/serve.py`, `planner/product_page.py`, `pipeline/src/midstudy_pipeline/`, the Python half of
  `pipeline/pyproject.toml`) is the cutover, which also needs the planner half: the main session's call once both
  integration branches are merged. The v1 oracles that skip themselves when v1 is gone: `server/test/v1_oracle.py`,
  `server/test/scenes/v1_oracle.py`, `server/test/library/v1_library_oracle.py`, `server/test/product/v1_oracle.py`,
  `pipeline/test/v1_mock_log.py` + `compare_v1.py` (these two need v1's package).
- **Mixed modes are unsafe and not run.** A v1 tool (flock on `.lock`) and a v2 tool (`.lock.d`) don't exclude each
  other (contract §2.8): `MIDSTUDY_SERVER` and `MIDSTUDY_ADD` should switch together; nothing here runs them mixed.
- **One request-log format** (above): the product reader's lines gain `op` and `url` and escape non-ASCII as Python's
  default `json.dumps` does (v1's product reader wrote `ensure_ascii=False`); readers parse JSON, so E14 is unchanged.
- **Strict checks of calib results fail the job** (strict mode only, i.e. evals): a result that breaks the schema is a
  bug in calib or the stub, and a failed job says so; outside strict mode nothing is checked, as for answers and files.
- **What stays duplicated, on purpose** (each would be a rewrite with byte-exact consequences, not a move): two ports of
  Python's `json` (`pipeline/src/logic/pyjson.ts`: loads and dumps with ints/floats as v1 wrote library.json;
  `server/src/product/logic/pyjson.ts`: loads with `strict=False`, bigint ints, the recursion limit) and the library's
  `JSON.rawJSON` reader (`server/src/library/json.ts`); two partial ports of `urllib.parse` (`server/src/logic/url.ts`:
  urlsplit, urljoin, unquote, parse_qs; midstudy-add's `urlPath` (urlparse's path), `quote` and `unquote` in
  `pipeline/src/logic/inputs.ts` and `pipeline/src/fal.ts`). A shared `common/logic/url.ts` is the natural next step.
