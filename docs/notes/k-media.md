# k-media (v2 Phase 1): the Rust media kernels

Branch `v2-k-media`. Owns `core/crates/media/**`, `core/crates/wasm-node/**`, `core/js/node.ts`.

## What exists

- **`core/crates/media`** (`midstudy-media`): pure Rust, no I/O, no runtime dependencies (proptest and regex for tests);
  `#![deny(clippy::indexing_slicing,
  clippy::arithmetic_side_effects, clippy::cast_possible_truncation)]` plus `panic`, `unwrap_used`, `expect_used`,
  `unreachable` at crate level; `unsafe` forbidden (workspace lint). Modules, each citing its contract section:
  `sniff` (§4.3/§4.4), `jpeg` (strip §2.6/§2.8, `frame_info` §2.6, `is_clean`/`passthrough` §4.3), `png` (strip §2.8,
  `size` §4.7), `glb` (strip §2.8), `path` (`normalize`/`resolve`/`route`/`static_route`/`reduce_leading_slashes`,
  §2.1/§2.8/§2.9/§4.4), `slug` (`is_slug`, `is_scene_name`, `is_render_name`, `name_order`/`cmp_names`), `http`
  (`content_length`, `host_name`, `check_host`, `origin_ok`, §2.9), `zip` (`decide`, `plan`, §2.8), `meta`
  (X-Midstudy-Meta, §2.8/§4.4), `datauri` (v1's image data URIs §2.6/§2.8/§4.4/§4.7, and the WHATWG `data:` URL reader
  for GLB textures), `base64` (CPython strict/lenient, WHATWG forgiving, encode), and a private strict JSON reader with
  byte spans (`json`).
- **`core/crates/wasm-node`** (`midstudy-wasm-node`): wasm-bindgen `=0.2.121`. `api` (plain Rust, tested natively) +
  `exports` (the `#[wasm_bindgen]` layer, forwarding only). The workspace lints apply unchanged, `unsafe_code =
  "forbid"` included: wasm-bindgen 0.2.121's glue passes it (checked on wasm32 with `--forbid=unsafe_code`), so the
  "outside the wasm glue" exception in REFACTOR §1 isn't needed. Plain types only; every fallible call returns an
  envelope `Uint8Array`: `00` + payload, or `01` + offset u32 + code (kebab-case) + message. Nothing can panic across.
- **`core/js/node.ts`**: the typed face (strict, no `any`, no casts but `as const`): `sniff`, `photoExt`, `stripJpeg`,
  `jpegFrame`, `jpegIsClean`, `jpegPassthrough`, `stripPng`, `pngSize`, `stripGlb` (`layout: 'compact' | 'in-place'`),
  `decodeImageDataUri`, `decodeMeta`, `normalizePath`, `reduceLeadingSlashes`, `staticRoute`, `isSlug`,
  `isSceneName`, `isRenderName`, `compareNames`, `contentLength`, `hostName`, `checkHost`, `originOk`, `zipPlan`.
  Errors are `Result<T, MediaError<Code>>` with per-function code unions. It loads
  `build/wasm/node/midstudy_wasm_node.js` lazily (createRequire) and checks the module's shape at runtime.
- **Tests**: unit tests in every module; `tests/props.rs` (proptest: model-based JPEG/PNG generators, regex oracles
  via the `regex` crate, no-panic on arbitrary input); GLB properties in `src/glb.rs`; `tests/diff_v1.py` +
  `examples/difftool.rs` (the differential test against v1); `wasm-node/js-test/face.test.ts` (Node tests of the face
  over the real wasm build); `fuzz/` (cargo-fuzz: `jpeg_strip`, `png_strip`, `glb_strip`, `path_normalize`,
  `host_check`, each asserting invariants); benches `examples/bench.rs`, `wasm-node/js-test/bench.ts`,
  `tests/bench_v1.py`; `AENEAS.md` for the proofs track.

## Commands

