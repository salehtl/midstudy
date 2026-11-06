# midstudy-wasm-node

The media kernels (`midstudy-media`) for Node: wasm-bindgen 0.2.121, built by `npm run build` into `build/wasm/node/`
(ES module, `readFileSync` of the `.wasm`). `core/js/node.ts` is its typed face, which the server and `midstudy-add`
import. `src/api.rs` is plain Rust (tested natively); `src/exports.rs` only forwards to it with `#[wasm_bindgen]`.

## Guarantees, and how each is checked

| Guarantee | How it is checked |
|---|---|
| **Nothing panics across the boundary.** Every fallible call returns an envelope (`00` + payload, or `01` + offset + kebab-case code + the media crate's sentence), so a refusal is a value in TypeScript (`Result<T, MediaError<Code>>`), never a throw or a trap. | The crate denies indexing, unchecked arithmetic, truncating casts, `panic`, `unwrap`, `expect`; `midstudy-media`'s guarantees (Kani, fuzzing, Miri); `js-test/face.test.ts` throws 3,000 random inputs at every export and checks byte equality with the native build on the GPS-canary corpus. |
| **The face's codes are the kernels' codes**: each function's code union lists exactly what its envelope can carry. | `node.ts` checks every code at runtime (`isOneOf`) and the module's shape on load; the face tests. |
| **Zero-copy out.** `stripJpegPieces` and `stripPngPieces` return the stripped file as views of the input plus the few bytes the strip writes itself: only the plan (`jpeg_strip_plan`, `png_strip_plan`: ranges of the input) crosses the boundary, not the bytes. Write the pieces in order (`fs.writev`, a stream) or let `stripJpeg` / `stripPng` join them into one new buffer. | `src/api.rs` tests (the plan applied to the input is exactly the strip's bytes), `midstudy-media`'s property and fuzz tests (`strip == strip_plan.apply`), `js-test/face.test.ts`; `media/tests/bench_matrix.mjs` times it against the copy-out path and v1's Python. |
| **Documented and lint-clean**: `#![deny(missing_docs)]`, clippy pedantic `-D warnings` on the host and on wasm32. | `npm run check:rust`. |

## Commands (repository root)

```sh
nix develop -c npm run build
nix develop -c node --test core/crates/wasm-node/js-test/face.test.ts
nix develop -c node scripts/wasm-smoke.mjs --no-browser
nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/media/tests/bench_matrix.mjs   # timings
```
