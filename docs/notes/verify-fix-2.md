# Verify round 2: fixes

The fixer for verify round 2 took the 18 findings of the three verifiers (UX, calibration visuals, contract and
security), fixed all of them except the calibration scale on photos without an EXIF focal length (the golden renders
included; below), and added an eval for each fix. Everything below was run in this session (2026-11-04/05, M3 Max). `nix/`, `flake.nix` and
`docs/HANDOFF.md` were not touched (the packaging agent owns them). The user's own photo at the repo root
(`AD9729E1-…_1_201_a`, location data) was never opened and is git-ignored; nothing from `fixtures/photos/` is tracked.

## Results

| eval | result | notes |
|---|---|---|
| `npm run eval:all` (E1, E3–E9, E11, E12) | **all pass** | E1 172/172 (16 new), E3 55/55, E4 20/20, E5 34/34, E6 36/36, E7 69/69 (1 new), E8 43/43 (2 new), E9 48/48, E11 28/28, E12 26/26 (new) |
| `npm run eval:calib` (real MoGe-2) | 84/91 | the same 7 golden misses as rounds 0–1 (golden photos have no EXIF); all 24 new golden-with-EXIF checks and the lounge's EXIF-FOV check pass |
| `npm run eval:calib -- --mock` | 51/51 | 1 new (JFXX) |
| `npm run eval:real` | 31/31 | 1 new check (the lounge uses its EXIF FOV); the no-EXIF copies are compared with MoGe's own estimate for the original |
| `npm run eval:selftest` | 22/22 | (`calib_eval.py --self-test` 42/42, 12 new) |
| `cd calib && uv run pytest -q` | 42/42 | 5 new (JFXX/JFIF-thumbnail ingest, `floor_depth`) |

Golden scenes, as the user sees them, MoGe's own FOV (no EXIF) → the same photo with its focal length in EXIF:

| scene | floor drawn off (median) | furniture drawn | height | depth error |
|---|---|---|---|---|
| living-wide | 73 px → 10 px | x1.097 → x0.991 | 1.185 → 1.376 (truth 1.40) | 19.2 % → 4.7 % |
| steep-roll | 32 px → 16 px | x1.066 → x1.037 | 1.476 → 1.547 (1.60) | 10.3 % → 3.7 % |
| portrait | 52 px → 5 px | x1.095 → x1.005 | 1.114 → 1.243 (1.25) | 16.5 % → 2.4 % |

(EXIF stores whole millimetres, so the EXIF FOV is 54.88 / 65.97 / 69.39° against 55 / 65 / 70; steep-roll's 1° off is
most of its remaining 3.7 %.)

## Medium

- **A stray "null" under the Scenes grid** (`planner/ui/scenes.js`): `trashView()` returns null with an empty trash and
  `root.replaceChildren(…, null)` made it a text node. The page now fills through a helper that drops null/false.
  E12 checks the empty page on desktop and phone, the page with scenes, and after Recently deleted › Restore.
- **A scene opened on the other device showed no furniture** (`planner/engine.js`, `layoutToOpen`): each device
  remembers `{name, at}` per scene (`at`: the server's `updated` for a save, the device clock for a load, a delete
  remembers none). A scene opens with that layout unless a layout was saved after `at` on any device (the layouts'
  `updated`), or the device has nothing for the scene: then it opens with the most recently saved layout. No server
  change. E12: the desktop saves Corner chair then Two chairs → a fresh phone opens Two chairs (2 pieces); the phone
  saves Phone B → the desktop, reloaded, opens Phone B; the desktop then loads Corner chair → a reload keeps it, and the
  phone keeps its own Phone B. Contract §4.5 says so.
- **Calibration scale** (`calib/src/midstudy_calib/fit.py`, `floor.py`). Measured here first, with real MoGe-2 on the
  golden scenes (`evals/out/fix2/fovexp*.py`): given the true FOV as a known `fov_x`, MoGe's own second pass fixes the
  height (1.405/1.569/1.229 vs 1.40/1.60/1.25) but tilts the pitch 1–2° off. Better, and one pass: keep MoGe's pitch
  and roll, take the known FOV, multiply the height by `k = tan(fov_moge/2) / tan(fov_known/2)` (MoGe's scale is short
  by its focal ratio), and scale depth.png by the median ratio between that camera's floor depth and MoGe's own over
  MoGe's floor pixels. On the three golden scenes: the floor is drawn 10/13/2 px from where it is (MoGe's own: 73/32/52),
  furniture x0.99/x1.02/x1.01 its size (x1.10/x1.07/x1.09), depth within 4.8/1.0/1.4 % (19.2/10.3/16.5 %). A phone
  photo carries that FOV in EXIF, so `fit` now uses the EXIF FOV when it is within 8° of MoGe's (`fov_source: "exif"`;
  a cropped photo keeps the lens's focal length, so a bigger disagreement keeps MoGe's FOV, `fov_disagreement`).
  **This changes PLAN.md §4.3** ("MoGe's FOV wins"): the plan owner should confirm it. Contract §4.3 and
  calib.schema.json (`fov_source`, `moge`) follow.
  - Lounge (`upper-lounge-camera.jpeg`, EXIF 14 mm → 69.63°): camera FOV 69.63 (MoGe 72.75), height 1.432 (MoGe 1.352),
    depth x1.107. Through the verifier's pixel picks (`evals/out/fix2/lounge_measure.py`): seat front edge 39.4 / 38.8 cm
    (was 38.3 / 37.9), coffee table front edge 35.0 cm (34.2), back edge 30.9 (29.5), doorway 2.131 m (2.117). Table and
    doorway are inside the user's estimates (35–40 cm, 2.1–2.4 m); the seat stays 6 cm under "about 45". Single-view
    heights move less than the camera height because the narrower FOV also raises the horizon. Whether the seat is 39
    or 45 cm needs a tape measure; with one, Adjust floor › Ruler › Set scale fixes the rest.
  - **Not fixed: the golden renders themselves** carry no EXIF, so nothing in the automatic path knows their FOV and
    E2 real keeps its 7 golden misses (FOV, height, depth). E2 now also runs each golden photo with its true focal length
    in EXIF and checks height within 5 %, depth within 10 %, furniture within 5 % of its size and the floor within 25 px.
  - Photos without EXIF (screenshots, the chat copy `upper-lounge.jpg`, edited exports) keep MoGe's FOV and its scale
    bias; Set scale from a known length is the fix there.

