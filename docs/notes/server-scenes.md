# server-scenes (v2 Phase 2, stage B)

v1's SceneService and the scene, layout and render routes of `planner/serve.py` (contract §2.6, §2.7, §4.2–§4.4, §4.7,
§4.8's backfill) on server-core's seams, plus the calibration worker client of contract §4.3 "Worker" (new on v2).
Branch `v2-server-scenes`, from `v2-server-core` at `22eb9b1`. Everything below was run on rabbit on 2026-11-06
(03:30–04:45, load 8–58), fal mocked (`MIDSTUDY_FAL_MOCK`, `MIDSTUDY_NO_DOTENV=1`, no FAL_KEY anywhere, never `.env`),
never `fixtures/photos/`, headless Chrome from `$PUPPETEER_EXECUTABLE_PATH` only. Nothing was pushed.

## What exists

| Path | What |
|---|---|
| `server/src/routes/scenes.ts` | `GET /api/scenes`, `…/jobs`, `…/jobs/<id>`, `…/<name>`; `PUT …/<name>/thumb`, `PUT …/<name>`; `POST /api/scenes` (upload), `…/calibrate`, `…/light`, `…/restore`; `DELETE …/<name>`. v1's patterns in v1's order (the stubs' `routes` export kept) |
| `server/src/routes/layouts.ts` | `GET/PUT/DELETE /api/layouts/<layout>?scene=`, `GET /api/layouts?scene=` |
| `server/src/routes/render.ts` | `POST /api/render` (v1's checks in v1's order), `GET /api/renders[?scene=]` |
| `server/src/scenes/service.ts` | `SceneService`: scenes on disk, the scene object, `full`, `all`, trash, create/update/delete/restore, thumbnails, the calibration queue (`SerialQueue` + `JobStore`), the camera rules when a job ends, light jobs |
| `server/src/scenes/calib.ts` | `CalibRunner`: the warm worker client (`<calib> serve`) with the one-shot fallback (below) |
| `server/src/scenes/render.ts` | `RenderService`: names, the spend reservation, fal (or the mock), cost rows, keep-room align one-shot, metadata, the list |
| `server/src/scenes/files.ts` | Synchronous file helpers: tolerant JSON reads (v1 `read_json_file`), `writeJsonSync` (strict mode's `assertConforms` + `atomicWriteSync`, i.e. `writeJsonFile` synchronously), `shutil.move`, `Path.resolve`, CPython's `st_mtime` |
| `server/src/scenes/shared.ts` | `scenesFor(deps)`: the one SceneService and RenderService the three route modules share (a WeakMap on `ServerDeps`); the worker is stopped through `deps.onShutdown` |
| `server/src/scenes/logic/*.ts` | Pure, TScert: `values` (Python's `is_num`, truthiness, `str()`, code-point order and length, `" ".join(s.split())`), `camera` (clamp, merge), `look` (LOOK_RANGE/BOOL/HELP, the checks, the merge), `sceneput` (PUT /api/scenes/<name>'s checks), `status` (calib_status, lighting_status), `jobs` (job sentences), `names` (scene/render/trash names, trashed-folder parsing, list orders), `layout` (PUT layout checks, the stored layout, list summaries), `render` (models, prices, prompts, checks, align result, metadata), `scene` (upload headers, sentences, scene-object pieces), `time` (CPython's st_mtime, `int()`, `iso_utc` with microsecond rounding), `worker` (the protocol's lines, the failure count) |
| `server/src/scenes/logic/tscert.json` | The TScert project for these modules until `tscert/config.json` has the area (Requests); named so tsc/eslint/editors ignore it |
| `server/test/scenes/*.test.ts`, `v1_oracle.py`, `fake-calib.ts` | 29 tests (below) |
| `package.json` (shared-append) | `test:scenes` |
| `knip.json` (shared-append) | entries `server/test/scenes/*.test.ts`, `server/test/scenes/fake-calib.ts` |

## The calibration worker client (contract §4.3 Worker, the server's side)

`CalibRunner.run(job)`: the queue's `run`, `fit` and `light` steps go to one long-lived `<calib> serve` (request id = the
job id, absolute paths), answered one at a time within the job's 600 s; its stderr is read continuously (what it wrote
during a request backs a failure sentence, as a one-shot run's stderr does). The answer minus `id` is handled exactly as
the one-shot result line (exit code 0 for `ok: true`, 1 otherwise).

- Started on the first calibration job, never at startup, with the repository as working directory and the server's
  environment (`MIDSTUDY_CALIB_MOCK` reaches it: tested).
- Can't start, exits, answers non-JSON, a non-object or another id → killed (SIGTERM to its process group, SIGKILL after
  5 s) and that job runs one-shot; the next job starts a new worker. 3 such failures in a row → one-shot for the rest of
  the server's life (logged once). Any answer, `ok: false` included, starts the count again; `ok: false` is the job's
  failure with its sentence, the worker stays.
