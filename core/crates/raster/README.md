# midstudy-raster

The planner's raster kernels: the depth.png decoder and depth in metres (`png`, `depth`), the keep-room mask with its
PNG encoder (`mask`, `pngenc`), the environment map made from the photo (`envmap`, with `color` and `half`), and the
light probe's spherical harmonics and the splat colour level (`sh`). Each replaces a JavaScript loop or shader of v1
(`planner/engine.js`, `planner/lighting.js`). Safe Rust; `miniz_oxide` for zlib. The planner calls it through
`midstudy-wasm-web` and `core/js/web.ts`.

## Guarantees, and how each is checked

| Guarantee | How it is checked |
|---|---|
| **The decoder never panics**, never allocates past 16 Mpx, and refuses (with a reason) what isn't an 8- or 16-bit grayscale non-interlaced PNG: bad CRCs, truncated or misordered chunks, a filter type above 4, image data of the wrong length. | `png` denies indexing, unchecked arithmetic and truncating casts. **Kani** (`src/proofs.rs`): the chunk reader and its CRC on every input up to 20 bytes, every 13-byte IHDR (all 2¹⁰⁴). The whole decoder (33 bytes) and the pixel stage's row loop (2 × 2 images) ran CBMC past 5 minutes, so: `png::tests::every_small_image` runs the pixel stage on every small image (36,610 of them over the five filter types, two unknown ones and five sample values), and **cargo-fuzz** `decode_png` with ASan ran 60 minutes (20 on full-size depth maps, 20 on small inputs, 20 on the final code), every decoded image re-encoded and decoded again to the same samples. Property tests on damaged files. |
| **Unfiltering is the PNG spec's**: Paeth is the spec's predictor, and every filter is undone exactly. | Kani: `paeth` equals the spec's for all 2²⁴ inputs; unfiltering inverts the spec's filter for every row up to 4 bytes (8-bit, every filter byte 0–255) and 2 pixels (16-bit) and every previous row. Lean (`proofs/`): `unfilter_filter`, `paeth_eq_spec`. Property test: encoder round trips over every filter. |
| **v1's values.** Depth equals v1's `Float32Array` of mm/1000 bit for bit; the keep-room mask and its dilation equal v1's pixel for pixel; the SH rotation and gains equal v1's within 2e-15; the bilinear environment map equals the JS transcription of v1's shader. | `tests/golden_depth.rs` (Pillow's samples of every golden depth.png, by SHA-256), unit tests (every 16-bit value), `crates/wasm-web/tests/diff.mjs` against v1's lifted code, the headless-Chrome test against v1's own GPU bake (2 % mean difference for the mipmapped CPU map). |
| **The maths properties** (the two-pass dilation is the box dilation, the SH rotation keeps the irradiance, the splat level is 1 at the defaults). | Lean (`dilate_iff`, `irradianceAt_rotateBand1`, `splatLevel_defaults`, …) and `tests/props.rs`. |
| **Safe and documented**: `#![forbid(unsafe_code)]`, `#![deny(missing_docs)]`, clippy `pedantic` with `-D warnings`; **Miri** runs the unit and property tests (`core/miri.txt`; exhaustive loops sample under Miri, the golden tests read fixtures and are skipped). | The compiler, `npm run check:rust`. |

## Commands (from `core/`)

```sh
nix develop ..#default -c cargo test -p midstudy-raster
nix develop ..#nightly -c cargo kani -p midstudy-raster
MIRI_SYSROOT=$PWD/../build/miri/sysroot nix develop ..#nightly -c cargo miri test -p midstudy-raster
(cd .. && nix develop .#nightly -c core/fuzz/campaign.sh decode_png 1200)
nix develop ..#default -c cargo run --release -p midstudy-raster --example bench-raster   # native timings
```
