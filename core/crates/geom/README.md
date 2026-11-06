# midstudy-geom

The camera model of contract §4.1 and the planner's geometry, in `f64`: the camera block and its clamps, projection
and its inverse, the horizon and the horizon drag, item poses, box corners and world bounds, convex hulls and hit
tests, drags on planes, the landing rule, the ruler, the Look's clamps and the key light's directions. Pure Rust,
no dependencies, no allocation. The planner calls it through `midstudy-wasm-web` and `core/js/web.ts`.

## Guarantees, and how each is checked

| Guarantee | How it is checked |
|---|---|
| **v1's numbers.** Every function returns what v1's JavaScript (`planner/engine.js`, `planner/lighting.js`) returns, including where JS arithmetic decides a branch (`Math.round`, `Math.min`/`max` with NaN and −0, V8's `Math.hypot`: `jsmath`). | `crates/wasm-web/tests/diff.mjs` runs v1's own code (lifted verbatim, `tests/v1/`, kept in sync by `tests/v1-sync.mjs`) against the wasm build on thousands of random inputs per function: 49 groups, most exact, the rest within 1e-12 relative. |
| **The contract's camera convention.** Signs of pitch and roll, the horizon row, the projection of every golden scene's corners. | `tests/golden.rs` against `fixtures/scenes/*/truth.json` (80 corners within the file's 1e-3 rounding; floor round trips within 1.8e-15 m). |
| **The maths properties** of `LEAN.md` (28 of them: R is a rotation, both photo/floor round trips, nothing above the horizon, the drag cap, clamps in range and idempotent, wraps, quarter turns, world bounds, landing, the light's turn, …). | Proved over ℝ in Lean by the proofs track (`proofs/`, 25 of 28; docs/notes/proofs.md maps each), and checked on `f64` by `tests/props.rs` (proptest, 4,000 cases each). Two statements were corrected after the proofs: 7 (up is up only ahead of the camera's foot, z < 0: `raising_a_point_moves_its_pixel_by_the_formula`) and 13 (four quarter turns give back the stored angle except −180, which comes back as 180, as in v1: `four_quarter_turns`, `four_quarter_turns_from_minus_180`). |
| **Total and safe.** No panic on any input (non-finite values propagate as NaN or give `None`, as v1); no `unsafe` (`#![forbid(unsafe_code)]`). | The property tests feed NaN, ±∞ and −0; clippy `-D warnings` with `pedantic`; **Miri** runs the unit and property tests (`core/miri.txt`; the golden tests read fixtures and are skipped there). |
| **Documented.** Every public item has docs (`#![deny(missing_docs)]`). | The compiler. |

## Commands (from `core/`, in `nix develop`)

```sh
cargo test -p midstudy-geom                         # unit, golden, property tests
MIRI_SYSROOT=$PWD/../build/miri/sysroot nix develop ..#nightly -c cargo miri test -p midstudy-geom
nix develop -c node core/crates/wasm-web/tests/diff.mjs        # (repo root) differential test against v1's JS
```
