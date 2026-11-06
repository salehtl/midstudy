# server-library (v2 Phase 2, stage B)

v1's library API (planner/serve.py `LibraryService` and the handlers `get_library`, `post_library_upload`,
`post_library_from_url`, `queue_add`, `patch_library_item`, `put_library_thumb`, `delete_library_item`,
`restore_library_item`, and the library job routes of `handle_api_get`; contract §2.8, §2.9) in strict TypeScript on
server-core's seams. Branch `v2-server-library`, from `v2-server-core` at `22eb9b1`. Everything below was run on rabbit
between 2026-11-05 23:30 and 2026-11-06 01:00 UTC, fal mocked (`MIDSTUDY_FAL_MOCK=fixtures/fal`, `MIDSTUDY_NO_DOTENV=1`,
`NOOK_NO_DOTENV=1`, `--daily-spend-usd 0` except the cap tests), never `.env`, never `fixtures/photos/`, headless Chrome
only through the eval harness. Nothing was pushed. `POST /api/library/product` is the product track's.

## What exists

| Path | What |
|---|---|
| `server/src/routes/library.ts` | The 9 routes, v1's patterns in v1's order, each check in v1's order with v1's sentence: GET `/api/library` (with `trash`), `/api/library/jobs`, `/api/library/jobs/<id>`; PUT `…/items/<id>/thumb`; POST `/api/library/items` (raw body), `…/items/from-url`, `…/items/<id>/restore`; PATCH and DELETE `…/items/<id>` |
| `server/src/library/service.ts` | `LibraryService`: library.json read and written as v1 did (an empty library when it is missing or not `{…, items: […]}`), the trash listing in v1's order, `locked()` (the v2 library lock, 60 s, then Busy → 503), the one job queue (`JobStore` + `SerialQueue`, one at a time, in order, newest first; reservations released and upload folders removed after each job), `run` (midstudy-add with v1's messages: running, not installed, timed out (the estimate held for the UTC day), the CLI's stderr line, no summary, done/upsert/refit) |
| `server/src/library/json.ts` | library.json and entry.json parsed with every number **as spelled** (ES2026 `JSON.rawJSON` via the reviver's source text, Node 22), `plain()` for answers and schema checks; request values with Python's types (`PyValue`): the X-Midstudy-Meta JSON with ints and floats as spelled |
| `server/src/library/zip.ts` | An OBJ zip's central directory read exactly as Python 3.12's zipfile reads it (end record search with comments, zip64 end record and locator, zip64 and Info-ZIP Unicode Path extra fields, v1's BadZipFile sentences, the "zip file version" error v1 didn't catch), then the media kernel's `zipPlan` (v1's rules and sentences) |
| `server/src/library/logic/pyvalue.ts` | Pure (TScert): `PyValue`, Python's `repr`, truthiness, `in` over numbers, code point order |
| `server/src/library/logic/meta.ts` | Pure: v1 `check_dims`, `check_meta` (order and sentences), `ENGINE_PRICE`, `add_command`, the rescale command |
| `server/src/library/logic/upload.ts` | Pure: X-Midstudy-Kind, X-Midstudy-Filename, the extension rules, the limits and every upload sentence |
| `server/src/library/logic/patch.ts` | Pure: PATCH's shape (unknown keys sorted by code point), the field rules in v1's order (Shows as for Idol), the in-place sets, the refit decision |
| `server/src/library/logic/messages.ts` | Pure: the 404/409 sentences, job status lines, the trash names and order |
| `server/test/library/*` | `logic.test.ts`, `zip.test.ts`, `routes.test.ts` (v1 against v2), `lock.test.ts` (the 503), `oracle.ts` + `v1_library_oracle.py` (v1's own functions), `fake_add.py` (a stand-in midstudy-add), `hold-lock.ts` |
| `package.json` (shared-append) | `test:library` |

## Commands

```sh
nix develop -c npm ci && nix develop -c npm run build                 # once
nix develop -c npm run test:library                                    # 10 tests, 71 s (the lock test waits the 60 s)
nix develop -c node --test server/test/library/routes.test.ts          # v1 and v2 side by side over HTTP, ~10 s
MIDSTUDY_SERVER=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:library
MIDSTUDY_SERVER=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:splat
nix develop -c node scripts/check-ownership.mjs server-library --base v2-server-core
# TScert on these modules until tscert/config.json has their area (see Requests); build/ is git-ignored:
nix develop -c node scripts/tscert-ratchet.mjs --files server/src/library/logic/pyvalue.ts,server/src/library/logic/meta.ts,server/src/library/logic/upload.ts,server/src/library/logic/patch.ts,server/src/library/logic/messages.ts,common/logic/time.ts --project build/tscert-library/tsconfig.json
```

`build/tscert-library/tsconfig.json` is `tscert/tsconfig.server.json` with `../../server/src/library/logic/**/*.ts` in
its include (extends `../../tsconfig.server.json`, `lib` ES2024, `types` []); `common/logic/time.ts` is listed only so
that `common/logic/` is copied into the sandbox (the modules import it).

## Measurements

**Against v1 itself** (`npm run test:library`; v1 = `planner/serve.py` and its functions, the dev shell's Python 3.12):

- `check_meta`: 135 X-Midstudy-Meta texts × both kinds = **270 cases, all equal** to v1 (the fields, or the same
  sentence): names (blank, Unicode spaces, BOM, accents, unsluggable, 120 characters, `-Shelf`, duplicate keys), dims
  (missing, null, list, partial, 0, negative, bool, string, `80.0`, `1e2`, `1e-7`, 20-digit ints, `1e21`, `1.5e300`),
  ids (null, "", non-slug, 64/65 characters, `5`, `5.0`, `-0`, bool, list, nested dict, a trailing newline),
  category/prompt types, mount (`Floor`, `0`, `0.0`, `false`, containers), yaw (`-0.0`, `90.0`, `9e1`, `45.0`, `45.5`,
  `"90"`, bools, `1e400`), engine (every value and falsy one for both kinds), resolution, every pair of errors (v1's
  order), non-objects. First run: 2 differed (`yaw: -0.0` gave -0 where `int()` gives 0); fixed.
- `add_command`: 8 argument lists equal (every `--opt=<v>`, `--prompt` only for sam3d, `--resolution` only for
  trellis2, `--source-input` a URL or a file name, the input and library resolved like `Path.resolve()`).
- `zip_problem`: **57 zips, all equal** (null, the same sentence, or the same uncaught `NotImplementedError: zip file
  version 6.4`): the fixture, every rule (absolute, `..`, backslash, drive letter, link, extension, 0/2 `.obj`,
  `__MACOSX`/`.DS_Store`/directories skipped, 1,000 vs 1,001 entries, exactly 500 MiB vs one byte more, declared sizes,
  zip64 sizes), and every way zipfile can't read one: not a zip, empty, 4 bytes, a comment, a wrong comment length,
  trailing junk, prepended data, bad offset, bad central magic, truncated central directory, corrupt extra fields,
  zip64 extra fields short at each of its three values, Unicode Path fields (applied, wrong CRC, version 2, short, bad
  UTF-8, empty, climbing), cp437 and UTF-8 names, zip64 end records (valid, multi-disk, corrupt, missing, locator past
  the end, locator at the start).
- **HTTP, v1 and v2 side by side** (`routes.test.ts`): both servers get the same script against their own scratch
  library with the same stand-in midstudy-add (`fake_add.py`); v2 runs in strict mode. **133 records equal**: every answer
  (status and JSON; job ids, times and trash stamps normalized) and the files: **library.json byte for byte** after adds, upserts,
  PATCHes, a thumbnail, deletes and restores (`80.0` and friends kept), the argument lists midstudy-add got, the stored
  thumbnail (its EXIF stripped by both, identical bytes), what's left in `.trash/`. The script: 26 upload refusals in
  v1's order (headers, meta, extensions, 411 chunked, 413 for both kinds answered early, empty, not an image, not a GLB,
  an unreadable zip), 8 adds and 6 failing jobs (a `midstudy-add:` stderr line among others, stderr without one, no
  output, no summary, a list or null summary), the job list and 404s, 17 from-URL cases against a local web server
  (bodies, meta, private address, `file://`, no host, a page, text, a fake JPEG, an empty file, 404, a redirect loop, a
  stripped URL through a redirect), 23 PATCHes (every rule, the order of rules, in place, unchanged, a turn and new dims
  as rescale jobs), 9 thumbnails (bad bodies, PNG, garbage, truncated, over 2 MB, 404, 409 without a folder, a data URI
  with line breaks), deletes, restores (404, 409, twice), and crafted trash folders (order by `deleted` then folder,
  unreadable ones skipped). Three answers differ only in the JSON parser's words after v1's "body is not valid JSON: "
  (server-core's `readJson`, a documented deviation); the test normalizes those.
- **The spend cap, side by side** ($0.05 cap, `MIDSTUDY_FAL_MOCK_COST=1`): 13 answers equal (and the web server untouched), including the 402 while
  a slow paid job holds its reservation ("… $0.02 spent and $0.02 reserved by calls still running, …"), the used-up
  402, "this call costs $0.35, more than the daily fal budget ($0.05) allows", a from-URL add refused before any
  download (the web server saw no request), and `GET /api/spend` with and without a reservation.
- **The lock** (`lock.test.ts`): while another process holds `<library>/.lock.d`, PATCH, DELETE, restore and PUT thumb
  sent together all answer 503 with v1's sentence after 60 s (60,012 ms), library.json, the folder and the trash
  unchanged; `GET /api/library` answered at once; a thumbnail waiting on a holder that is killed 1,500 ms later went
  through at 1,543 ms (the lock reclaimed as a dead owner's) and kept `80.0` in library.json.

**Evals** (`MIDSTUDY_SERVER=next`, so the harness sets `MIDSTUDY_STRICT=1`; through `scripts/eval-lock.mjs`):

| Eval | Before (server-core) | This branch, legacy CLI | Throwaway merge + v2-server-scenes, legacy CLI | + v2-pipeline, `MIDSTUDY_ADD=next` |
|---|---|---|---|---|
| E7 library-api | build check, then "did not answer GET /api/library" | **78/79** | **79/79** | 78/79 |
| E13 splat | not run (its first add would get a 501) | 24/51: every library check passes | **51/51** | **51/51** |

- E7 on this branch: the one failure is "W2 /api/render counts against the same cap (402)": `POST /api/render` is
  server-scenes' route (a 501 stub here). Run twice: 78/79 both times (at `279ca42`, 21 s wall; at the final code, 15 s).
  For reference, v1's server on the same branch: 79/79, 44 s wall (single runs at different loads: not a performance
  comparison).
- E13 on this branch: passes E13.01–E13.11 (the Idol default at $0.10, SAM 3D, the rug, the entries, validate_library,
  splat.spz/splat.ply served), E13.14 (the planner's library), E13.38–E13.42 and E13.46–E13.48 (the Add form and Edit
  sheet over the library API), E13.50–E13.51; the 27 failures are all scenes: `POST /api/scenes` is a 501 stub
  (E13.12, then every placement and render, and E13.49's console errors from those 501s).
- The throwaway branch (`tmp-server-library-e2e`, deleted afterwards; never merged into this branch) merged
  `v2-server-scenes` at `2af2439` (one conflict: package.json's two test scripts, unioned), then `v2-pipeline` at
  `466952f` (one conflict: tscert/baseline.json, unioned). With `MIDSTUDY_ADD=next`, E7's one failure is "cost rows
  use their own lock file, next to costs.csv": the v2 CLI doesn't create v1's `costs.csv.lock` beside its
  `costs.csv.lock.d` (see Requests, pipeline).

**Latency** (`evals/out/library-perf/perf.mjs`, scratch: v1, v2 and v2 strict on copies of the same library, 32 items
and 10 trash folders, 10 interleaved rounds of 30 requests, a fresh connection each, load ~20): `GET /api/library` p50
**v1 0.95 ms, v2 0.63 ms, v2 strict 0.66 ms** (p95 1.21 / 0.82 / 0.87); `GET /api/library/jobs` p50 0.29 / 0.23 /
0.23 ms. With an empty library: 0.70 / 0.53 / 0.53 ms.

**server-core's own tests** (`npm run test:server`) on this branch: 93/94. The one failure is server-core's assertion
that "every stage-B route answers 501" (`GET /api/library` now answers 200); see Requests.

## TScert

**All 59 units of the 5 modules certify** (every top-level function and each module's initialization):

| Module | Units |
|---|---|
| `pyvalue.ts` (12) | codePointOrder, dictGet, inNumbers, noneOrEmpty, numberOf, pyCompare, pyInt, pySorted, pyTruthy, pyValueRepr, reprEntries, reprItems |
| `meta.ts` (16) | (init), addArgv, checkDims, checkMeta, choice, dimText, engineOf, enginePrice, fail, imageEngineOf, modelEngineOf, mountOf, optionalText, positive, rescaleArgv, sameNumber |
| `upload.ts` (9) | (init), extProblem, imageExt, sizeLimit, suffixOf, tooLarge, unreadableZip, uploadFilename, uploadKind |
| `patch.ts` (8) | (init), checkPatch, defaultRenderProblem, fieldProblem, needsRefit, patchShape, setsOf, storedValue |
| `messages.ts` (14) | (init), existsAgain, noFolder, noItem, noJob, noTrashed, notInTrash, notInstalled, queuedMessage, runningMessage, serverFailed, timedOut, trashName, trashOrder |

Measured at the final code with a scratch config (`build/tscert-library/config.json`: tscert/config.json's five areas plus
`server/src/library/logic/**/*.ts`) at load 3: `tscert: 174/174 certified, all 115 baselined still certify, 59 new (add
them: --update) (20 files, 18 s)`. And **`npm run check:tscert`** (the official areas): `ok — 115/115 certified, all 115
baselined still certify (15 files, 8 s)`.

The modules live in `server/src/library/logic/` (this track owns `server/src/library/**`, not `server/src/logic/`), which
no area of `tscert/config.json` covers yet, so `npm run check:tscert` doesn't see them and **their functions are not in
`tscert/baseline.json`**: adding them now would make the official ratchet fail ("gone": not in any area) until the area
exists. Request below; once it is added, `--update` puts these 59 in the baseline.

First run: 4 refused, rewritten as tscert/README.md suggests: `concat` (not in the array contract) → a spread literal and
`push`; a spread of a Map's key iterator → `for (const [key] of m.entries())`; a type-predicate narrowing of a field
returned through a union (`isImageEngine(v.value)`, "evidence search failed") → a `switch` returning literals, the engine
choice split in two smaller functions.

**TScert's "tool errors" look like hangs, not slow units.** Four of the eight runs here ended with "verifier … did not
finish within N s" (N = 180, 600, 900) and no verdict, on server-core's units more often than on these: `targetParts`,
`slugifyDecomposed`, `checkMeta` (run 1), `engineOf` (run 3), `apiPathOf`, `urlHostname` (run 5), `parseIpv4`,
`stalledMessage`, `mockSlug`, `pyFixed` (the first official run, 921 s). During run 3 and the first official run `ps` showed the waiting
`stage-runner`s at 0 % CPU, each with a forked child that still showed as `stage-runner` (it had not exec'd the
verifier), asleep, next to a zombie sibling; so a longer step limit only makes the run longer. The same checks then
passed in 8–18 s once the machine's load fell (12–35 → 2–3), with `MIDSTUDY_TSCERT_STEP_LIMIT=120`. A short step limit
and a retry is the practical answer; worth a look by f-toolchain (stage-runner's fork and exec).

## Decisions and deviations from v1

Each is invisible to E7 and E13; the tests above pin them.

- **Numbers in library.json keep their spelling.** v2's writes (PATCH, thumbnail, delete, restore) no longer turn
  midstudy-add's `80.0` into `80`: library.json and entry.json are parsed with each number's source text and written
  back with it (`JSON.rawJSON`), so E7's L9 ("restore brings the item back byte for byte", compared through Python) and
  the tracked `library/library.json` see no change v2 didn't make. Schema checks and answers use plain numbers. This
  closes server-core's open issue for the library's own files.
- **Image bytes are sniffed by the media kernel** (`sniff`, calib's HEIF rule), not serve.py's 16-byte `image_kind`:
  an AVIF-only `mif1`/`msf1` file is refused (v1 took it and midstudy-add then failed), and `hevm`, `hevs`, `mif2`,
  `miaf` HEIFs are taken (k-media's `sniff-avif`/`sniff-brands` decision; server-core's notes ask for it).
- **Zip names**: a name with a NUL, or flagged UTF-8 but not, is refused by the kernel ("the zip holds a file name that
  can't be read (…)") where v1 cut the name at the NUL or answered 500 (UnicodeDecodeError) — the media kernels' policy.
- **X-Midstudy-Meta with `NaN`/`Infinity`**: Python's json.loads took them (an `Infinity` dimension then reached
  midstudy-add as `--dims=inf…`); v2 answers "X-Midstudy-Meta must be base64 of a JSON object with name and dims_cm".
  A meta nested deeper than Python's recursion limit: 400 there too (v1: 500 RecursionError).
- **From-URL and PATCH bodies** come from server-core's `readJson` (JSON.parse), so a float written as an integer
  (`45.0`) is an int in check_meta's sentences ("got 45"); it is still accepted where v1 accepted it (`yaw: 90.0`). The
  X-Midstudy-Meta header is read with each number's spelling, so its sentences are exact.
- **A library.json whose `assets` or `source` isn't an object**: PATCH treats it as missing (v1: 500 AttributeError).
  Such a file breaks library.schema.json (strict mode refuses to write it anyway).
- **A midstudy-add that can't be started for another reason than "not found"** (permissions): "the server failed to run
  midstudy-add (OSError: <Node's message>)" where v1 named Python's exception class.
- Inherited from server-core (unchanged here): JSON answers in JavaScript's number format, the JSON parser's own words
  after "body is not valid JSON: ", header values trimmed at both ends, keep-alive, timeouts kill midstudy-add's whole
  process group.

## Contract vs v1

No new disagreement. v1 answers DELETE with `{ok, trash}` and ignores meta keys the contract doesn't list; both are
already in contract/api/README.md, and v2 does as v1. `POST /api/library/items` validates nothing against
library-meta.schema.json at run time (v1 didn't either; strict mode checks answers and files only).

## Requests

- **f-toolchain / main session** (`tscert/config.json`, `tscert/tsconfig.server.json`): add the area
  `{"glob": "server/src/library/logic/**/*.ts", "project": "tscert/tsconfig.server.json"}` and put
  `"../server/src/library/logic/**/*.ts"` in tscert/tsconfig.server.json's `include` (server-scenes' and product's
  `server/src/*/logic/` need the same), then `node scripts/tscert-ratchet.mjs --update` to baseline these functions.
- **f-toolchain** (`.gitignore`): knip silently skips `server/src/library/**` and `server/test/library/**` (and any
  other path with a `library` folder) because it reads `.gitignore`'s `library/*/`, `library/_inbox/`, `library/.lock`,
  `library/.trash/`, `library/costs.csv.lock` as matching at any depth (git anchors them, since they contain a slash).
  Anchoring them (`/library/*/` …) keeps git's meaning and lets check:dead see this code. Checked with
  `npx knip --no-gitignore`: it found 12 unused exports here, now removed, and is clean.
- **integration (Phase 3)**: `server/test/server.test.ts` "every stage-B route answers 501" now fails on the library
  routes (they answer); drop them from its 501 list (its 403-before-the-gate half still holds). Put `npm run
  test:library` beside `test:server` in the gates. E7's render check needs server-scenes' route (79/79 merged).
- **pipeline**: create v1's `<costs file>.lock` beside `costs.csv.lock.d` when missing (common/lock.ts does), or
  import common/lock.ts: with `MIDSTUDY_ADD=next`, E7's "cost rows use their own lock file, next to costs.csv" fails.
- **server-core / integration** (`server/src/http/context.ts`), optional: a `readJson` that keeps each number's
  spelling (the reviver's source text) would make from-URL's meta sentences exact too (see Decisions).

## Left

- The TScert area for `server/src/library/logic/` and its 59 baseline entries (Requests: f-toolchain or the main
  session).
- E7 79/79 and E13 51/51 were reached only on a throwaway merge with v2-server-scenes (and v2-pipeline for the next
  CLI); on this branch alone, E7's render check and E13's scene checks wait for server-scenes' routes.
- `server/test/server.test.ts`'s 501 assertion (server-core's file) fails on the implemented library routes until
  integration trims it (Requests).
- Not run here: check:rust, check:fuzz, check:proofs, check:py (no Rust, Lean or calib Python changed; the Python files
  in `server/test/library/` are the tests' v1 oracle and stand-in CLI).
