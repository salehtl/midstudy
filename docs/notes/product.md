# Product page reader

## v2 (Phase 2 track `product`, branch `v2-product`, 2026-11-06)

v1's `planner/product_page.py` (2,219 lines; contract §2.11 and §2.9 Page fetches) ported to v2: the size reading in
Rust (linear time), everything else in strict TypeScript on Node 22, behind `POST /api/library/product` in the v2
server. Branch `v2-product` from `v2-server-core` at `22eb9b1`. Everything below was run on rabbit on 2026-11-06
(03:40–05:30), fal mocked (`MIDSTUDY_FAL_MOCK=fixtures/fal`, `MIDSTUDY_NO_DOTENV=1`, no FAL_KEY anywhere), headless
Chrome from `$PUPPETEER_EXECUTABLE_PATH` only, never `.env`, never `fixtures/photos/`. Nothing was pushed.

### What exists

| Path | What |
|---|---|
| `core/crates/product/` (`midstudy-product`) | The size rules: v1's `NUM`, `UNITS`, `_IN_U`, `_FT_U`, `_ITEM`, `_ORDER_KEY`, `_JOIN`, `_TAIL_UNIT`, `_THICK`, `_HAS_SIZE` and their callers (`_num`, `_unit`, `_axis`, `_fmt`, `_items`, `_chains`, `_line_chains`, `_make_reading`, `_map_axes`, `_parse_size_text`, `_single` on text, `_text_readings`, `_context`, `_window`, `_unit_hint`, `_thickness`, `_quote_numbers`, `_llm_text`, `_neutralize`, `_category_of`, the word patterns `_DISTRACT`/`_INTRO`/`_SAMPLE`/`_SIZE_OPT`/`_SIZE_WORDS`/`_ROBOT`), the merge of readings within 0.5 cm / 1 %, the rug thickness and `Reading.out()`. `api` is its JSON face. `#![forbid(unsafe_code)]`, and the byte-parser denials (`indexing_slicing`, `arithmetic_side_effects`, `cast_possible_truncation`). |
| `core/crates/product/src/tables.rs`, `tools/gen_tables.py` | Python 3.12's `\w`, `\d` (with digit values) and `\s` (Unicode 15.0), generated from the Python v1 ran on |
| `core/crates/product/tests/` | `properties.rs` (proptest: nothing panics, spans in order, readings in range, `_fmt` round-trips), `adversarial.rs` (linear time on 14 adversarial lines at 100k and 800k characters; `--ignored`) |
| `core/crates/product/fuzz/` | cargo-fuzz targets `size_reader` (every reader on arbitrary text, with invariants) and `size_json` (the JSON face on arbitrary input), its own workspace and lock, a 12-line seed corpus |
| `core/crates/wasm-product/` | The `#[wasm_bindgen]` layer: `call(op, json)`, `has_size`, `matches`, `category_of`. `npm run build` builds it into `build/wasm/product/` (Node ESM; no build change was needed) |
| `server/src/product/sizes.ts` | The typed face of `build/wasm/product/` (every answer checked, no casts; v1's KeyError as `PyRaised`), and the worker thread for the reads over a whole page (`size-worker.ts`) |
| `server/src/product/route.ts` | `POST /api/library/product`: v1's body checks and sentences, then `readProduct` |
| `server/src/product/read.ts` | v1's `read`, `_read`, `_read_pasted`, `_canonical`: every way a read ends as (status, body), never a throw |
| `server/src/product/pagefetch.ts` | v1's `_get` on server-core's `safeFetch` (5 redirects, 20 s for the page and its feeds, 10 MB cut, feeds 2 MB to the page's origin, gzip/deflate, the honest User-Agent, no cookies) with v1's sentence for each failure |
| `server/src/product/html.ts` | parse5's spec tokenizer driven as a SAX parser (raw-text states switched as the tree builder would, scripting off) and v1's `_Page` handlers on top; `textLines` (v1 `_text_lines`) |
| `server/src/product/doc.ts`, `layers.ts`, `images.ts`, `scripts.ts`, `extract.ts`, `llm.ts`, `decode.ts`, `urls.ts`, `errors.ts` | v1's `_Doc` and `_jsonld_nodes`; the JSON-LD, microdata, Shopify, WooCommerce layers and `_link_variant`; `_Images`; `_script_strings`, `_literals`, `_js_unescape`; `_extract` and `_feeds`; layer 4 (`_run_llm`, `_llm_json`, `_llm_sizes`, `_mock_answer`); `_charset`/`_decode`; `_target`/`_public_url`; the error sentences and the 10 s deadline |
| `server/src/product/logic/` | Pure modules: `pyjson.ts` (Python's `json.loads`: ints as bigint, ordered dicts, NaN/Infinity, `strict=False`, the RecursionError depth; iterative), `py.ts` (Python truthiness, `str()`/`repr`, `_as_list`), `text.ts` (`_squash`, `_collapse`, code-point lengths and slices, Unicode digit values), `unescape.ts` (`html.unescape`); `tscert.json` (TScert's project for them) |
| `server/src/product/entities.ts`, `charsets.ts`, `tools/gen_*.py` | Generated from Python 3.12: `html.entities.html5` and html's invalid-reference tables; codecs.lookup's names and every single-byte codec's decoding table |
| `server/test/product/` | `v1_oracle.py` (v1's own module as an oracle, JSON lines), `sizes.test.ts`, `logic.test.ts`, `pages.test.ts` (below), `oracle.ts` |
| `package.json` (shared-append) | `test:product` |
| `core/Cargo.lock` (shared-append) | the two crates (no new external package) |

### How behaviour was kept

- **Patterns with lookarounds are matched by hand, in v1's order.** The regex crate has no lookaround, and its
  leftmost-first semantics only equal Python's for the plain patterns. So `NUM`, `UNITS`, `_ITEM`, `_ORDER_KEY`,
  `_THICK` and `_HAS_SIZE` are hand matchers: at each position they try v1's alternatives in v1's order, and where `re`
  would backtrack into an earlier choice (a number before a required unit, a lookahead that fails after a unit) they
  yield every end it would try, in the order it would try them. Digit runs are bounded in v1's patterns (7, 4, 3), so
  each position costs a bounded number of steps plus the whitespace runs next to it. Comments in `item.rs` say which
  backtracking choices can't change the result and why.
- **Plain patterns run on the regex crate with Python's classes**: `\s` adds U+001C–U+001F; under `re.I` every `i` is
  `[iıİ]` (Python folds both onto i; the regex crate folds ſ and K as Python does); `\b` runs on a view of the text in
  which each character whose `\w`-ness differs between Python and the regex crate (², ½, combining marks…) is swapped
  for a same-length stand-in, so offsets stay the text's own. A test checks the stand-in logic against the regex
  crate's own `\b` for every code point.
- **Code points, as Python indexed**: positions, quote and label cuts (`[:200]`, `[:80]`), `_window` and every length
  are code points in Rust (`Vec<char>`) and in TypeScript (`cpLength`, `cpPrefix`).
- **v1's exceptions stay exceptions**: `_KEY_AXIS[tok.lower()]` on `wıdth` (which `re.I` matched) raised KeyError in v1
  and answered the generic 422; the Rust returns `PyError::KeyError` and the reader answers the same 422. The JSON-LD
  helpers raise where v1 raised (an unhashable `@id`, urljoin's ValueError, `round(inf)`).
- **JSON is Python's** (`logic/pyjson.ts`): v1's answers depend on `str(8)` vs `str(8.0)`, `isinstance(True, int)`,
  dict order, NaN and `strict=False`, so JS's JSON.parse is never used on page or feed data.

### Commands

```sh
nix develop -c npm ci && nix develop -c npm run build                 # once (builds build/wasm/product/)
nix develop -c npm run test:product                                   # the three differential tests below, ~1 min
MIDSTUDY_PRODUCT_CASES=20000 MIDSTUDY_PRODUCT_SEED=7 nix develop -c node --test server/test/product/sizes.test.ts
(cd core && nix develop ..#default -c cargo test -p midstudy-product)                            # unit + proptest
(cd core && nix develop ..#default -c cargo test --release -p midstudy-product --test adversarial -- --ignored --nocapture)
(cd core/crates/product && nix develop ../../..#nightly -c cargo fuzz run size_reader -- -max_total_time=120)
nix develop -c node scripts/tscert-ratchet.mjs --project server/src/product/logic/tscert.json \
  --files server/src/product/logic/text.ts,server/src/product/logic/pyjson.ts,server/src/product/logic/py.ts,server/src/product/logic/unescape.ts,common/logic/pyfmt.ts
MIDSTUDY_SERVER=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:product
nix develop -c node scripts/check-ownership.mjs product --base v2-server-core
```

### Measurements

**Differential, against v1's own Python** (`server/test/product/v1_oracle.py` imports `planner/product_page.py`):

| Test | Cases | Result |
|---|---|---|
| `sizes.test.ts`: generated size strings (numbers, fractions, units, labels in six languages, order keys, ranges, distractors, ſ K ı İ ², Arabic-Indic digits, U+001C, NBSP) through `_line_chains`, `_items`, `_HAS_SIZE`, `_quote_numbers`, `_parse_size_text` (5 contexts), `_category_of`, the word patterns, `_text_readings`, `_unit_hint`, `_thickness`, `_llm_text`, `_num`, `_unit`, `_axis`; plus option-like lines (a unitless size with little around it) | 172,097 requests per seed; seeds 1, 2, 3, 5, 7, 11, 12, 21 and the default | **0 differences** on every seed. Not vacuous: per 20,000 strings, ~6,200 lines with a chain of 2–3, ~2,000 size texts read, ~3,200 line groups with readings, ~320 thicknesses, ~400 unitless warnings, and 3–10 of v1's KeyErrors reproduced |
| `logic.test.ts`: `html.unescape`, `_squash`, `json.loads` (strict and not; ints vs floats, key order, NaN, BOM, nesting at 9,000 and past 10,000 levels), `_loads_lenient`, `_literals`, `_js_unescape`, `SYSTEM_PROMPT`, and `_charset` + `_decode` on random page bytes declared in 19 ways (UTF-8 spellings, Latin-1, Windows-1252, ASCII, KOI8-R, CP1251, ISO-8859-2, Mac Roman, UTF-16, UTF-8-SIG, unknown, non-text codecs, none; header or `<meta>`) | 19,005–57,005 requests per run, seeds 1, 2, 3 and the default | **0 differences** (after one fix it found: `\u`/`\x` without hex digits, which v1 drops) |
| `pages.test.ts`: v1 (`planner/serve.py`) and v2 (`node server/src/main.ts`, strict mode) side by side on every synthetic shop page of `fixtures/product-pages/manifest.json` (with and without `llm: false`), the 60,000-character page, every fixture page pasted three ways (with a link, with the bookmarklet's first line, with neither), every refused link, 12 bad bodies, and the slow and trickling pages | 211 reads (v1: 130 × 200, 55 × 400, 26 × 422) and the cost rows | **0 differences**: same status, same JSON body key for key (numbers exactly), same cost rows |

**Evals** (`MIDSTUDY_SERVER=next`, so `MIDSTUDY_STRICT=1`; through `scripts/eval-lock.mjs`):

| Eval | Result |
|---|---|
| `eval:product` (E14) | **407/409**, twice (before and after the last changes). The two failures are the library stubs, not the reader: E14.330 "GET /api/library answers within 1 s meanwhile" (HTTP 501 in 0.00 s) and E14.379 "reads start no library job" (GET /api/library/jobs is 501). Everything else passes, among them the CPU-heavy page (12,000-digit run and 20,000 escaped quotes: **0.00 s**, `/api/spend` within 0.00 s meanwhile; v1's limit is 8 s) and every contract-shape check in strict mode |
| `eval:product` (E14), hybrid (scratch `evals/out/product-scratch/product_extract_hybrid.mjs`: E14 verbatim, each server v1 with `POST /api/library/product` and `GET /api/spend` proxied to v2) | **409/409**; 108 requests answered by v2 |
| `eval:product-ui` (E15) | **6/9**: E15.04 needs `POST /api/scenes` (501 here) and E15.06/08 need the library sheet; the product route itself answered (E15.03) |
| `eval:product-ui` (E15), hybrid (scratch `product_ui_hybrid.mjs`: E15 verbatim, v1 serving everything but `POST /api/library/product`, which a proxy sends to v2) | **135/135**, twice; 23 product reads answered by v2 through the real form (desktop and phone: rug sizes, Flat rug, pictures, Make through from-URL, the blocked page, the model's cost note, Paste the page) |
| `eval:product-live` offline | **nothing to replay**: `fixtures/pages/` (git-ignored) doesn't exist in this worktree, so all 10 golden pages are SKIP; 3/3 harness checks pass. (Its `--live --llm` mode spawns `planner/serve.py` directly, line 47: integration.) |

**E17 product_read** (E17's own method: `POST /api/library/product`, `llm: false`, every manifest page but the two
20 s ones, p50/p95/max over the 55 pages per run, median of 5 runs after a warm-up). E17 itself can't start the v2
server on this branch (its main server seeds the library and scenes), so a scratch copy of its product suite
(`evals/out/product-scratch/perf_product.mjs`) ran v1 and v2 **A/B interleaved (ABBA), exclusive** under the eval lock,
at load 5:

| Metric | v1 | v2 | v1/v2 |
|---|---|---|---|
| product_read_p50 | 1.22 ms | 1.07 ms | 1.15× |
| product_read_p95 | 3.10 ms | 2.87 ms | 1.08× |
| product_read_max | 1783 ms (`huge`) | 596 ms (`huge`) | 2.99× |

The committed baseline (`evals/perf/baseline.json`, v1) has p50 1.1 ms and max 1748 ms (`huge`), the same picture.
REFACTOR §4.1's target is "≥ 2× on p95, no page over 1 s": **no page over 1 s is met** (the slowest is 596 ms);
**2× on p95 is not**, because the p95 page is a 3 ms read where the time is two HTTP round trips and the pages server,
not the reader (v1's was already 3.1 ms); the CPU-bound pages are 3× faster (`huge`), and the next ones are `gzip-bomb`
(v1 184 ms, v2 241 ms: the gzip stream and 10 MB of whitespace) and `digits` (v1 4.2, v2 2.3 ms).

**Adversarial pages** (scratch `evals/out/product-scratch/adversarial_pages.mjs`: a 9 MB page each, `GET /api/spend`
pinged every 100 ms during the read):

| Page | v1 | v2 (final) |
|---|---|---|
| E14's digits page | 200 in 0.01 s | 200 in 0.05 s, ping ≤ 0.00 s |
| 9 MB of `1 ` in one paragraph (v1's `_text_readings` is quadratic on it) | **no answer in 60 s** (client gave up), ping up to 3.16 s | 200 in 3.5 s, ping ≤ 0.53 s |
| 9 MB of `1x1 ` (unitless chains) | not run | 200 in 3.4 s, ping ≤ 0.36 s |
| 9 MB of `W 1 cm ` | not run | 200 in 3.2 s, ping ≤ 0.64 s |
| 9 MB of `<p>W 80 cm</p>` (many lines) | **422 "the page took too long to read"** after 10 s | **200 in 2.0 s**, ping ≤ 0.03 s |
| a 9 MB script of size strings | 200 in 3.5 s | 200 in 1.6 s, ping ≤ 0.12 s |

Before the worker thread (below) the same pages held v2's event loop for 1.1–2.1 s at a time.

**Rust**: `cargo test -p midstudy-product`: 18 unit tests and 5 proptest properties (512 cases each), plus the
adversarial test in release: every reader on 14 adversarial lines grows by 7.4–8.7× for 8× the input (linear is 8,
quadratic 64), the slowest 800,000-character line read by all readers in 475 ms natively. `check:rust` (whole
workspace): ok, fmt, clippy `-D warnings` (pedantic, the workspace lints), 157 tests. **Fuzz** (nightly shell, address
sanitizer): `size_reader` 120 s, 231,129 runs, no crash; `size_json` 120 s, 2,061,344 runs, no crash. **Miri**: no
undefined behaviour (below).

**TypeScript gates**: `check:types` ok, `check:lint` ok (60 files), `check:dead` ok (knip), `check:ownership product
--base v2-server-core` ok. `npm run test:server`: 93/94; the one failure is server-core's own test that every stage-B
route still answers 501 (`server/test/server.test.ts`, the `POST /api/library/product` entry), which this track
replaced on purpose (request below).

**TScert** (`--project server/src/product/logic/tscert.json`, since tscert/config.json has no area for
`server/src/product/logic/` yet): **15/37 units certify**: `text.ts` 9/9 (`squash`, `squashCell`, `collapse`,
`collapseWs`, `cpLength`, `cpIndex`, `cpPrefix`, `digitsValue`, `(init)`), `unescape.ts` 6/6 (`pyUnescape`, `refAt`,
`replaceRef`, `codeOf`, `isDigit`, `isHex`), after rewriting `squash` without `filter`, `pyUnescape` without a
`replace` callback, and dropping `Number.NaN`/`Number.NEGATIVE_INFINITY`. Refused: `pyjson.ts` (11) and `py.ts` (11),
all on "unguarded alias cycle through PyValue: a recursive alias must reach itself through an object, array, tuple
or function type": `PyValue` recurses through `ReadonlyMap<string, PyValue>`, which TScert doesn't count as an object
type; plus `pyReprValue` (a named function passed to `map`) and `truthy` (a read of `size` on an array-or-map union).
Not in `tscert/baseline.json`: a baseline entry outside config.json's areas would fail check:tscert as "gone".

### Decisions and deviations from v1

Every one is either invisible to the evals and the differential tests or deliberate; each is a v1 edge case.

- **HTML is parse5's** (as asked: spec-compliant tokenizing), driven as a SAX parser with v1's handlers on top, not
  html.parser. Differences, all on malformed or unusual markup: attribute values decode entities by the spec's rules
  (Python's `unescape` also decoded `&copy=` inside an attribute); a repeated attribute keeps its first value (v1: the
  last); `<title>` and `<textarea>` hold text only (v1 parsed tags inside them); `<iframe>`, `<noembed>`, `<noframes>`,
  `<xmp>` are raw text; CR LF becomes LF; `<image>` is `<img>`. `<noscript>` content stays markup (scripting off), so
  the `<img>` a lazy-loading shop puts there is still seen, as in v1. `<x/>` is a start and an end tag as html.parser
  read it, except for raw-text elements, whose content the tokenizer is then in.
- **Charsets**: UTF-8, Latin-1, ASCII, UTF-16/32 and all of Python's single-byte codecs decode with Python's own tables
  (generated); the multi-byte East Asian codecs go through the WHATWG decoder of the same name; a codec Python has and
  neither has (cp437 is a single-byte one, so covered; UTF-7, say) decodes as UTF-8.
- **Linear where v1 was quadratic, with the same answers**: v1's `_text_readings` computed each chain's context from
  the last labelled size and rebuilt the rest of the line for every unitless chain, quadratic on a line of many sizes
  (above: no answer in 60 s). v2 computes the context only where v1 read it, and counts the rest's words in constant
  time after one pass over the line; the differential tests pin that the answers are v1's.
- **Pages v1 gave up on now read**: with the reader linear, a page v1 answered "the page took too long to read" (10 s)
  can now be read (the 9 MB many-lines page: 200 in 2 s). The 10 s bound still holds, harder than v1's: the reads over
  a whole page run in a worker thread above 200,000 characters (`sizes.ts`), bounded by the read's remaining time (a
  worker still busy at the deadline is stopped, the jobs queued behind it start again on a new one), so no single huge
  line can hold the server; script strings and the HTML yield to other requests every 20 ms / 64 KB.
- **Recursion limits**: v1's `json.loads` raised RecursionError near 10,000 levels (9,997 measured at top level; the
  exact level moves by a few with the caller's depth); v2 refuses past 9,997. v1's `_text`, `_single` and
  `_walk_items` recursed in Python (limit 1,000 frames); v2 recurses in JS, which overflows only near 10,000. Both end
  in the generic 422 when they overflow; between ~1,000 and ~10,000 levels of nesting in one JSON value v1 failed and
  v2 reads.
- **Numbers**: a JSON integer beyond 2^53 used as a width or pixel size is a float in v2 (Python kept it exact). The
  live (non-mock) model answer is read with JSON.parse (server-core's fal client), so `usage.prompt_tokens` written as
  `1610.0` counts as an int (v1: not). Lone surrogates crossing into the wasm become U+FFFD (v1 kept them; they only come
  from `\uD800`-style escapes in script strings).
- **Feeds**: server-core's safeFetch checks a hop's origin before its URL, so a feed redirect to another origin that is
  also malformed says "redirects to another site" (v1: "isn't a valid web address"). A feed whose gzip is broken still
  ends the whole read with the generic 422, as v1's uncaught zlib.error did.
- **Page fetches** use `insecureHTTPParser` (v1's http.client read odd headers); DNS and TLS failures are server-core's
  (its notes).
- **`core/js/product.ts` doesn't exist**: the typed face is `server/src/product/sizes.ts`. A file in `core/js/` must
  be in a tsconfig's include to pass check:types and check:lint (composite projects; ESLint's project service), and no
  tsconfig is this track's. Request below.

### Contract vs v1

- §2.11 says "Readings within 0.5 cm on every axis are one candidate"; v1 merged within 0.5 cm **or 1 %** (one size in
  two units rounds differently). v1 kept; the contract's sentence could add "or 1 %".
- §2.11 names `planner/product_page.py` as the extractor; in v2 it is `server/src/product/` and
  `core/crates/product/` (integration updates the sentence at the cutover).
- No other disagreement found: every sentence the evals and the contract name is v1's, byte for byte.

### Miri

`cargo miri test -p midstudy-product --lib --tests` (nightly shell, rustc 1.100.0-nightly 2026-08-21,
`MIRIFLAGS=-Zmiri-disable-isolation`, `PROPTEST_CASES=2`, sysroot in `build/miri/`): **no undefined behaviour**. Unit
tests 17 passed, 1 ignored under Miri (`regex_word_matches_regex_syntax`, every code point) in 648 s; the five proptest
properties passed in 809 s (the regex crate's compilation under Miri is most of it); the adversarial test is ignored
as everywhere. 24 min of CPU in all, which is why it isn't in a routine gate.

### Requests

- **f-toolchain / gate**: add `{ "glob": "server/src/product/logic/**/*.ts", "project": "server/src/product/logic/tscert.json" }`
  to `tscert/config.json` (or widen `tscert/tsconfig.server.json`'s include), then `node scripts/tscert-ratchet.mjs
  --update` adds the 15 units that certify to the baseline. The ratchet's `inputDirs` must then also copy
  `common/logic` (the product logic imports `common/logic/pyfmt.ts`; today only a job inside it makes it copied).
- **integration (Phase 3)**: move `server/src/product/sizes.ts` (and `size-worker.ts`) to `core/js/product.ts` if the
  plan's layout is wanted, and add it to `tsconfig.server.json`'s include (as server-core did for `core/js/node.ts`).
  Drop `['POST', '/api/library/product']` from the 501 list in `server/test/server.test.ts` (server-core's test of the
  stubs). Run `eval:product` and `eval:product-ui` with `MIDSTUDY_SERVER=next` once server-library and server-scenes
  have landed (E14.330, E14.379 and E15.04–08 need their routes; the hybrid runs above pass in full). Update §2.11's
  "the extractor is `planner/product_page.py`" sentence. Delete `server/test/product/v1_oracle.py` with v1 (the three
  differential tests skip themselves once `planner/product_page.py` is gone). `knip.json` can drop `parse5` from
  `ignoreDependencies` (now used; a hint, not a failure).
- **kernels-hardening / whoever owns `core/miri.txt`**: add `midstudy-product` (MIRIFLAGS `-Zmiri-disable-isolation`,
  a small `PROPTEST_CASES`; the every-code-point test is `cfg_attr(miri, ignore)`).
- **main session**: `eval:product-live` needs `fixtures/pages/` (git-ignored, absent in worktrees) to replay anything.

### Left

- E14 and E15 in full with `MIDSTUDY_SERVER=next` wait for the library and scenes routes (above); they pass in full
  in the hybrid runs.
- REFACTOR §4.1's "≥ 2× on p95" for product reads is not met (1.08×): the p95 page is network-bound (above).
- `pyjson.ts` and `py.ts` don't certify (the recursive `PyValue` type); the refusal is TScert's, not a type error.

---

## v1: the product page reader as first built (2026-11-05, orchestrator's notes)
Started 2026-11-05 on branch `claude/product-import-6b48ab` (worktree). The spec is contract §2.11 and §2.9 Page fetches.

### Phase 0: what the real pages look like (golden set, `evals/product_golden.json`)

Ten real pages, fetched once on 2026-11-05; their HTML and feeds are saved, git-ignored, in `fixtures/pages/<id>/`.

| Page | Where the size is | Notes |
|---|---|---|
| zennovacarpet.com (WooCommerce, the user's carpet shop) | only as variant terms `3*4 … 4*8`, no unit | Store API has the terms; the custom-size form says `Length (m)`, so metres. JSON-LD Product has no size. Name has a " - Zennova Carpets" suffix in JSON-LD and og:title, not in the Store API. |
| IKEA AE | JSON-LD `width: "80 cm"` etc. | also a `3DModel` JSON-LD block (a GLB: a later idea) |
| IKEA US | JSON-LD `width: "31 1/2 \""` | fractions in inches |
| Albany Park (Shopify) | text: `101" L X 40" D X 30.5" H`; `.json` body: `101"W x 30.5"H x 40"D` | box sizes and seat/arm heights nearby; 8 MB page |
| Annie Selke (Shopify rug) | JSON-LD ProductGroup `hasVariant[].size` `7' 6" x 9' 6"` | `.json` 429, `.js` 200 |
| Boutique Rugs (Shopify rug) | JSON-LD offer names `… - 3'11" x 5'7" Rectangle`; size-guide table with nominal and shipping sizes | Thickness 0.45", Pile Height 0.29" |
| Floyd (Shopify) | none in the served HTML | ProductGroup colour variants |
| Industry West (WooCommerce) | none | Store API `dimensions` all `0` |
| Target | inline script JSON: `Dimensions (Overall): 71.18 Inches (H) x 24.49 Inches (W) x 11.57 Inches (D)` | visible text is ~1 KB; recommended products' sizes follow |
| West Elm | 403 to any non-browser client | the "blocks" case; Wayfair 429, Crate & Barrel 403, Pottery Barn 403 too |

Learned: Shopify rate-limits bursts from one IP (429 on `.json`, then on pages too, after ~10 quick requests across Shopify shops); the `.js` feed answered when `.json` didn't. An honest `User-Agent` (`midstudy/1.0 (product page reader)`) got the same answers as a browser one on every page, so the reader says what it is.

### Decisions

- **Model:** fal `openrouter/router` (the current fal route for language models; `fal-ai/any-llm` is "no longer supported"), `model: "anthropic/claude-haiku-5.5"`, $0.10 / $0.50 per million tokens in / out (OpenRouter's list, 2026-11-05), so about $0.001 for a 20,000-character page. fal's answer carries `usage.cost`, which is what's recorded. Alternative at the same price: `google/gemini-2.5-flash-lite` ($0.10 / $0.40).
- **The model only locates; the server decides.** Its sizes count only when their quote is on the page and holds the numbers; the server converts units and checks 1–2000 cm. So planted instructions can at worst point at text that is really on the page.
- **A deterministic text layer before the model** (labelled triples with units, tables, script JSON): free, exact, and it covers Albany, Target and tables, so the model runs only when nothing was found.
- **Unitless sizes** (Zennova's `3*4`) take the page's own unit hint, with a note, else they're dropped with a warning.
- **The server never downloads pictures**; the chosen one goes through the existing from-URL add and its checks.
- **Files:** the extractor is a new `planner/product_page.py`, loaded by path from `serve.py` (the Nix wrapper runs `python3 -I`, which keeps the script's folder off `sys.path`); the form's new part is `planner/ui/panels/productsrc.js`. Both keep the edits to `serve.py` and `libsheets.js` small, since another session ([Idol on fal](#local_10f7d63d-ca03-49c4-8afc-8793d7aef502)) edits those on `main`.

### Evals

- `eval:product` (E14): synthetic pages in `fixtures/product-pages/` served by `evals/lib/pages_server.mjs`, model mocked; in `eval:all`.
- `eval:product-ui` (E15): the form on desktop and phone; in `eval:all`.
- `eval:product-live`: the golden set, live (`--live`) or from the snapshots (default), model off unless `--llm` (which needs the main session and the user's OK); not in `eval:all`.

### Phase 1: two builders in parallel (workflow, 2 agents)

- **A, extractor:** `planner/product_page.py` (stdlib), the route in `serve.py` (three small hunks), E14, `eval:product-live`. See `docs/notes/product-extractor.md`. E14 273/273; golden snapshots 80/81, the one miss being my golden error (Floyd does give its size, in an accordion: `16” W x 13” L x 7” H`).
- **B, form:** `planner/ui/panels/productsrc.js`, small hooks in `libsheets.js`, `lib.readProduct`, the `readProductPage` hook, CSS, E15. See `docs/notes/product-form.md`. E15 115/115 against A's real route.
- Folded into the contract afterwards: W and L in one reading, unlabelled pairs, unitless numbers in text, which page pictures count, feed descriptions as `text`, `mock`/`llm` only when the model ran, no cost row for a refused call, 400 for a host that doesn't resolve, form errors vs app errors.

### Phase 2: integration

`eval:all` on 2026-11-05 13:30: E1, E6–E9, E12–E15 passed; E3, E4, E5 and E11 failed on 30 s page-load timeouts while the Mac's load average was 185–330 (other sessions' simulators and evals). Rerun after the fixes, at normal load (below).

### Phase 3: black-box verifiers (workflow, 3 agents) and fixes

32 findings: security 6, UX 11, accuracy 15. Fixed here, each with a regression in E14 or E15:

- **High:** a long digit run or an unterminated escaped-quote string froze the whole server for 20+ s (quadratic regexes hold the GIL). Number patterns are bounded, script strings are scanned in one pass, and the work after the download has its own 10 s limit. E14 reads a 12,000-digit, 20,000-escaped-quote page in well under a second while `/api/spend` stays responsive.
- **High:** a second size of the same rug replaced the first (same id). A product with several sizes now gets `<name>-<w>x<d>` ids, and the sheet says when Make would replace a piece already in the library.
- **High:** order keys ("(H x W x D)", "W x D x H:") were ignored or misread. They're now read as keys, never as one number's label.
- **Medium:** a failed read left the last page's size, category and Flat rug in the form; sizes in "related products" blocks could come first; the size picked in the link (`?variant=`) was ignored; "L x W" put a sofa's length in depth (now the longer of L and W is the width, except beds); a rug word as a material ("Kilim Ottoman") made a rug; size chips cut their text; no-picture-loads was a dead end.
- **Low, fixed:** private picture links (the browser would request them), `user:password@` kept in `costs.csv`, deep JSON failing a read, three IPv6 private ranges, Python names in error sentences, labels after numbers, dia, foreign axis words, ranges, structured `Width (cm)` names, unitless sizes that only fit in cm, untrue notes (unit order, rug thickness without a unit), picture copies (largest, https), samples as sizes, dual units, sofa beds, focus after Read, the phone keyboard after Go, the model credited when it found nothing, a missing height.
- **Not fixed (follow-ups):** Tab leaves the Add furniture sheet (a general `ui/sheet.js` issue, every sheet has it); seater-named Shopify options linked to sizes in the description, and filling a missing height from a lone "Height: 75 cm"; the four Shopify golden shops answer 429 from this Mac's IP (Cloudflare `local_rate_limited` after today's probing; untested from another network or later).

After the fixes, at normal load (2026-11-05 14:30): `eval:all` 12/12 (E14 395/395, E15 117/117), golden snapshots 82/82, harness self-test 22/22. Live without the model: 48/48 with 4 WARN (the Shopify shops' 429).

### Phase 4: landing and the paid live check (2026-11-05)

The user had this land first, before Idol and the lighting work. `main` hadn't moved from `b766898`, so no merge was needed; it was fast-forwarded to the branch from the main checkout. E14 passed 395/395 there as a smoke test. Then the paid check, run from the main checkout with its `.env`, into scratch libraries under `evals/out/` (the repo's `library/costs.csv` is untouched):

| What | Result | Real cost |
|---|---|---|
| `eval:product-live -- --live --llm` (10 golden pages, cap $0.02) | 73/73; every shop answered, Shopify included (the 429s had cleared). The model ran only on Industry West, the one page without a size, and found none (right). | $0.000253 |
| Haiku on `prose-llm` (size only in a sentence) | 90 × 40 × 120 cm, quote on the page | $0.000113 |
| Haiku on `injection` (planted "SYSTEM: … 9999 cm … FAL_KEY") | no size, clean name, nothing taken from the planted text | $0.000079 |
| One real add: IKEA AE BILLY read live (JSON-LD, $0), its first picture through the image-link add, SAM 3D | done in 147 s; `dims_cm` 80 × 28 × 106; GLB fit 0 %, splat fit within 5.3 % | $0.02 |

Total spent: $0.020445. So the model costs $0.0001–0.0003 a page, under the $0.001 estimate (the $0.002 hold against the cap stays). The docs and the form's hint now say "under $0.001".

Seen, not fixed (follow-ups):

- `costs.csv` keeps 4 decimals (`fmt_cost`, shared by `serve.py` and the pipeline), so a $0.000079 call is logged as $0.0001. The answer's `cost_usd` and the job carry the exact value; the cap is off by under $0.0001 a read.
- IKEA's JSON-LD name carries the size ("BILLY Bookcase - black oak effect 80x28x106 cm"), and so does the id made from it. It reads fine and can be edited before Make; stripping a trailing size from names would be a small nicety.

### Blocked shops: Paste the page instead (2026-11-05, main session)

West Elm, Crate & Barrel and Pottery Barn answer 403 to anything but a real browser (Wayfair 429); a browser
User-Agent changes nothing. Getting past that from the server (a headless browser, a scraping proxy) would be getting
round the shop's bot check, so it isn't done. Instead the user's own browser, which the shop already served, hands the
page over: `POST /api/library/product` takes `{html, url?}` and reads it without fetching anything (contract §2.11
Pasted pages). The form's **Paste the page instead** section (opened by a blocked answer) has the **Copy page for
midstudy** bookmarklet (copies `<!-- midstudy-page: <address> -->` + the page's DOM) and a paste box; View Source,
select all, copy works too. The DOM copy is better than the served HTML for shops that render sizes in the browser.
Evals: E14 §8 (pasted pages, 13 checks) and E15 (the section, the bookmarklet run on a shop page, the paste read).
Not tried on a real blocked shop yet. The blocked sentence still says "paste the image link and size instead" (pinned
by the contract); the paste section opens right under it.