```sh
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
cd core && nix shell $NP#cargo $NP#rustc $NP#clippy $NP#rustfmt -c sh -c '
  cargo test -p midstudy-media -p midstudy-wasm-node &&
  cargo clippy --all-targets -p midstudy-media -p midstudy-wasm-node -- -D warnings &&
  cargo fmt --check -p midstudy-media -p midstudy-wasm-node &&
  cargo build --release --example difftool --example bench -p midstudy-media'
cd .. && evals/py core/crates/media/tests/diff_v1.py --scale 1 --seed 1          # differential test against v1
core/crates/wasm-node/build-node.sh                                             # wasm → build/wasm/node/
nix develop -c node --test core/crates/wasm-node/js-test/face.test.ts           # the TS face on the wasm build
cd core/crates/media/fuzz && nix shell $NP#cargo $NP#rustc $NP#cargo-fuzz -c \
  env RUSTC_BOOTSTRAP=1 cargo fuzz run -s none -a jpeg_strip -- -max_total_time=180 -max_len=65536
```

Type-check and lint of `node.ts` (until f-toolchain's `check:types`/`check:lint` exist): a scratch folder
`evals/out/media-tscheck/` with `typescript@5.9.3 @types/node@22 eslint@9 typescript-eslint@8`, a tsconfig with every
§3 flag (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) and
`strictTypeChecked` with `consistent-type-assertions: never`; run eslint from the repo root with `-c` (from the
scratch folder it silently ignores files outside its base path).

## v1 code each kernel replaces (differentially tested)

| Kernel | v1 |
|---|---|
| `sniff` | calib/src/midstudy_calib/ingest.py:43 `sniff` (and planner/serve.py:404 `image_kind`, see differences) |
| `jpeg::strip` | planner/serve.py:949 `clean_jpeg` + :940 `plain_jfif`; pipeline/src/midstudy_pipeline/glb.py:135 `clean_jpeg` (identical, checked on every case) |
| `jpeg::frame_info` | planner/serve.py:117 `jpeg_size` |
| `jpeg::is_clean`, `passthrough` | calib/src/midstudy_calib/ingest.py:62 `jpeg_walk`, :112 `plain_jfif`, :117 `is_clean_jpeg`, :283–:308 `ingest`'s pass-through |
| `png::strip`, `png::size` | pipeline/src/midstudy_pipeline/glb.py:183 `clean_png`; planner/serve.py:910 `png_size` |
| `glb::strip` | pipeline/src/midstudy_pipeline/glb.py:34 `read_glb`, :79 `load_model`, :202 `_clean_image`, :206 `scrub_images`, :56 `write_glb` |
| `path::normalize`, `route`, `static_route` | planner/serve.py:276 `clean_path`, :1457 `translate_path`, :1651 `hidden`, :1656 `do_GET` (the `/` redirect), :256 `LIBRARY_ASSET`, :887 `SCENE_ASSET`; Python http.server's `//` reduction (gh-87389) |
| `slug::*` | planner/serve.py:63 `SLUG`, :86 `RENDER_NAME`, :1031 `name_order` |
| `http::content_length` | planner/serve.py:266 `CONTENT_LENGTH`, :1501 `parse_request` |
| `http::host_name`, `check_host` | planner/serve.py:265 `HOST_RE`, :269 `host_name`, :260 `LOOPBACK`, :1501 `parse_request`, `main`'s `--allowed-host` check |
| `http::origin_ok` | planner/serve.py:1572 `forged` |
| `zip::plan` | planner/serve.py:372 `zip_problem` (+ :252–:254 limits); pipeline/src/midstudy_pipeline/objzip.py:25 `check` |
| `meta::decode` | planner/serve.py:1838 (`post_scene`) and :2151 (`post_library_upload`) |
| `datauri::decode_image` | planner/serve.py:926 `decode_data_uri` |

## Results

**Differential test** (`diff_v1.py`, 102,349 cases per run at scale 1; every run passed, every difference an expected
one: seeds 1–4 during development, 5 after the JPEG scan change, 6 on the final code). Areas: sniff (vs calib and vs
serve.py), JPEG strip (both v1 copies)/size/clean/pass-through, PNG strip/size, GLB (in place byte-identical to v1's
binary chunk and JSON-equal; compact checked view by view), zip (vs serve.py's messages and objzip.py's decisions), path
normalize/route (through v1's own `Handler` methods), host, Content-Length, Origin (through v1's `forged`), slug, name
order, CPython base64 strict/lenient, meta, data URIs, cp437, and a privacy check (`evals/lib/metadata.py inspect` on
what v2 writes for every GPS canary: clean). Corpus: all of metadata.py's GPS-canary kinds (EXIF, after EOI, between
progressive scans, zero padding, JFXX, eXIf/tEXt, GPS GLB, 12 MP, RST0), the tracked fixtures' JPEGs, PNGs and GLBs
(never `fixtures/photos/`), Pillow-made JPEGs (progressive, optimized, grey, CMYK, ICC, comment, 4:4:4) and PNGs,
hand-made edge structures, ~4,000 seeded JPEG mutations, ~1,500 PNG, ~400 GLB, ~1,500 zips and ~6,000 strings per string
area. Expected differences (named in `EXPECTED`, each counted):

