# server-core (v2 Phase 2, stage A)

The infrastructure of v1's `planner/serve.py` (lines 1–600, the Handler's request plumbing, `main()`) in strict TypeScript
on Node 22, run directly as `node server/src/main.ts`, with every /api route registered as a 501 stub for the stage-B
tracks (server-scenes, server-library, product) to replace. Branch `v2-server-core`, from `v2` at `979677c`. Everything
below was run on rabbit on 2026-11-06 (01:30–03:30), fal mocked, `MIDSTUDY_NO_DOTENV=1`, no FAL_KEY anywhere, never
`.env`, never `fixtures/photos/`. Nothing was pushed.

**Stage-B agents: read "The seams" first.** Port behaviour from v1's code for your routes; everything before your
handler runs (Host, framing, the forged-request check) and after it (strict mode, error mapping, fallbacks) is done.

## What exists

| Path | What |
|---|---|
| `server/src/main.ts` | The CLI: v1's flags, defaults and refusals (argparse rules), path resolution, strict mode, the route table, listen, v1's banner lines, SIGINT/SIGTERM shutdown hooks |
| `server/src/deps.ts` | `ServerConfig`, `ServerDeps` (what every route module gets) |
| `server/src/http/server.ts` | `createServer(options)`: node:http with v1's order (Host → framing → method → gate → routes/static), Node's parser refusals mapped to v1's answers, socket timeouts |
| `server/src/http/context.ts` | `RequestContext` (one request, its body and its one answer), `HttpError`, `BodyStalled`, `NO_CACHE` |
| `server/src/http/router.ts` | `ApiRoute`, `RouteModule`, `ApiMethod`, `findRoute` (the registration seam) |
| `server/src/http/static.ts` | `serveStatic`, `StaticDirs`: the allowlist through the media kernel's `staticRoute` |
| `server/src/routes/{scenes,layouts,render,library}.ts`, `server/src/product/route.ts` | 501 stubs with v1's patterns in v1's order (`routes/stub.ts`: `notImplemented`) |
| `server/src/routes/spend.ts` | `GET /api/spend` (implemented: the spend cap is core) |
| `server/src/strict.ts` | Strict mode: `enableStrict`, `answerViolation`, `assertConforms`, `writeJsonFile`, `ContractViolation` |
| `server/src/spend.ts` | `SpendCap` (reserve / release / hold, today's total from costs.csv) |
| `server/src/fetch.ts` | `safeFetch` (§2.9, parameterised for page fetches), `fetchImage` (v1's `fetch_image`), `Budget`, `FetchFailed`, `FetchError`, `originOf` |
| `server/src/jobs.ts` | `JobStore`, `SerialQueue`, `newJobId` |
| `server/src/tools.ts` | `runTool` (no shell, timeouts kill the process group), `splitCommand` (shlex), v1's output parsing re-exported |
| `server/src/logic/*.ts` | Pure, TScert: `url` (urlsplit, urljoin, unquote, parse_qs), `address` (BLOCKED_NETS, fetch_allowed), `http` (v1's sentences, the target's parts, Python's error page), `mime`, `spend` (the 402), `cli` (argparse), `jobs` |
| `common/lock.ts`, `common/logic/lock.ts` | The v2 library lock (directory protocol, contract §2.8 One writer v2) |
| `common/costs.ts` | `appendCost` (v1's header and rows, under `<costs file>.lock.d`) |
| `common/fal.ts`, `common/logic/env.ts` | The key, mock mode (answers and linked files), `falCall`, the mock log, `download` |
| `common/files.ts` | `atomicWrite`, `jsonText` (v1's two JSON layouts), `readJsonFile`, `makeTempDir` |
| `common/logic/{pyfmt,time,slug,csv,shlex,tool}.ts` | Pure, TScert: Python's formatting (`fmt_cost`, `repr`, `round`, `:g`, `num_text`, `mb_text`, `strip`, `splitlines`), UTC stamps, slugs, CSV, shlex, the tools' output |
| `server/test/*.test.ts`, `server/test/v1_oracle.py`, `server/test/lock-child.ts` | 94 node tests (`npm run test:server`) |
| `contract/CONTRACT.md` | §2.8 One writer: the v2 lock protocol; pointers in §2.8 What /library/ serves, §2.9 (spend cap, Framing), §3.4 |
| `tsconfig.server.json` | Includes `common/**`, `core/js/node.ts`, `contract/gen/**` (the server checks what it imports) |
| `package.json` (shared-append) | `test:server` |
| `knip.json` (shared-append) | entries `server/test/*.test.ts`, `server/test/lock-child.ts`; project `common/**/*.ts` |
| `tscert/baseline.json` (shared-append) | the logic functions that certify (below) |

`common/` is code `midstudy-add` can share (the lock, costs.csv, fal, files, the pure helpers). It sits in the server's
tsconfig area today; see Requests for the pipeline.

## The seams (stage B starts here)

### Registering routes

Each route module exports `routes: RouteModule` (`(deps: ServerDeps) => readonly ApiRoute[]`). `main.ts` calls, in this
order: scenes, layouts, render, library, product, spend. **Replace the stubs' handlers in place; keep the export name.**
Per method, the first route whose `path` matches the **whole percent-decoded /api path** wins (v1's chain of
`re.fullmatch`); a GET route also answers HEAD (Node drops the body). Params are the regex groups (`''` when unmatched).
v1's `m.group(1) != "jobs"` is written into the pattern: `/^\/api\/scenes\/(?!jobs$)([^/]*)$/` (the stubs already do).

```ts
import type { RouteModule } from '../http/router.ts'
export const routes: RouteModule = (deps) => [
  { method: 'GET', path: /^\/api\/scenes\/([^/]*)$/, handle: async (ctx, [name]) => { … await ctx.send(200, body) } },
]
```

Before a handler runs, the dispatcher has: checked Host (403), Content-Length (400), the forged-request check for
POST/PUT/PATCH/DELETE (403). After it: strict mode checks the answer; a thrown error maps to an answer:
`HttpError(status, sentence)` → `{"error": sentence}` with that status (v1's `ValueError` → 400 pattern);
`Busy` (common/lock.ts) → `503` v1's "the library is busy …"; `BodyStalled` → `408` v1's sentence and a close (or just
a close when the client left); `ContractViolation` → `500 contract violation: …`; anything else → `500 "<Name>: <message>"`
(v1's `f"{type(e).__name__}: {e}"`). Unmatched: `404 no such endpoint: <METHOD> <path>` (GET for HEAD), `405 PUT is only
supported under /api`, POST/PATCH/DELETE outside /api `404` with the path as sent.

### `RequestContext` (`ctx`)

| Member | v1 |
|---|---|
| `method`, `target` (leading `//` reduced), `parts: TargetParts \| null` (`rawPath`, `query`, `fragment`, …), `apiPath` | `self.command`, `self.path`, `urlsplit(self.path)`, `api_path()` |
| `header(name)` (first value), `headerValues(name)` | `self.headers.get`, `get_all` |
| `query(key)` | `self.query(key)` (parse_qs: `+` a space, percent-decoded, blank values dropped, first value) |
| `contentLength: number \| null` (already validated), `chunked` | the Content-Length header, `self.chunked()` |
| `await ctx.readJson()` | `read_json_body`: throws `HttpError(400, …)` with v1's sentences (`empty request body`, `request body too large` over 32 MiB, `body is not valid JSON: …`, `… it is nested too deeply`), `BodyStalled` |
| `await ctx.readBodyTo(file, length)` → bytes written | v1's upload loop (1 MiB chunks to a private file): fewer than `length` = the client ended early (v1: "the upload stopped before the end: try again") |
| `await ctx.readBody(length)` → `Buffer` | `self.rfile.read(length)` |
| `await ctx.send(status, data)`, `await ctx.error(status, sentence)` | `send_json`, `error_json`: a 411 or 413 **before the body was read** goes out at once with `Connection: close`, then a drain of at most 5 s and the close; any other answer first reads and drops an unread body (≤ 256 MiB, ≤ 60 s) |
| `ctx.closeConnection()` | `self.close_connection = True` (v1 set it before its 411s) |
| `ctx.bodyDone`, `ctx.markBodyDone()`, `ctx.answered` | `self.body_done` |
| `ctx.sendHtmlError(status, message)`, `ctx.sendEmpty(status, headers)`, `ctx.beginFile(...)` | `send_error`, redirects, static files (static.ts) |

`Expect: 100-continue`: `100 Continue` is sent only when a handler reads the body (readJson/readBody/readBodyTo), so an
early refusal reaches curl before it uploads.

### Infrastructure (import directly)

- **Spend cap** (`deps.spend: SpendCap`): `reserve(key, amount)` → `null` or the 402 body `{error, spent_usd, cap_usd}`
  (v1's two sentences; nothing is held for amount ≤ 0); `release(key)`; `holdForToday(key)` → amount kept till the end of
  the UTC day (a paid job killed at its timeout); `view()` → `{day, spent_usd, reserved_usd, cap_usd}`; `spent(day)`;
  `today()`. Reserve with `countsAgainstCap() ? price : 0` as v1 did. All synchronous, so a reservation is atomic.
- **Library lock** (`common/lock.ts`): `withLibraryLock(deps.config.libraryDir, { waitMs: 60_000, cmd: 'midstudy server' }, async () => …)`
  (Busy after 60 s → the dispatcher answers 503); `waitMs: null` waits as long as it takes; `acquireLock(dir, options)` →
  `HeldLock {release()}`, `withLock`, `libraryLockDir`, `costsLockDir`, `Busy`. Protocol: contract §2.8 One writer (v2).
- **Costs** (`common/costs.ts`): `await appendCost(deps.config.costsFile, { date: isoUtc(now), id, engine, costUsd, mock, input })`
  writes v1's exact row (`fmt_cost`, `true`/`false`, csv quoting) under `costs.csv.lock.d`, waiting as long as it takes.
- **fal** (`common/fal.ts`): `falMock()`, `falMockDir()`, `mockCost()`, `countsAgainstCap()`, `falKey(deps.config.repo)`
  (env, else `<repo>/.env` unless MIDSTUDY_NO_DOTENV; never logged), `NO_KEY` (v1's 503 sentence), `falCall(endpoint,
  args, key, { timeoutMs })` → JSON or `FalError` with v1's sentences (HTTP error + first 400 bytes, nano-banana's
  "returned no image this time", "could not reach fal (…)", "… isn't JSON (…)"), `readMockAnswer(endpoint, name)`
  (`<mock dir>/<slug>/<name>`, null when missing), `mockFilePath(endpoint, url)` (`<mock dir>/<slug>/files/<basename>`,
  midstudy-add's rule), `mockSlug`, `logMockCall(endpoint, args)` (MIDSTUDY_FAL_MOCK_LOG, one
  `{"endpoint", "args"}` line per call), `download(url)` (data: URI or GET, `User-Agent: midstudy`, 120 s).
- **Fetch** (`server/src/fetch.ts`): `fetchImage(url, destDir)` → path of `download.<ext>`, or `FetchError` with v1's
  sentences (from-URL adds; then check the bytes with the kernel's `sniff`). For the product reader: `safeFetch(url,
  { budget: new Budget(20_000), maxRedirects: 5, maxBytes: 10 MiB, overflow: 'cut', decode: true, headers: { 'User-Agent':
  'midstudy/1.0 (product page reader)', Accept: …, 'Accept-Encoding': 'gzip, deflate', 'Accept-Language': 'en' } })` →
  `{url (final), status, headers (lowercased, a repeated header's last value), body, cut}`; a non-200 comes back without
  its body; feeds: `maxBytes: 2 MiB, sameOrigin: originOf(pageUrl)`, the same `Budget`. Failures are `FetchFailed` with a
  typed `failure.kind` (`bad-url`, `scheme`, `no-host`, `bad-port`, `dns`, `private`, `cross-origin`,
  `redirect-without-location`, `too-many-redirects`, `timeout`, `tls`, `network`, `too-large`, `encoding`, `decode`,
  `refused`) for the product's own sentences (v1 product_page.py `_get`). `check(status, headers)` stops before a 200's
  body. `insecureHTTPParser` is available for shops with odd headers. `PRIVATE`, `WEB_PAGE`: v1's sentences.
- **Jobs** (`server/src/jobs.ts`): `JobStore<J>` (`add`, `get`, `list` newest first, `update(id, patch)`, `position`; every
  answer a copy), `SerialQueue(run, failed, after)` (`push(id)`, one at a time in order, a throwing `run` goes to `failed`
  (v1's "the server failed to run …"), `after` always: release a reservation, remove a temp folder), `newJobId('c' | 'l')`.
- **Tools** (`server/src/tools.ts`): `runTool(argv, { cwd: deps.config.repo, timeoutMs })` → `exited {returnCode (minus the
  signal, as Python), stdout, stderr}` | `not-found {command}` (v1's FileNotFoundError) | `timeout` (the process group is
  SIGKILLed) | `spawn-error`; `deps.config.calib` / `deps.config.midstudyAdd` are already split; `lastJsonLine(stdout)`,
  `toolError(out.error, stderr, returnCode, 'midstudy-calib')` (v1 `tool_error`), `addError(stderr, returnCode)`,
  `outputLines`, `summaryOf`, `addMessage` (midstudy-add's job messages).
- **Strict mode** (`server/src/strict.ts`): answers are checked by the dispatcher. **Every JSON file you write goes
  through `writeJsonFile(file, data, schemaUri, style)`**: `scene.json` `midstudy/scene.schema.json`, layouts
  `midstudy/layout.schema.json`, `renders/<name>.json` `midstudy/api/render-meta.schema.json`, `trash.json`
  `midstudy/trash.schema.json#/$defs/scene`, `entry.json` `midstudy/trash.schema.json#/$defs/item` (style `ascii`: v1's
  `json.dump(indent=2)`), `library.json` `midstudy/library.schema.json` with style `utf8` (v1 `ensure_ascii=False`).
  `assertConforms(uri, data, what)` for anything else; `strictOn()`.
- **Files** (`common/files.ts`): `atomicWrite(file, bytes|text)` (v1 `atomic_write_bytes`: temp in the same folder, mode
  0600 as mkstemp made it, rename), `readJsonFile` (null when missing or unreadable), `makeTempDir(prefix)` (private, never
  under a served path), `jsonText(data, style)`.
- **Text and numbers** (`common/logic/*`): `pyRepr` (v1's `{name!r}` in messages), `fmtCost`, `pyFixed` (`f"{x:.2f}"`),
  `pyRound`, `pyFloatRepr`, `numText` (argv dims), `mbText` ("25.1 MB"), `pyStrip`, `pySplitlines`, `isoUtc(ms)`,
  `isoUtcMs` (a render's `created`), `utcStamp` (`YYYYMMDD-HHMMSS`), `utcDay`, `isSlug`, `slugify`, `posixName` (v1's
  `PurePosixPath(…).name` for X-Midstudy-Filename), `pyFloat`, `parseCsv`, `shlexSplit`. The media kernels
  (`core/js/node.ts`: `sniff`, `photoExt`, `stripJpeg`, `jpegFrame`, `pngSize`, `decodeImageDataUri`, `decodeMeta`,
  `zipPlan`, `isSceneName`, `compareNames`, …) are k-media's.

## Commands

```sh
nix develop -c npm ci && nix develop -c npm run build          # once
nix develop -c npm run test:server                              # 94 tests, ~25 s (differential, plumbing, server, http-diff, lock, fetch, infra)
nix develop -c node --test server/test/differential.test.ts     # 1238 cases against v1's own Python
MIDSTUDY_STRICT=1 MIDSTUDY_NO_DOTENV=1 MIDSTUDY_FAL_MOCK=fixtures/fal nix develop -c node server/src/main.ts --port 0 --daily-spend-usd 0
MIDSTUDY_SERVER=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:scenes-api
nix develop -c npm run check:tscert                             # 115/115; a tool error under load: run it again
nix develop -c node scripts/check-ownership.mjs server-core --base 979677c
```

## Measurements

- **Differential against v1** (`server/test/differential.test.ts` + `v1_oracle.py`, which imports `planner/serve.py` and
  calls v1's own functions, or the standard library v1 called): **1238 cases, every one equal** — pyFixed/round/fmt_cost/
  repr/`:g`/num_text/mb_text over 47 numbers (ties like 0.125 and 2.675 included), repr/strip/splitlines over 23 strings
  (quotes, controls, NBSP, U+2028, soft hyphen, emoji, BOM), shlex (21), CSV read and write, `_append_cost` (6),
  `LibraryService.spent` (6), `reserve`'s 402 (9), urlsplit/hostname/port over 29 URLs (brackets, zones, bad ports),
  urljoin (4 bases × 28 references, RFC 3986's examples), unquote (17, invalid UTF-8), parse_qs (10), ipaddress and
  `address_blocked` over 55 addresses (every v4-in-v6 form), `fetch_allowed` (8), the kernel's `hostName` vs v1
  `host_name` (13), `slugify` (11), `PurePosixPath.name`, the .env reader, `last_json_line`, `tool_error`, iso stamps,
  `guess_type` (18), `send_error`'s page, and argparse over v1's parser (31 command lines, errors included).
  First run: 11 differed (my oracle passed ints where v1 sees floats; IPv6 zones; argparse keeps `--` in its message);
  all fixed in the port or the oracle.
- **v1 and v2 side by side over HTTP** (`server/test/http-diff.test.ts`): 41 GET and HEAD targets (planner, folders,
  redirects, library, scenes, renders, repo files, `.env`, encoded and dot-segment spellings, /api fallbacks, spend),
  16 mutations × 5 gate variants, 12 raw framing exchanges: same status, content type, JSON body, nosniff and Location.
  One timing difference found and kept (below: a 403 for a foreign Host with two Content-Lengths).
- **Plumbing** (in-process, test routes): 46 tests — framing (two CL; `²`, `+5`, `-1`, `1e3`, `0x10`, 16 digits, empty →
  400; CL+TE → 400), early 413 answered in < 1 s with "25.1 MB" and the close within the drain, 411 for chunked, Expect
  without 100 for a refusal and with it for an accepted upload, 408 after the socket timeout (2 s here) with v1's
  sentence, idle close, keep-alive, the gate for every mutating method, Host spellings, the fallbacks, error mapping,
  JSON bodies (empty, NaN, 2000-deep, BOM), headers, strict mode for answers and files.
- **Server** (`node server/src/main.ts`): startup refusals (allowed-host URL exit 2, costs-file exit 1, negative/nan cap,
  empty --calib/--midstudy-add, unknown or ambiguous flags, -h), the static allowlist (E1's W4 spellings, its verify-round-1
  list, library_api.sh's W4 tricks, case variants, `%252e`), MIME, 301/302, If-Modified-Since → 304, spend in strict
  mode, all 26 stubbed routes 501 past the gate and 403 before it.
- **Lock across processes**: 4 processes × 25 takes, counter 100 (no lost update); Busy after the wait while a live
  process holds it; a killed holder's lock reclaimed at once; an exited holder's reclaimed; an old one (2 h) reclaimed; a
  young one on another host not; no owner.json held for the grace then reclaimed; a release never removes another's lock;
  5 concurrent `appendCost` → header + 5 rows, `costs.csv.lock` present.
- **Fetch**: 9 tests against a local web server and a canary port — v1's 15 image sentences, W3 private addresses in 11
  spellings (decimal `2130706433`, `[::ffff:127.0.0.1]`, `0.0.0.0`, metadata, tailnet, fe80) refused with the canary never
  connected, the exemption exactly one host:port, gzip/deflate (zlib and raw), the cut, too-large, non-200 without body,
  5 redirects then too-many, cross-origin, a trickle stopped by the budget.
- **Performance, A/B interleaved** (`evals/out/probe/perf.mjs`, scratch: each round starts v1, v2 and v2 with strict
  mode in turn; one connection per request, as a fresh client makes them): at load 8, 9 rounds, medians: start to the
  first answer v1 94 ms, v2 88 ms, v2 strict 93 ms (it loads the 558 KB validators); `GET /api/spend` p50 v1 0.31 ms,
  v2 0.30 ms; `GET /planner/dist/app.js` (349 kB) p50 v1 0.46 ms, v2 0.45 ms. Before the change below, at load 21:
  static 0.77 ms against v1's 0.55 ms with a read stream per file; files up to 4 MiB are now read in one call and sent in
  one write (0.74 vs 0.88 ms at that load). Keep-alive, which v1 didn't have, comes on top for browsers.
- **Evals** (`MIDSTUDY_SERVER=next` → `MIDSTUDY_STRICT=1`, through the eval lock): see "Evals with stubs" below.
- **TScert**: see "TScert" below.

## Evals with stubs

`MIDSTUDY_SERVER=next` (the harness then sets `MIDSTUDY_STRICT=1`), legacy CLI, through `scripts/eval-lock.mjs`:

- **eval:scenes-api (E1): 5/76**, then a harness exception. Passed: E1.01 build, E1.02 the server starts with
  `--scenes-dir`, `--calib` and scratch dirs, E1.20 (dropped jobs never ran: vacuous), E1.74 `/scenes/<L>/lighting.json`
  is 404, E1.76 the repo's own data untouched. Every other check needs the scenes routes (501 here); E1 waits 60 s per
  scene that never calibrates and then reads a `scene.json` that was never made (`ENOENT … scenes/_/scene.json`, E1.75 "no
  harness exception"), so **its framing, W1, W2, W4 and static sections, which come last, are never reached** with stubs.
  To check them anyway, `evals/out/probe/e1-infra.mjs` (scratch, not committed) runs E1's route-independent checks copied
  as they are against the next server: **51/51** — W1 on all 9 mutating scene/layout/render routes, W2's five Host
  checks (the three loopback ones answer 501 past the gate where E1 wants 200 from the real route), W2 for static and
  mutations, the 19 W4 `/scenes/` spellings, the 30 private-path spellings of verify round 1, the planner and
  library.json served with nosniff, two Content-Lengths → 400, three non-loopback Host spellings → 403, `²` and `¹` →
  400 without a Python exception, no Host → 403, `GET /api/spend`, and the `--allowed-host` and `--costs-file` startup
  refusals on `main.ts`. E1's early-413, 408-stall and "localhost works" checks need the scenes route (they are covered
  with test routes in `server/test/plumbing.test.ts`).
- **eval:library (E7): 1 check, then stops**: `node scripts/build.mjs builds the planner` ok, then "node
  server/src/main.ts did not answer GET /api/library": `evals/library_api.sh` starts the server by polling `curl -sf
  /api/library`, a stub (501), so none of its checks (W1–W4, the spend cap, L8–L11) run before server-library's route
  exists. Its W2/W3/W4 rules are covered by `server/test/{server,fetch,http-diff}.test.ts`.
- **The planner bundle in headless Chrome** (`evals/out/probe/planner-smoke.mjs`, scratch, through the lock): all 10
  static requests 200 with their types (index, 5 stylesheets, `dist/app.js` and its chunks), `window.midstudy` exists;
  its API calls get 501.

## TScert

`nix develop -c npm run check:tscert`: **115/115 certified, all 115 baselined still certify** (15 files, 17 s, at load
7). `tscert/baseline.json` holds all 115: every function and module initialization of `server/src/logic/` and
`common/logic/`. The first run certified 107/111; the refusals, and three more in the reshaped `parseCli`, were rewritten
around patterns tscert/README.md lists: a named function passed as `map`'s callback, an object spread, a write at an
array index, `concat`, and a `for…of`, a closure and an index read over an array of a union type. Everything in
`server/src/logic/` and `common/logic/` is pure (no Node, no DOM); `String.prototype.normalize` (in `slugify`),
`String.fromCodePoint` (the UTF-8 decoder), regexes with Unicode property escapes (`pyRepr`) and `BigInt` (`pyFixed`
above 1e21) certify. Under this machine's load (20–48 during the session) TScert's verifier steps timed out ("tool
error", no verdict) even with a 900 s step limit, on units that certify in seconds when it is quiet; at load 7 the
default 180 s gave the verdicts above. A gate that meets a tool error should run again.

## Decisions and deviations from v1

Every one is either invisible to the evals or stricter; the tests above pin each.

- **Keep-alive.** v1 was `HTTP/1.0` (one request per connection). v2 keeps HTTP/1.1 connections alive (the planner's
  ~25 requests and E17's latency gain); framing stays safe because v1's order is kept: an unread body is read and dropped
  (≤ 256 MiB, ≤ 60 s) before any answer, an early 411/413 closes, Node frames by Content-Length.
- **Node's parser refuses first.** Two Content-Lengths, a non-digit one and CL+TE never reach a handler: they arrive as
  `clientError` and get v1's JSON answers, after v1's Host check read from the refused bytes. Differences: CL+TE is `400`
  (v1 read either), **two `Host` headers are `403`** (v1 used the first; the kernel's rule), a path with raw spaces or
  non-ASCII bytes is a `400` page (Python accepted some), a header block over 64 KiB is `431`. A foreign Host with two
  Content-Lengths gets its 403 at once (v1 first waited for the first length's body, up to 30 s).
- **Expect: 100-continue**: v1 never sent `100 Continue` (curl waited 1 s); v2 sends it when a handler reads the body,
  and answers a refusal at once, closing the connection (the client never sends the body).
- **Timeouts**: one read may wait MIDSTUDY_SOCKET_TIMEOUT (30 s), as v1; the early drain's reads wait min(left of 5 s,
  the socket timeout), as v1 (so with `MIDSTUDY_SOCKET_TIMEOUT=2` it closes after 2 s); an idle connection closes after the
  socket timeout; a request being handled is never cut (v1 had no write-free timeout either); headers must arrive within
  Node's 60 s (v1 had no total limit for a slow head); a client that stops reading an answer is cut.
- **Tools**: a timeout kills the tool's whole process group (v1 killed only the direct child: `uv run` could leave
  Python running); output is decoded with replacement (v1's `text=True` raised on invalid UTF-8).
- **Startup**: `--daily-spend-usd nan` or `inf` is refused (v1 accepted `nan`, which switched the cap off); an empty
  `--midstudy-add` is refused (v1 would have run the upload itself as the command); a bad `--calib` quoting is argparse's
  exit 2 with Python's sentence (v1 crashed with a traceback); a bad MIDSTUDY_SOCKET_TIMEOUT exits 1 (v1 crashed at
  import); `--host` may be IPv6 (v1's HTTPServer was IPv4-only). SIGTERM is graceful (v1 died at once).
- **Spend**: a `cost_usd` that parses as `nan` or `inf` is skipped (v1 added it, poisoning the day's total).
- **Fetch**: a URL urlsplit refuses (`http://[::1`) is a 400 "that link isn't a valid web address" (v1: a 500 with the
  ValueError); DNS is bounded by the 20 s budget (v1's image fetch had no DNS timeout); a non-ASCII host is IDNA-encoded
  with UTS #46 (Python: IDNA 2003); TLS failures name Node's code (`CERT_HAS_EXPIRED`) where v1 named OpenSSL's reason.
- **JSON**: answers are JavaScript's JSON (`2` where Python wrote `2.0`, UTF-8 where it escaped); files keep v1's
  layouts (`jsonText`: indent 2, `ensure_ascii` for v1's `json.dump` files) but integral floats still lose their `.0`
  (`80.0` → `80`; JSON readers see the same number; `library.json` is tracked in git, so its first v2 write shows that
  diff). Parse-error sentences are JavaScript's after v1's prefix (`body is not valid JSON: …`).
- **Static**: v1 served a file asked for with a trailing slash (`/planner/index.html/` → 200: its translate_path dropped
  the slash), and v2 does too (k-media's note suggested a 404; v1 wins). `.map` stays application/octet-stream as v1.
  The HTML error page is http.server's, byte for byte.
- **Locks**: a directory lock instead of flock (Node has none), so a v1 tool and a v2 tool don't exclude each other during
  the switch. v1's `.lock` and `costs.csv.lock` files are still created (E7 checks `costs.csv.lock` exists).

## Contract vs v1

No disagreement found in what this track ported. The contract's §2.8 One writer now describes the v2 lock; §2.9
Framing names v2's two extra refusals. E1's own startup checks (lines 712, 719) still spawn `planner/serve.py` directly
(integration's request from f-contract); `server/test/server.test.ts` checks the same refusals on `main.ts`.

## Requests

- **server-scenes / server-library / product**: build on the seams above; replace the stubs' handlers, keep the
  `routes` export and the patterns' order. Use `writeJsonFile` for every JSON file (strict mode), `withLibraryLock`
  (60 s) for library writes, `appendCost` for cost rows, `deps.spend` for money, `fetchImage`/`safeFetch` for URLs,
  `runTool` for tools, `HttpError` for v1's 400 sentences. The library route must answer `GET /api/library` before E7
  can even start (`evals/library_api.sh` waits for `curl -sf /api/library`).
- **pipeline**: implement the same lock (contract §2.8 One writer v2) — ideally by importing `common/lock.ts` and
  `common/costs.ts` (`appendCost`, which also creates `costs.csv.lock`, which E7 checks), `common/fal.ts` (mock rules,
  key, `falCall`) and `common/files.ts`. That needs `common/**/*.ts` in `tsconfig.pipeline.json`'s `include` (pipeline
  owns it) and stays within knip's project (added here).
- **integration (Phase 3)**: switch the server and `midstudy-add` together (v1's flock and v2's lock directory don't
  exclude each other); E1 lines 712/719 → `serverCommand()`; record v2 with
  `MIDSTUDY_SERVER=next node contract/tools/record-examples.mjs --check` once the routes exist; `npm run test:server` into
  `npm run check` (or a gate), and delete `server/test/v1_oracle.py` and the two differential tests with
  `planner/serve.py` (they skip themselves when it's gone).
- **f-toolchain / gates**: under heavy load (20–48) `check:tscert` reported tool errors (verifier step timeouts, even at
  `MIDSTUDY_TSCERT_STEP_LIMIT=900`) on units that certify in 15–50 s when the machine is quieter: retry before reading a
  tool error as a regression.

## Left

- The routes (stage B): every /api route but `GET /api/spend` answers 501.
- `check:py` and `check:rust`/`fuzz`/`proofs` were not run by this track (no Python, Rust or Lean changed).
- Not done here, on purpose: the calibration worker client (§4.3 Worker: the server's side) belongs with the scenes
  routes (server-scenes); `runTool` is one-shot. A JSON parser that keeps `80.0` as written (see Decisions) was not
  built.
- The HTTP keep-alive and parser differences above are pinned by tests but have not been through the browser evals with
  real routes yet (Phase 3).
