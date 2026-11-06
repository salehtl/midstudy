# Aeneas targets in midstudy-media

For the proofs track (docs/REFACTOR.md §1: "Aeneas extracts the integer Rust kernels to Lean"). These are the
functions that are integer- and byte-only, loop-simple and worth a proof, in the order to try them. Each needs at most
a small mechanical rewrite to get past what Charon/Aeneas don't model well (iterator adapters with closures, `str`
methods, `first_chunk`, `core::array::from_fn`, `format!`/`Display`). Keep `tests/props.rs`, the exhaustive tests and
the fuzz targets as the regression check for any rewrite: they pin today's behaviour exactly.

| # | Function | File | Why it's a good target | Rewrite needed first | Property to prove |
|---|---|---|---|---|---|
| 1 | `glb::split_freed`, `glb::pad4` | src/glb.rs | Pure `usize` bit arithmetic; the compact layout's alignment rests on it | none | `pad < 16 ∧ removed % 16 = 0 ∧ pad + removed = freed`; `pad4 n < 4 ∧ (n + pad4 n) % 4 = 0`. With the shift sum in `layout_edits`: every moved bufferView keeps its offset mod 16 |
| 2 | `zip::megabytes` | src/zip.rs | Three lines of integer arithmetic standing in for Python's float `f"{total / 1e6:.0f}"` | none | equals round-half-to-even of `total / 10^6` (over ℚ), for all `u64` |
| 3 | `jpeg::frame_info` | src/jpeg.rs | One `while` loop over a byte index; the size qwen is priced by (§2.6) | `byte`/`be16` (src/bytes.rs) as two `get(i)` reads instead of `first_chunk`; `is_none_or`/`is_some_and` as `match` | never reads past `len` (by construction: every read is an `Option`); returns the first SOF's fields iff an SOF precedes every SOS/EOI, else the exact error; equals a Lean transcription of v1's `jpeg_size` |
| 4 | `png::strip`, `png::size` | src/png.rs | One `while` loop over chunk headers; `u32` lengths into `usize` with checked adds | `be32` as four reads; the `match kind` on `&[u8; 4]` as byte comparisons; `extend_from_slice` as a loop if Aeneas lacks it | idempotent (`strip (strip x) = strip x`); output = signature ++ the kept chunks in order; no output chunk has a dropped type |
| 5 | `base64::decode_python`, `base64::encode` | src/base64.rs | A small state machine over bytes (`quad`, `pads`, `left`), `wrapping_shl/shr` on `u8` | `encode`: `chunks(3)` and the `[18,12,6,0].map(…)` closure unrolled into a loop | `decode_python (encode x) true = ok x`; strict acceptance ⟺ a Lean grammar of padded base64 (no leading or excess padding, nothing after it) |
| 6 | `slug::is_slug` | src/slug.rs | A byte loop with ASCII classes; every id, layout and scene name passes through it | `split_first` + `iter().all(closure)` as an index loop over `as_bytes()` | `is_slug s ⟺ s ∈ L([a-z0-9][a-z0-9-]{0,63})` (no trailing newline) |
| 7 | the digit fold in `http::content_length` | src/http.rs | Checked `u64` multiply-add over at most 15 ASCII digits | factor `fn digits(&[u8]) -> Option<u64>` out of the `try_fold` closure | never overflows; the value is `Σ dᵢ·10^(n-1-i)` and `< 10^15` |
| 8 | `sniff::sniff` and `sniff::heif` | src/sniff.rs | Byte comparisons over the first 64 bytes and the `ftyp` box | `chunks_exact(4)` as an index loop; `contains` on the brand tables as explicit comparisons | the decision table of §4.3 (calib's `sniff`): JPEG/PNG/WebP magic, HEVC brands → HEIC, generic brands → HEIF unless the compatible brands are AVIF-only |
| 9 | `jpeg::step`, `jpeg::scan_end`, `jpeg::is_clean`, `jpeg::strip` | src/jpeg.rs | The privacy-critical walk (§2.6, §2.8, §4.3); plain index loops apart from two `position` calls | `iter().position(…)` (fill bytes, the next `FF` in a scan) as `while` loops; `plain_jfif`'s `array::from_fn` as an explicit array | `is_clean (strip x).bytes`; `strip` idempotent; every entropy-coded byte of the input appears unchanged in the output; `is_clean x ⟺` strip removes nothing but fill bytes (these hold under proptest and fuzzing today) |
| 10 | `wasm-node`'s `wire::Reader` | ../wasm-node/src/wire.rs | Bounds-checked little-endian reads | as #3 | never reads past the buffer; `bytes` returns exactly the length-prefixed slice |

Not good targets (keep them on proptest, fuzzing and the differential test): `json::parse` (recursion, `Vec<Vec<u16>>`
keys, sorting), `glb::strip` as a whole (many `Vec`s and splices; its arithmetic core is #1), `path::*`,
`http::host_name`, `datauri::*` and `zip::decide` (all `str`/`String` and Unicode-heavy: `char_indices`, `split`,
`from_utf8_lossy`, case mapping).

The crate already gives Aeneas an easy start: no `unsafe`, no traits of its own beyond `Display`, no generics, no
I/O, no globals; every index is a checked `get`, every addition checked or saturating, every cast checked, so each
extracted function is total once its `Option`/`Result` returns are read as Lean's.