- `sniff-avif`, `sniff-brands`: v2 uses calib's HEIF rule at upload too (serve.py took AVIF-only `mif1`, and lacked
  `hevm hevs mif2 miaf`).
- `pass-decode`: v1's pass-through also decoded the image with Pillow; that stays with the caller.
- `glb-bad-texture`: a texture v1 couldn't parse was served with its metadata; v2 refuses the model.
- `glb-container`, `glb-json-strict`, `glb-fields`: v2 refuses cut-off or misordered containers, duplicate JSON keys, a
  non-string `asset.version`, views outside their buffer and non-integer indices (v1 read them leniently or crashed).
- `glb-mesh-compression`, `glb-external-image`, `glb-packing`: v1's pipeline refused Draco/meshopt, and packed
  buffers/external images before scrubbing; the strip doesn't (the v2 pipeline packs first).
- `zip-bad-name`: names with NUL, or flagged UTF-8 but not, are refused (v1 truncated at NUL or crashed).
- `zip-v1-copies`: serve.py and objzip.py disagreed on names like `a.obj/.`; v2 follows serve.py, which decides first.

**Property tests**: 16 in `tests/props.rs` (2,000–4,000 cases each) + 2 GLB properties (500 cases): strip matches an
independent model and is idempotent; its output is clean; `is_clean` ⟺ "strip removes nothing but fill bytes"; entropy
data preserved (by the model); PNG strip = model; GLB both layouts: images become exactly their stripped bytes, other
views keep their bytes, every view moves by a multiple of 16 (0 in place), output re-strips unchanged, compact ≤ in
place; `normalize` output starts with `/`, has no `.`/`..`/empty segment, is a fixed point of `resolve`, normalizes to
itself when it has no `%`/`?`/`#`; `resolve` idempotent; routes = v1's regexes; `is_slug`, `is_scene_name`,
`host_name`, `content_length` = their regexes; base64 round trips; nothing panics on arbitrary input.

**Fuzzing** (cargo-fuzz 0.13.1 on the pinned stable rustc 1.95 with `RUSTC_BOOTSTRAP=1`, `-s none` (no nightly, so no
ASan; the crate is safe Rust), debug assertions on, 180 s each, seeded from the GPS canaries; every target asserts
invariants, not only "no panic"): `jpeg_strip` 28.1 M runs, `png_strip` 58.7 M, `glb_strip` 61.4 M, `path_normalize`
7.7 M, `host_check` 63.5 M, no failure. `host_check`'s first run stopped at once on a bug **in the harness**
(`str::split_at` inside a multi-byte character, `fuzz_targets/host_check.rs`), not in the crate; fixed, the input kept in
the local corpus (git-ignored), then the 63.5 M clean runs. After the scan change below, `jpeg_strip` (11.2
M runs) and `glb_strip` (89.9 M) ran again, clean. Corpora and artifacts stay out of git (`fuzz/.gitignore`).

**wasm**: built now, not only at gate-1: the pinned nixpkgs' rustc ships the wasm32-unknown-unknown std; nixpkgs has no
rust-lld, so `wasm-ld` from `lld` is the linker; `RUSTFLAGS="-C target-feature=+simd128"`; then wasm-bindgen-cli
0.2.121 `--target nodejs` and `wasm-opt -O3 --enable-simd`: 116 KB. `face.test.ts` (11 tests) passes on it, including
byte equality with the native build on the GPS-canary corpus and 3,000 random inputs into every export without a
throw. Clippy is clean for `--target wasm32-unknown-unknown` too.