## Low

- **Phone ruler instruction under Reset; the photo jumping after the second tap** (`planner/ui/workspace.js`,
  `styles/scenes.css`): the ruler has its own row while it is on, one fixed height: the instruction ("Tap two points on
  the floor, the ends of something you can measure", then "Tap the other end"), then "Know its real length? [ ] cm ·
  Set scale" (the phone: "[Real length] cm · Set scale" on one line, 44 px). E12: the photo rect is identical after
  Ruler on, tap 1 and tap 2 (desktop and phone); the phone's instruction is whole (no overflow) and overlaps no button.
- **Set scale didn't redraw the ruler's label** (`planner/engine.js`): with frames slower than the 400 ms wake tail
  (software rendering), a change made just before a slow frame was never drawn. Every wake now gets at least one frame.
  E12: right after clicking Set scale, with no pointer move, the label reads the typed length (150 ms and 1.35 s).
- **The zoomed selection label under the lift column**: the label is clamped left of the lift column. E12 (3× zoom).
- **Phone Compare had no Swap**: an icon button (44 px, `data-midstudy="compare-swap"`, desktop's button has the
  handle too). E12 swaps the two images of the split.
- **Phone toasts over the photo with a sheet open**: they sit at the top (over the scene switcher, ending above the
  stage at 60 px) while a sheet is open. E12 checks a toast doesn't overlap the visible photo.
- **GLB adds had initials, no thumbnail**: the planner renders one (its own small WebGL renderer, RoomEnvironment
  lighting, front three-quarter view, 256 px JPEG) for every item with a GLB and no thumb, one at a time, and stores it
  with the new `PUT /api/library/items/<id>/thumb` (W1 rules, ≤ 2 MB, `clean_jpeg`, under the library lock, 503 while a
  job holds it). E12: the probe box and SheenChair.glb get 256 × 256 JPEG thumbnails showing the model; the Library rows
  show images. (The probe box in every eval's scratch library now gets one too.)
- **JFXX APP0 pass-through** (`serve.py` `clean_jpeg`, calib `is_clean_jpeg`, `fixtures/stub_calib.py`, the pipeline's
  GLB textures): APP0 is kept only as a plain 16-byte JFIF header (a JFIF thumbnail is cut, JFXX dropped). E1 (stub,
  thumb, render), pytest (JFXX GPS thumbnail and a JFIF thumbnail are re-encoded by the real ingest).
- **qwen priced at 1 MP** (`serve.py` `jpeg_size`): steps over fill bytes, TEM, RST0–7 and a stray SOI; stops at SOS or
  EOI; a render whose size can't be read is 400. E1: 12 MP with and without RST0 → 402 ($0.36 over a $0.05 cap); SOF
  turned into APP5 → 400.
- **Malformed `--allowed-host`**: refused at startup unless it is `name[:port]`; `""` is never in the allowlist, so a
  request without `Host` is 403. E1.
- **Latin-1 digit Content-Length / stalled upload → 500**: `Content-Length` must be ASCII digits (400 in
  `parse_request`); a `TimeoutError`/`ConnectionError` while reading a body answers 408 with one sentence (or just closes)
  and never a 500. `MIDSTUDY_SOCKET_TIMEOUT` (evals only) shortens the 30 s. E1 checks "²", "¹" and a stalled body
  (408 at 2.0 s).
- **Early-413 drain held 30 s**: `discard_body` sets the socket timeout to what is left of the drain before each read.
  E1: an idle client after a 413 is dropped at 5.0 s.
- **GLB textures kept EXIF/GPS** (`pipeline/src/midstudy_pipeline/glb.py` `scrub_images`): every embedded JPEG/PNG
  (bufferView or data URI) loses its metadata in `model.glb`; a cleaned image is written at its view's start, the view's
  length shrinks and the rest is zeroed, so no other view moves. E7 (served `model.glb`) and E8 (CLI): clean, the
  texture decodes, the item validates. `source.glb` keeps the upload (never served).
- **Camera make and model in the scene API**: `public_calib` leaves out `exif.make`/`exif.model` in `GET
  /api/scenes/<name>` and in job objects; calib.json on disk keeps them (contract §4.4). E1.

## How to run

```sh
nix develop -c npm run eval:all            # E1, E3–E9, E11, E12
nix develop -c npm run eval:ux2            # E12 alone (~1 min)
nix develop -c npm run eval:calib          # E2 real: golden (+ golden with EXIF) and the real photos
nix develop -c npm run eval:calib -- --mock
nix develop -c bash -c 'cd calib && uv run pytest -q'
```

Experiments behind the calibration change (scratch, git-ignored): `evals/out/fix2/fovexp.py` … `fovexp4.py` (run with
`nix develop -c uv run --project calib python <script> living-wide steep-roll portrait`), `lounge_measure.py`.
Logs: `evals/out/fix2-all.log`, `evals/out/fix2-calib.log`, `evals/out/fix2-calib-mock.log`.