- Timeout: the job fails with v1's one-shot timeout sentence, the worker is killed, the next job starts another. A
  timeout neither counts as a failure in the row nor resets it (the contract is silent).
- Idle 10 minutes → its stdin is closed (it exits, MoGe's memory comes back); shutdown → stdin closed, killed after 5 s.
  While the server stops, a job whose worker was closed under it ends "the server stopped" instead of starting a
  one-shot run that would outlive the server.
- A one-shot fallback after a crash gets its own 600 s (v1's timeout per tool run).
- `align` (renders) is always one-shot (`runTool`, 180 s).
- `fixtures/stub_calib.py` has no `serve` (argparse exits 2 at once): its jobs run one-shot, and after 3 jobs no worker is
  tried again. The evals' `evals/lib/gated_calib.py` waits on its gate for `serve` too, then execs the stub, which exits:
  the job falls back while it is shown `running`, exactly as before.

## Commands

```sh
nix develop -c npm ci && nix develop -c npm run build
nix develop -c npm run test:scenes                                      # 29 tests, ~15 s (needs planner/serve.py and calib/ for 2 of them)
nix develop -c node --test server/test/scenes/http-diff.test.ts         # v1 and v2 side by side: 163 exchanges + 16 written files
F=$(ls server/src/scenes/logic/*.ts | tr '\n' ',')common/logic/slug.ts
nix develop -c node scripts/tscert-ratchet.mjs --files "$F" --project server/src/scenes/logic/tscert.json   # 99/100 (+ slug.ts)
MIDSTUDY_SERVER=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:scenes-api   # likewise render, occlusion, floor, planner
nix develop -c node scripts/check-ownership.mjs server-scenes --base v2-server-core
```

## Measurements

**Evals** (`MIDSTUDY_SERVER=next`, so `MIDSTUDY_STRICT=1`; legacy CLI; through the eval lock), each run twice (E1 and E6 a
third time on the final code), identical results every run:

| Eval | v2 (this branch) | The failures |
|---|---|---|
| E1 scenes-api | **219/220** | E1.188 "a library id with a trailing newline is 400": it posts to `POST /api/library/items`, server-library's route (501 here) |
| E6 render | **36/37** | E6.35 no console errors: Chrome logs the 501s of `GET /api/library` and `PUT /api/library/items/probe-box/thumb` |
| E4 occlusion | **20/21** | E4.20, the same two 501s |
| E5 floor | **34/35** | E5.33, the same 501s |
| E3 planner | **55/56** | E3.54, the same 501s |

Every console error listed by those checks is a library-route 501, nothing else; no strict-mode contract violation in
any eval server's log. To make sure nothing else hides behind them, a scratch copy of this tree (under the git-ignored
`evals/out/`, deleted afterwards, never committed) with a 40-line stand-in for `GET /api/library`, `GET
/api/library/jobs` and the thumbnail PUT ran the four browser evals through the lock: **E6 37/37, E4 21/21, E5 35/35, E3
56/56**. So once server-library's routes exist these should be whole; E1.188 needs its upload route's id check.

**v1 and v2 side by side** (`server/test/scenes/http-diff.test.ts`): `planner/serve.py` and `node server/src/main.ts`
(strict mode) with their own scratch folders get the same 163 requests (uploads with every header problem, the 411 and
413, every PUT /api/scenes refusal and their order, camera clamps and rounding, look clamps/nulls/merges/wrong types,
thumbnails, calibrate (fit, run on source.jpg, no photo), light (done, backfill, mock miss, 409s), layouts (every
refusal, the stored layout, the list order, unreadable files, delete), renders (every refusal, the models, keep-room
through the stub's align), delete, the trash (including a legacy folder without trash.json), restore): **same status
and same JSON for all 163**, and the 16 JSON files they wrote (scene.json, layouts, render metadata, trash.json) equal,
once names, ids, times and cache busters are placeholders.

**Against v1's own Python** (`server/test/scenes/logic.test.ts` + `v1_oracle.py`, which imports planner/serve.py and calls
its handlers with a stand-in `self`): 3,000 seeded random PUT /api/scenes bodies (v1's refusal or v1's patch, every one
equal), 1,500 random accepted patches over odd scene.json files (the scene.json v1's `SceneService.update` writes, key
order included), 3,000 random layouts (v1's refusal or the exact stored layout), 500 camera clamps, `public_calib`,
trashed-folder names (Unicode digits included), `no_scene`, the name order against the kernel's `compareNames`, 60 file
mtimes near second boundaries (CPython's `st_mtime` float bit for bit, `int()`, `iso_utc` with its microsecond carry),
and the light and calibrated job sentences (Python's `round()` to even: 4500.5 K → 4500).

**Worker** (`server/test/scenes/worker.test.ts`, a fake midstudy-calib that misbehaves on demand, 14 tests): one worker
for many jobs and none at startup; env reaches it; the stub's exit 2 → one-shot, no worker after 3; garbled, wrong id,
crash → killed, one-shot, a new worker next; `ok: false` → the job's failure, worker kept; failures must be in a row;
timeout → v1's sentence, killed; idle close; shutdown with a request in flight; a calib command that isn't there →
v1's sentence; light jobs through it, scene.json untouched; and the **real** `midstudy-calib serve` under
`MIDSTUDY_CALIB_MOCK`: the same calib.json as the one-shot command.

**Real MoGe-2 through the worker client** (scratch `evals/out/worker-bench/bench.ts`, through the eval lock, MPS, the
three golden photos, two rounds, no mock): one-shot fit (v1's way: a process per photo) median **5.88 s** (the very first
27.6 s, cold caches); through the worker the first fit 5.68 s and **every later one 0.96 s** (0.92–0.97): **−84 %** per
calibration after the first. The worker's camera equals the one-shot's on every photo.

**GET latency, v1 vs v2** (scratch `evals/out/latency/latency.ts`, `eval-lock --exclusive`, load 8.5, 6 calibrated scenes,
3 layouts, interleaved rounds, a new connection per request, 200 requests each, no strict mode): p50 / p95 in ms —
`/api/scenes` v1 1.50 / 1.92, v2 **1.24 / 1.78**; `/api/scenes/<S>` 0.69 / 0.93 vs **0.54 / 0.76**; `/api/layouts?scene=`
0.51 / 0.67 vs **0.42 / 0.55**; `/api/scenes/jobs` 0.38 / 0.45 vs **0.31 / 0.38**; `/api/renders` 0.38 / 0.52 vs
**0.33 / 0.47**. No regression (REFACTOR §4.1's "API latency: no regression").

**Billed render path offline** (`server/test/scenes/render.test.ts`, RenderService with a stand-in for fal: no network,
no key in the environment): both images as data URIs for nano-banana with a scene, the composite alone for kontext and
qwen, the cost row written once fal answered (also when there is no image or the download fails), v1's 502 and 503
sentences, the cap refusing before any call, the reservation released.

**Gates on this branch**: check:types ok, check:lint ok (58 files), check:dead ok, check-ownership ok (29 paths).
`npm run test:server` (server-core's): 93/94 — the failing one asserts that every stage-B route answers 501, which mine
no longer do (Requests). check:tscert: my modules aren't in its areas yet (Requests); the gate itself hit a tool error
(a 600 s step timeout on server-core's `mime.ts#extension` at load 14–25), not a verdict: run it again when quieter.

## TScert

`--files server/src/scenes/logic/*.ts --project server/src/scenes/logic/tscert.json`: **99 of 100 units certify** (13
files, 31 s at load 14). The one that doesn't is `values.ts#isRecord` (`v is Readonly<Record<string, unknown>>` from
`typeof v === 'object' && v !== null && !Array.isArray(v)`: "the promised argument is not within the promise at this
return"); every caller is certified against its signature. Two units were reshaped to certify: `checkScenePut` (a look
patch built with a loop, not `map(…) as const`) and `pyTruthy` (one `typeof` test per type). Under heavy load (58) the
first runs ended in tool errors (step timeouts), not verdicts. Nothing is in `tscert/baseline.json` yet: the ratchet
only reads tscert/config.json's areas, and an entry for a file outside them counts as lost.

## Decisions and deviations from v1

Every one is invisible to the evals and the differential, or stricter.

- **No lock object.** v1's SceneService held an RLock around every scene-folder change. Here those changes are
  synchronous (files.ts): a read and the write that depends on it happen in one turn of the event loop, so no other
  request runs between them. The only awaits are the body read (before) and the tools and fal (outside the folder
  changes), as in v1.
- **The worker** is new on v2 (above). Timeouts don't count toward the 3 failures (contract silent); output on the
  worker's stdout with no request in flight kills it without counting a failure (a protocol break the real worker can't
  make).
- **Upload sniffing** goes through the media kernel (`sniff` + `photoExt`), which uses calib's HEIF brand rule (k-media's
  expected difference: v1's serve.py also took AVIF's `mif1`-only files and lacked `hevm hevs mif2 miaf`).
- **X-Midstudy-Meta** is decoded by the kernel up to 64 KiB (Node's header limit; v1 had none). A meta whose bytes start
  with a UTF-8 byte order mark is refused as v1's `json.loads` refused it (the kernel's decoder drops a BOM).
- **JSON numbers** are JavaScript's: `-0.0` and `80.0` are written `0` and `80` (server-core's decision; the same numbers).
  JSON with NaN/Infinity is a 400 (`body is not valid JSON: …`) where v1's json read it and then refused it as "not a
  number" (also 400; E1's NaN check passes); a calib result line with NaN would read as "no result line" (v1: a number).
- **A trashed scene.json that is JSON but not an object** lists as an object without fields; v1 crashed the whole listing
  (`AttributeError`, 500).
- **A calibration tool that can't be executed** (EACCES) gives "the server failed to run the calibration (OSError: …)" with
  Node's message (v1: `PermissionError: [Errno 13] …`).
- **One clock reading** names a new scene and stamps its `created` (v1 read the clock twice; they could straddle a second).
- **Listing ties** (equal `created` and equal name keys, impossible for names the server makes) follow Node's readdir
  order (sorted) where v1 followed the file system's.
- **Kept from v1 on purpose:** the server clamps `light_azimuth_deg` to −180…180 (270 → 180); the planner wraps an azimuth
  before it sends it, so the planner never meets the clamp. The layout list is sorted by **file name** (`a-b.json` before
  `a.json`), as v1's `sorted(glob)`, and `details` carry `title`. `model: [1]` or `{…}` in a render request is v1's 500
  `TypeError: unhashable type: 'list'`.

## Contract vs v1

No disagreement that changes behaviour. Where the contract is looser, v1's (and api/README.md's) choice is kept and
tested: §2.7 says the layouts list is "sorted by name"; v1 sorts by file name (differs only for a name that continues
another with `-`). §2.7's DELETE answers `{ok, trash}`; v1 also sends `name` and `scene`. §2.6's `GET /api/renders` also
answers `mock`. §4.3 Worker doesn't say whether a timeout counts toward the 3 failures (here: no).

## Requests

- **f-toolchain / gate** (`tscert/**`): add the area `{"glob": "server/src/scenes/logic/**/*.ts", "project":
  "tscert/tsconfig.server.json"}` to `tscert/config.json`, and `"../server/src/scenes/logic/**/*.ts"` to
  `tscert/tsconfig.server.json`'s `include`, then `node scripts/tscert-ratchet.mjs --update` (99 units join the
  baseline). Then `server/src/scenes/logic/tscert.json` can go. The same will be needed for server-library's and
  product's logic folders if they made their own.
- **server-core / integration** (`server/test/server.test.ts`): "every stage-B route answers 501" must drop the scenes,
  layouts and render routes (they answer now; `server/test/scenes/` covers them). On this branch it is the one failing
  test of `npm run test:server` (93/94).
- **integration**: run `npm run test:scenes` in the gates (or widen `test:server` to `server/test/**/*.test.ts`); delete
  `server/test/scenes/v1_oracle.py` and the two oracle/differential tests with `planner/serve.py` at the cutover (they
  skip themselves when it is gone).
- **server-library**: E1.188 and the console-error checks of E3–E6 wait for `GET /api/library`, `GET /api/library/jobs`,
  `PUT /api/library/items/<id>/thumb` and the upload's id check.
- **calib (optional)**: a stdlib `serve` in `fixtures/stub_calib.py` would let the fast evals exercise the worker path
  too (today they exercise the fallback).

## Left

- The live render (a real fal call) was not run (never without the user's OK); its code path is tested offline with a
  fal stand-in. `eval:real` (real MoGe-2 through the HTTP path) wasn't run: it also adds a GLB through the library
  route; the worker was measured with real MoGe-2 directly instead (above).
- check:tscert can't certify my modules until the area exists (Requests).