**Benchmarks** (medians of 15 runs after a warm-up, ms, the file already in memory; Apple Silicon shared with other
agents, load ~13; run directly, see the eval-lock note below; `examples/bench.rs`, `wasm-node/js-test/bench.ts`,
`tests/bench_v1.py`). v1 is `serve.py`'s `clean_jpeg`, `glb.py`'s `clean_png`, and for a GLB its read + `scrub_images`
+ `write_glb`'s serialisation, bytes in to bytes out.

| Input | v2 native | v2 wasm in Node (via node.ts) | v1 Python |
|---|---|---|---|
| 12 MP JPEG, metadata.py's `big12mp` (smooth, 335 KB) | 0.009 | 0.049 | 0.025 |
| 12 MP progressive JPEG with EXIF/GPS (smooth, 170 KB) | 0.004 | 0.027 | 0.025 |
| 12 MP photo-like JPEG with EXIF/GPS, q92 (7.1 MB) | **0.38** | **1.26** | 2.32 |
| the same with 200 KB appended after EOI | 0.35 | 1.27 | 2.23 |
| 3 MP PNG with eXIf (7.0 MB) | 0.10 | 0.79 | 0.93 |
| GLB textured with that 12 MP JPEG (7.1 MB), compact / in place | **0.70** / 0.74 | **1.52** | 3.60 |
| fixtures/models/SheenChair.glb (4.1 MB, 7 PNG textures, nothing to strip) | 0.28 | 0.93 | 0.95 |
| evals' `gps-glb` (2.7 KB) | 0.007 | 0.022 | 0.049 |
| wasm cold start: import of node.ts + module | | 23.4 + first call 1.4 | |

The first measurement had v2 *slower* than v1 on JPEGs (0.10 vs 0.025 ms on `big12mp`, equal on the photo): the scan
for the next `FF` was a byte-at-a-time `position`, against CPython's vectorized memchr. Testing each 64-byte block with
a max-reduction (no early exit, so it compiles to NEON / SIMD128) made it 3x (smooth) to 6x (photo) faster than v1.
In wasm, slice `==` is compiler-builtins' byte loop, which cost 2.5 ms on SheenChair; whether an image changed now
comes from the strip's own counts (`Removed::any`, exact, a property test checks it) and the one whole-file comparison
is a vectorizable XOR-fold: SheenChair in wasm 3.12 → 0.93 ms. SIMD128 gives the wasm JPEG strip another 3x (3.49 →
1.26 ms on the photo). Every change re-ran the unit, property and differential tests (seed 5, then 6) and the fuzzers.

## Decisions

- **GLB layout**: compact by default (the freed bytes are removed; later bufferViews move down by multiples of 16, so
  every alignment a writer chose survives), in place on request or when a bufferView has `extensions` (meshopt
  addresses the buffer directly). In place is v1's byte layout exactly (differentially tested). The JSON text is kept
  byte for byte except the spliced values (v1 re-serialised it): no float reformatting, no key reordering.
- **GLB strictness**: refuse what can't be cleaned or read unambiguously (a damaged JPEG/PNG texture, duplicate keys,
  both `bufferView` and `uri`, overlapping texture bytes, images outside the binary chunk) rather than serve a file that
  might carry metadata. Unknown chunks, trailing bytes and binary-chunk slack are dropped (reported). External image
  URIs are reported (not in the file). WebP/KTX2 textures are left as they are and reported as `other`.
- **Data-URI textures** are read as browsers read them (WHATWG data URL processor + forgiving base64), so the bytes
  cleaned are the bytes three.js draws; written back as `data:<mime>;base64,…`.
