# midstudy-media

The byte-level kernels behind what the server stores, serves and sends to fal: what an upload is (`sniff`), which
bytes of a JPEG, PNG or GLB are camera metadata (`jpeg`, `png`, `glb`, with `plan` for the result as ranges of the
input), how big a JPEG is (`jpeg::frame_info`), which request paths name a served file (`path`), which names are slugs
(`slug`), how a request is framed and whose it is (`http`), which zip entries may be extracted (`zip`), and how the
`X-Midstudy-Meta` header and image data URIs decode (`meta`, `datauri`, `base64`). Pure Rust, no I/O, no runtime
dependencies. Node calls it through `midstudy-wasm-node` and `core/js/node.ts`.

## Guarantees, and how each is checked

| Guarantee | How it is checked |
|---|---|
| **Never panics, never reads out of bounds, never wraps**, whatever the input. | By construction: the crate denies `clippy::indexing_slicing`, `arithmetic_side_effects`, `cast_possible_truncation`, `panic`, `unwrap_used`, `expect_used`, `unreachable` (every access is `get`, every sum checked or saturating), and `unsafe` is forbidden. **Kani** proves it for every input up to a bound (`src/proofs.rs`; the table below). **cargo-fuzz** with ASan: seven targets, 20-minute campaigns each (docs/notes/kernels-hardening.md). **Miri** runs the unit and property tests (`core/miri.txt`). |
| **The same decisions and bytes as v1** (`planner/serve.py`, `calib/…/ingest.py`, `pipeline/…/glb.py`, `objzip.py`), except the differences named in `tests/diff_v1.py`'s `EXPECTED`, each with its reason. | `tests/diff_v1.py` (a fixed seeded corpus, ~100,000 cases) and `tests/diff_fuzz.py` (random havoc mutations of that corpus and of the fuzz corpora for a set time): both run v1's own functions and `examples/difftool` and compare accept/refuse, sizes, routes and output bytes. The proofs track's Lean models of `jpeg::{strip, is_clean, frame_info}`, `png::strip` and `slug::is_slug` are compared with this crate by `proofs/diff/` (keep those names). |
| **Stripped files carry no metadata**: no APP1–APP15, COM, JFXX or JFIF thumbnail, nothing after EOI (JPEG); no eXIf/tEXt/iTXt/zTXt/tIME, nothing after IEND (PNG); a GLB's embedded JPEG and PNG textures stripped the same way. The image data is kept byte for byte. | Property tests against independent models (`tests/props.rs`: the output is the model's, is clean, strips to itself, `Removed::any` is exact); the fuzz targets assert the same on arbitrary input; `diff_v1.py` runs `evals/lib/metadata.py inspect` (the privacy evals' own check) on what this crate writes for every GPS canary; Lean proves the JPEG and PNG models' versions (`strip_no_metadata`, `strip_imageData`, …). |
| **A plan is the strip.** `strip(data) == strip_plan(data).apply(data)`, the plan's ranges lie in the input in order, and the plan is the identity exactly when nothing was removed. | `strip` is `strip_plan` + `apply` (one code path); property tests and the fuzz targets check the rest. |
| **Request paths can't escape the allowlist**: a normalized path has no `.`/`..`/empty segment, is a fixed point of `resolve`, routes only to the listed files, and the `/` redirect follows v1's `urlsplit`. | Unit tests (every v1 case and the case-variants on APFS), property tests against the regexes, the `path_normalize` fuzz target, Kani on short targets, and the differential tests through v1's own `Handler`. |
| **Documented and lint-clean**: every public item has docs (`#![deny(missing_docs)]`), clippy `pedantic` with `-D warnings`. | The compiler and `npm run check:rust`. |

### Kani bounds

Every harness proves "no panic, no overflow, no out-of-bounds access" plus the properties in its doc comment, for
every input up to the bound. Whole functions run on short inputs; their building blocks on longer ones (the JPEG walk
is a loop of `step`s, each proved to stay in bounds and to move forward; the GLB container and the layout arithmetic
are proved apart from the JSON reader). Under Kani the JPEG walk uses the plain `position` scan; the block scan the
production build uses is proved equal to it. See docs/notes/kernels-hardening.md for the timings.

## Commands (from `core/`)

```sh
nix develop ..#default -c cargo test -p midstudy-media                       # unit and property tests
nix develop ..#nightly -c cargo kani -p midstudy-media                       # the Kani harnesses
MIRI_SYSROOT=$PWD/../build/miri/sysroot nix develop ..#nightly -c cargo miri test -p midstudy-media
cargo build --release --example difftool -p midstudy-media && \
  (cd .. && nix develop -c evals/py core/crates/media/tests/diff_v1.py --seed 1)                # differential test
(cd .. && nix develop -c evals/py core/crates/media/tests/diff_fuzz.py --seconds 600)          # differential fuzzing
(cd .. && nix develop .#nightly -c core/fuzz/campaign.sh jpeg_strip 1200)                      # a fuzz campaign
```
