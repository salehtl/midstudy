# kernels

## State machines W2: kernels-web-face (`core/js/web.ts`)

- `loadKernels`: a load from another source (by identity) during a load in flight is refused, no source joins it, and loaded stays final. The last failure is kept and named by the "not loaded" error. Module-level wrappers go through `api()`, so before a load they say to load first instead of failing inside the glue. `loadKernelsSync` still throws during an async load (documented).
- `serveKernels`: no latch; each request loads if not loaded, so a failed load is retried. A request the worker cannot deserialize gets an id-less `{ok:false}`.
- `KernelWorker`: a failed `postMessage` drops its entry; `messageerror` and a reply without a numeric id reject everything in flight; new `close(reason?)` rejects in-flight and later calls. `KernelPort.addEventListener` takes `'message' | 'messageerror'`.
- `envMap` reads the variant from the result and throws on a wrong length (unreachable without a diverged wasm build; pinned by review).
- `SceneCamera.#s()`: the scratch-view rule is a comment; a memory-growth regression case guards it.
- Tests: `core/crates/wasm-web/tests/{load,worker-rpc}.test.ts`, run by `npm run test:kernels-web` (so by `check:tests`).
- Deviation: the growth case projects 3,999,999 floats, not 4M, because `projectMany` takes whole xyz triples.

## State machines W5: kernels-node-envelope (`core/js/node.ts`)

- A malformed answer from the wasm is now a thrown protocol fault, not a MediaError or a misread value: an unknown or missing tag, an envelope shorter than its fields (`Payload.u32`/`bytes` and the error header are bounds-checked), bytes the reader left over (`rest()` moves the cursor to the end; `done()`), and a `stripGlb` answer that isn't a whole GLB 2 (magic, version, header length equal to the bytes).
- `zipPlan`'s local `bad-input` reports the entry index, as the Rust side does for its per-entry codes.
- No envelope layout change. `decodeEnvelope` and `Payload` are exported for the test (`Payload` because the composite build emits declarations).
- Deviation: `decodeGlbEnvelope` is split out of `stripGlb` and exported, because the GLB check lives in its reader and the test has to feed it a hand-made envelope.
- Tests: `core/crates/wasm-node/js-test/envelope.test.ts`, run by `npm run test:kernels-node` (so by `check:tests`).

## State machines W6: kernels-raster (`core/crates/raster`)

- `next_chunk` skips the CRC only under `cfg(fuzzing)`, which cargo-fuzz sets itself. The `fuzzing` Cargo feature is gone, so no ordinary build (wasm-web through feature unification included) can turn the check off.
- The `png` module doc now says what is not stricter than v1: chunks between two IDATs and bytes after IEND. A unit test pins both.
- `dilate_into`: a vertical reach is clamped below `u32::MAX`, the counters' "unseen" value, so a saturated reach no longer turns on a column with no set pixel (v1 leaves it empty).
- Tests: `mask::tests::a_saturated_reach_leaves_empty_columns_empty`, `png::tests::v1_parity_interleaved_idat_and_bytes_after_iend`, property `a_vertical_reach_past_the_height_is_the_height`.
- No deviation. `raster/README.md` never named the feature, so it is unchanged.

## State machines W7: kernels-notes (decisions, no code change)

Five machines stay as they are. Each decision was checked against the code at sm-next.

- **Camera scratch slots** (`wasm-web` `Camera`): won't fix. Inputs and outputs share one 32-f64 buffer with no phase marker, but `SceneCamera` in `core/js/web.ts` is the only caller of the raw `wasm.Camera` and none other is planned. It re-puts the item before `screenRect` and `hitBox` and checks the booleans of `photoToFloor` and `planePointAt`. Covered by `diff.mjs` and `v1-sync.mjs`. A second caller would have to take on the same protocol.
- **JPEG walkers** (`strip_plan`, `is_clean`, `frame_info`): won't fix, both are v1's (contract §0). There is no "frame seen" state, so `is_clean(FF D8 FF D9)` is true and `passthrough` refuses that input only through `frame_info`'s `NoFrame`. `step` and `frame_info` also read a stray SOI differently, so the frame reported for a file and for its stripped bytes can differ on malformed input. `jpegIsClean` and `jpegPassthrough` have no callers in `server/`, `pipeline/` or `common/`. Anyone adding one needs `frame_info` as well, not `is_clean` alone.
- **PNG strip walk** (`media::png::walk`): won't fix. The strip removes metadata chunks and does not validate, as in v1. A "PNG" with no IHDR strips to signature + IEND, which carries no metadata, and validity is the decoder's concern. Covered by the Kani harness `png_walk_short`, props and fuzz.
- **Base64** (`decode_python`): won't fix, deliberate CPython parity (contract §0). Lenient mode decodes across interleaved padding, and neither mode checks the unused low bits. `decodeImageDataUri`'s `Buffer` fast path takes only input that round-trips canonically, where the two decoders agree; everything else goes to the kernel.
- **glTF `Ctx` and GLB layout**: won't fix. A `Compact` request falls back to `InPlace` when a bufferView has `extensions`, and `Report.layout` says so. `pipeline/src/glb.ts` uses the default and does not read it; either layout is a valid GLB.

Outcomes of the other three packages are in the W2, W5 and W6 entries above. All three landed. The one defer is `SceneCamera`'s handle lifecycle and scratch-view cache: latent, no data loss or hang, and W2 added a comment and a memory-growth regression case for it.

Gate note: W6's "no deviation" holds for the code, but its ownership gate ran with `--base sm-next`, because the default base counts earlier waves' paths since main. The same applies here.