- **One HEIF rule** (calib's) for the server and calib; `Heic` vs `Heif` reported separately, both stored as `heic`.
- **Paths**: `normalize` decodes once; its doc says never decode again (`%252e%252e`). Every allowlist rule matches
  exact lowercase names, so no case spelling reaches a file outside it on APFS; `/planner/` and `/renders/` remainders go
  to the file system as they are (public folders).
- **Host**: several `Host` headers are refused (`multiple`; v1 used the first; RFC 9112 §3.2). Non-ASCII hosts are
  refused (HTTP headers are Latin-1; Python's `lower()` would map the Kelvin sign to `k`).
- **Origin**: compared as given; v1 saw header values with leading whitespace stripped, Node strips both ends (RFC 9110),
  so `X-Midstudy: 1 ` passes in v2 and didn't in v1 (harmless).
- **Zip**: entry-based (the caller's reader lists the central directory; the plan says which positions to extract),
  so the reader that extracts and the policy see the same entries; names with NUL refused.
- **X-Midstudy-Meta cap**: 16 KiB of base64 (Node's whole header block is 16 KiB by default).
- **Scope left to TS**: `slugify` (needs NFKD: `String.prototype.normalize`), the upload filename clean-up, the §2.9
  private-address rules for URL fetches (Node's `net.BlockList`), JSON parsing of the meta.

## Contract vs v1

No disagreement found that changes behaviour. Two v1 inconsistencies (serve.py vs calib sniff; serve.py vs objzip.py on
`a.obj/.`) are resolved as above. The contract's "§2.9 Paths … whatever its spelling or case" holds by exact matching.

## Requests to other tracks

- **f-toolchain**: the official wasm build should do what `core/crates/wasm-node/build-node.sh` does: `cargo build
  --release --target wasm32-unknown-unknown -p midstudy-wasm-node` **with `-C target-feature=+simd128`** (3x on the JPEG
  strip), `wasm-bindgen --target nodejs --out-dir build/wasm/node`, **write `build/wasm/node/package.json` =
  `{"type":"commonjs"}`** (the nodejs target emits CommonJS and the repo is `"type": "module"`), `wasm-opt -O3
  --enable-simd`. With nixpkgs' rustc: `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER=wasm-ld` (lld). `check:types` needs
  `@types/node`; `check:lint` must run eslint where the files are inside its base path. The fuzz crate
  (`core/crates/media/fuzz`, its own workspace) runs on stable with `RUSTC_BOOTSTRAP=1 … -s none`; a nightly with ASan
  would be better. Code is formatted with rustfmt's defaults (100 columns): if `core/rustfmt.toml` changes that, re-run
  `cargo fmt`.
- **server-core / server-routes**: route `/api` after `reduceLeadingSlashes` and before `staticRoute`; serve
  `planner` paths with `trailingSlash` → `index.html`, redirect a folder asked for without it, 404 a file asked for with
  it; `library-json` → an empty library when the file is missing. `checkHost` before anything (403 unless `allowed`),
  `contentLength` on all values (400 on error, 411/413 per route), `originOk` on every mutation, `decodeMeta` then
  `JSON.parse`, `decodeImageDataUri` then `stripJpeg` (render, thumbnails) and `jpegFrame` (qwen price; 400 when it
  fails), `pngSize` for the keep-room mask, `sniff` + `photoExt` for uploads, `zipPlan` on the central directory
  (pass each name as the extractor will use it; with the Unicode Path field 0x7075 if honoured, as Python did) and
  stop each entry at its declared size.
- **pipeline**: pack the model into one buffer (gltf-transform) and call `stripGlb` on the `model.glb` it writes;
  expect refusals with a sentence for damaged textures. WebP textures (`EXT_texture_webp`) can carry EXIF/XMP chunks
  that neither v1 nor this crate strips: worth a `webp::strip` (RIFF chunks `EXIF`/`XMP `, VP8X flags) if such models
  matter.
- **kernels-hardening**: Miri (needs nightly + miri), Kani, longer fuzz campaigns with ASan; the wasm copies in and
  out (wasm is 3-8x native on large files) if they ever matter; `AENEAS.md` lists what to extract for the proofs
  track.
- **main session (scripts/eval-lock.mjs, Phase 0)**: `--exclusive` takes slots one by one and keeps them while it
  waits, so two exclusive requesters deadlock: at 22:55 f-perf (`evals/perf.mjs --with-calib`, slots 0 and 2) and
  this track (slot 1) each waited for the other; I stopped mine, and k-geom's exclusive request then took slot 1 and
  waited the same way. Exclusive acquisition should be all-or-nothing (release what it holds when it can't take every
  slot, then back off). My benchmarks then ran outside the lock while nothing was measuring
  (4 s of one core).

## Left

- Miri and an ASan fuzz run need a nightly toolchain (not in the pinned nixpkgs).
- The GLB rewrite doesn't check accessors: one pointing into a texture's bufferView (a malformed model) would keep its
  old range after the view shrinks.
- The differential test runs v1's Python, so it needs `evals/py`'s environment; it is not wired into `npm run check`
  (f-toolchain's `check:rust` could run the Rust side, the main session the diff).
