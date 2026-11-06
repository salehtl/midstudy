# rooms-evals (docs/ROOMS.md Phase B: the evals track)

Branch `rooms-evals`, cut from `rooms` (main + Phase A, `aa45638`). Track: evals. Written from
[CONTRACT.md §4.9](../../contract/CONTRACT.md) and the schemas in `contract/` only: I never read `server/`, `planner/` or
`calib/` source (the server's `--help` text showed up once, in a failure message). The eval-by-eval reference is
[evals/README.md](../../evals/README.md).

## What exists now

| File | What |
|---|---|
| `evals/rooms_api.mjs` | **E18** `npm run eval:rooms-api`: the rooms API, no browser (~170 checks). Every §4.9 route and refusal, room.json, PUT's changes and clamps, room layouts, the align job (waiting for a calibrating member, the mock's true poses through the anchor, manual/origin/overwrite_manual, scales, reset, a miss, a failing align-room, a strict-mode contract violation), trash/restore of rooms, a member scene deleted and restored, render with `room`. Every answer is checked against `contract/api/routes.json` with the generated validators. |
| `evals/room_planner.mjs` | **E19** `npm run eval:room-planner`: the room view on WebGPU, then the WebGL2 fallback, plus a 375 px phone pass (~90 checks). The golden room with its **true** poses (calib mock), a sofa probe at the true sofa's spot, keys 1–7, `getScreenRect` vs truth in every photo (3 px), id-mask IoU and occlusion behind the table from render composites, the room layout and reload, the floor plan (`floorPlanPoint`, a footprint drag), Align photos (wedge drag → `manual`, turn handle, Reset), `setPose`. |
| `evals/align_eval.mjs` | **E20**: `--mock` (in `eval:all`, ~21 checks, < 1 s) the align-room mock and output contract through the stub (or `--cli` for the real CLI); without `--mock` (run by `eval:calib`) the same against the real CLI plus the real solver on the golden fixtures' own calib at the Phase A targets, the hard pairs, Manhattan, an unknown solver. |
| `evals/real_room.mjs` | `npm run eval:real-room -- --photos <dir> --measurements <file.json>` (Phase D, not in `eval:all`): real MoGe + the real solver on the user's photos, Set scale from one tape measurement, every measured spot within 5 cm of its tape distances to two walls in every photo, unplaced, loop residual, upload-to-aligned time. `-- --golden` runs it on the golden room with the stub (a self-check of the eval). |
| `evals/lib/rooms.mjs` | the §4.9 maps in plain JS, the anchor and re-expression formulas, the mock key, the golden room, contract validation of answers, the repo `rooms/` guard, the sofa-probe library, a room page for either backend, the real-room measurements. |
| `evals/lib/room_images.py` | oriented-box occlusion judge, id-mask overlap, synthetic composites (reuses `images.py`'s rays and depth lookup). |
| `fixtures/stub_calib.py` | `align-room` with the §4.9 mock: key, rename by `photo_sha256`, argument order, re-express relative to the first argument, the miss, the failures. No `serve` (exit 2), as before. |
| `evals/all.mjs` | E18, E19, E20 `--mock` added after E17. |
| `evals/calib_eval.py` | real mode runs E20 real at the end (`--no-align` skips it; not with `--only` or `--calib-mock`). |
| `evals/harness_selftest.mjs` | a rooms section (11 checks). |
| `package.json` (appended) | `eval:rooms-api`, `eval:room-planner`, `eval:align`, `eval:real-room`. |

## How to run

```
nix develop -c node scripts/eval-lock.mjs -- npm run eval:rooms-api           # E18
nix develop -c node scripts/eval-lock.mjs -- npm run eval:room-planner        # E19 (-- --webgpu-only | --webgl-only)
nix develop -c node scripts/eval-lock.mjs -- npm run eval:align -- --mock     # E20 mock (stub); -- --mock --cli "uv run --project calib midstudy-calib"
nix develop -c node scripts/eval-lock.mjs --exclusive -- npm run eval:align   # E20 real (also at the end of eval:calib)
nix develop -c node scripts/eval-lock.mjs -- npm run eval:real-room -- --golden
nix develop -c node scripts/eval-lock.mjs -- npm run eval:real-room -- --photos <dir> --measurements <m.json>
nix develop -c node scripts/eval-lock.mjs -- npm run eval:selftest
```

The measurements format is in `evals/real_room.mjs`'s header: `scale` (two floor points in one photo and the tape
length), `walls` (two floor points on each wall's base line, any photos), `spots` (`from`: tape distances to each wall;
`seen`: where the spot touches the floor in each photo). Positions are fractions of the photo's width and height as it is
shown upright, so they survive the 2048 px downsizing. `-- --golden` writes an example from truth to
`evals/out/real-room-golden/measurements.json`.

## Where things stand (checks run in this worktree, this session)

- `eval:selftest`: **33/33** (H0.22–H0.32 are the new rooms checks).
- `eval:align -- --mock` (stub): **21/21**.
- `eval:rooms-api` against today's server: fails as it should. The server refuses `--rooms-dir`
  (`unrecognized arguments: --rooms-dir`), E18 retries without it, and every rooms route is `404 no such endpoint`.
  31/170 pass: W1/W2 refusals (the 403 comes before routing), the static 404s, the scenes setup, `?neither` layouts 400s,
  the contract and guard checks. Every 404 expectation needs the rooms routes to exist (`GET /api/rooms` 200), so a
  missing route can't pass as "unknown room".
- `eval:room-planner` against today's planner: fails as it should (`--rooms-dir` refused, `POST /api/rooms` 404, then
  `hook missing: listRooms, createRoom, waitForRoom, openRoom, setRoomPhoto, getRoom, setPose, roomToScene, sceneToRoom,
  floorPlanPoint`, `addItem() failed: Open a scene first`). 22/89 pass (the eval's own geometry, no page errors on the
  Scenes page). When the hook is missing, photo waits are cut to 3 s so it fails in ~90 s.
- `eval:real-room -- --golden` against today's server: fails at `--rooms-dir`, as expected.
- `eval:all` (once, after the wiring, WebGPU): **E1, E3–E17 all pass unchanged** (E1 235/235, E3 56/56, E4 21/21, E5 35/35, E6 38/38, E7 79/79, E8 72/72, E9 49/49, E11 29/29, E12 27/27, E13 51/51, E14 409/409, E15 135/135, E16 57/57, E17 52/52); **E20 --mock 21/21**; E18 30/170 and E19 18/92 fail for the missing routes and hook (no harness exception). The single-photo evals were not edited.
- `node scripts/check-ownership.mjs evals --base rooms`: ok. `npm run check:dead` (knip): ok.
- Not run: E20 real (no `align-room` in this worktree's `calib/`; calib builds it in parallel), `eval:real-room` on real
  photos (Phase D), E18/E19 against a rooms server (none exists yet).

## Decisions

1. **E19's "sofa"** is a magenta, unlit box of the golden sofa's size (`sofa-probe`, 200 × 90 × 82 cm), placed at the
   true sofa's room position and turn. Its projection is then truth's `corner_px` in every photo, its silhouette is the
   sofa's id mask (R), and "occlusion hides it behind the table where truth says" is judged on the pixels the photo's
   `depth.png` puts ≥ 10 cm in front of it (the table in living-wide, room-1, room-2, room-3 and room-5; room-4 has
   none, room-6 doesn't see the sofa). The pixels where the probe and the real sofa coincide are left out (equal depth).
2. **`getScreenRect` for a sofa partly out of the frame** (room-3, room-4, room-5): the contract says "the item's projected
   bounds in photo pixels" and doesn't say whether they're clipped to the photo, so E19 accepts the unclipped or the
   clipped rect (3 px). Where the whole sofa is in the photo (living-wide, room-1, room-2) it is exact. Room-6 (the
   sofa behind the camera) accepts null or a rect off the photo.
3. **The two backends in one eval:** E19 launches a second headless Chrome without the WebGPU flags and opens the room
   with `?webgpu=0` (the harness's `BROWSER_ARGS` is fixed at import, so `MIDSTUDY_WEBGPU=0` alone would need a second
   process). The WebGL2 pass is shorter (three photos, two renders) to keep E19 near five minutes.
4. **Servers get `--rooms-dir` in their scratch dir**; when it is refused, E18 and E19 restart without it so the report
   shows the missing routes too (a server that knows rooms would only refuse it by crashing, so the default `rooms/`
   isn't written; the `rooms/` guard would catch it).
5. **Crafted mock answers** (E18, E20) live in a copy of `fixtures/calib` under `evals/out/<eval>/calib-mock/`, reached
   by the gated wrapper's target `env MIDSTUDY_CALIB_MOCK=<copy> python3 fixtures/stub_calib.py` (harness's
   `startServer` always sets the mock to `fixtures/calib`). fixtures/calib (foundation's) is unchanged.
6. **The strict-mode case** (an answer with confidence 2): the stub writes what the mock holds (stdlib only, no schema
   check), so E18 deletes that invalid `align.json` after checking the job failed, to keep the room readable. The real
   CLI is meant to validate before writing (`MIDSTUDY_STRICT`, calib's job).
7. **Set scale in eval:real-room goes through the API** (`PUT {"rescale": k}`, k from the room's own projection of the
   tape's two floor points), not the planner's `room-scale` ruler: it measures the geometry, not the UI.
8. **The real E20 joins `eval:calib`** by `calib_eval.py` running `node evals/align_eval.mjs --cli <its CLI>` at the end
   of real mode (one check there summarises it); `package.json`'s `eval:calib` line is unchanged (shared-append: no
   edits). E20 real expects `--solver auto` to answer `mast3r` (Gate A; `--expect-solver` changes it).
9. **E20 real's pass rule** follows the spike's: every placed photo of the seven within 5 cm / 1.5° / 2 % of truth, at
   most one unplaced, none wrong at confidence ≥ 0.5; the hard pairs only "never confidently wrong" (no solver placed
   room-4 within target from one partner at Gate A). Run time ≤ 300 s for seven photos (Gate A: ~1 min).
10. **eval:real-room thresholds**: spots 5 cm (ROOMS §1), at most one unplaced, loop residual ≤ 5 cm and upload-to-aligned
    ≤ 180 s ("within a minute or two"); the last two are flags, since Phase D may decide otherwise (MoGe's depth on real
    photos disagreed by 13–19 cm in the spike).

## Contract notes (for the foundation / integration agent)

- **§4.9 Mock vs align.json's frame rule.** The mock says confidence and residual are *copied*, and align.json says
  `members[0]` has confidence 1 and residual null. When the first argument isn't the answer's own frame (any order but
  the fixture's), both can't hold: the stub gives the first argument confidence 1 and residual null (the frame rule wins,
  so the answer stays a valid align.json), and E20 checks that. calib's real mock should do the same; if calib chose
  "copied", E20.06/E20.08 will say so.
- **getScreenRect** isn't defined for items partly outside the photo or behind the camera (decision 2).
- **Reset's "selected photo"** (§4.9 Align photos) isn't defined: E19 drags room-2's wedge, keeps room-2 the current photo,
  then presses `align-reset`, so either reading (the dragged one, the current one) works.
- **Deleting a room while its align job is queued** ("dropped") doesn't say what the job then reports; E18 doesn't test it.

## Open issues for integration

1. **`evals/lib/harness.mjs` (foundation's) doesn't pass `--rooms-dir`.** Once the server has rooms, every existing
   eval's server will default to the repo's `rooms/` (git-ignored). Nothing there writes to it (no eval creates a room),
   but `startServer` should pass `--rooms-dir <data>/rooms` and the repo guard should cover `rooms/`, as
   `evals/lib/rooms.mjs`'s `guardRooms` does for E18–E20. Until then a server that creates `rooms/` at startup would leave
   an empty folder in the checkout.
2. E18 and E19 can't pass until the server (routes, `--rooms-dir`) and the planner (hook, handles) land; E20 real until
   calib's `align-room` (MASt3R extra) lands. Expect to fix eval-side details when they meet real code: say which check
   and line, as evals/README.md asks.
3. **E19 timing**: about five minutes expected on SwiftShader (11 renders at 1600 × 1200 on WebGPU, 4 on WebGL2); the
   watchdog is 25 minutes.
4. `eval:real-room` stores poses and spot positions from the user's photos in `evals/out/real-room/real-room.json`
   (git-ignored) and deletes the uploads' `source.*`; `photo.jpg` copies stay in the scratch scenes dir until the next run.
