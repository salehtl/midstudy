# rooms-integrate (docs/ROOMS.md Phase C, track integration)

Branch `rooms-integrate`, from `rooms` (main `452a601` + Phase A + Gate A, `aa45638`).

## What was merged

In this order, each `--no-ff`, with no conflicts (the shared-append `tscert/baseline.json` auto-merged):

| Branch | Head | Merge |
|---|---|---|
| `rooms-calib` | `e4051e5` | `7d7f71c` |
| `rooms-server` | `fa60531` | `edc176d` |
| `rooms-app` | `d5daefa` | `aeac2ee` |
| `rooms-proofs` | `cac8294` | `83824f2` |
| `rooms-evals` | `ee59958` | `c046491` |

Then `main`: already an ancestor. The task said main had one commit beyond `452a601` (a CLAUDE.md edit); when this
ran, `main` was at `452a601` itself (`git log rooms..main` empty), so there was nothing to port. The CLAUDE.md that
`452a601` wrote ("STATUS and ROOMS, how the pieces connect, .upstream/nook") is the one edited below.

## Seams, and how each was resolved

### Contract (§4.9 and around), decided here and written into CONTRACT.md

1. **Align 409 vs. members still calibrating** (server, app, evals): one behaviour. A member counts toward the align's
   "two photos" when it has a `photo.jpg` **or a calibration queued or running**; New room therefore asks at once and
   the job waits (`waiting_for`). This is what the server already did (`service.ts`: `isFile(photo) || busy(scene)`).
   The app no longer waits for two `photo_url`s: `createRoom` and the Scenes page's New room `POST …/align` right after
   `POST /api/rooms` (`alignRoomWhenReady` is gone), so `createRoom` resolves on 202/201/202 as the hook says. A job
   whose turn comes with fewer than two photos (a calibration failed) fails. Written into the §4.9 table and
   `align-request.schema.json`'s description; E18 (`409` for a room with fewer than two photos), E19 (`createRoom`)
   and the app agree.
2. **The answer's frame is looked up when the result is applied** (server decision 3): §4.9 Align now says the anchor's
   pose and scale are read from the room as it is when the result is applied (`{0,0,0}` if unplaced, scale 1 if no
   longer a member), and Reset reads them the same way.
3. **Yaw clamp needs a floored mod** (proofs): §4.9 Ranges now says the mod is floored, that it is §4.6's `wrapDeg`, and
   that JavaScript's `%` would leave −270 at −270.
4. **Mock "copied" vs. the frame rule** (calib, evals): the first argument always gets confidence 1 and residual null;
   everything else is copied. calib's mock and the stub already did this; the text now says so.
5. **Reset's "selected photo"**: the photo last moved or turned in Align photos, else the current photo (the app's
   reading; E19 works with either).
6. **`getScreenRect` for items partly out of frame or behind the camera**: the box corners in front of the camera, not
   clipped to the photo; null when no corner is in front (what the kernel `screen_rect` does; E19 already accepted
   unclipped or clipped). Written into §4.6's hook listing.
7. **`room-add-scene`** (`data-scene`, the rows of Add a photo's picker) joins §4.9's handle list and the Scenes page
   text.
8. **A deleted room's align job** ends `failed` with `the room was deleted` and changes nothing (the server's
   behaviour; the evals track noted the contract didn't say).
9. **An invalid `align.json`** makes the room detail's `align` null (and `align_status` treats it as absent), so a bad
   file never makes `GET` fail in strict mode (server decision 5; E18's strict case relies on it).
10. **The server's default `--calib`** is `uv run --project calib --extra rooms midstudy-calib` (§2.1, §4.4,
    `server/src/logic/cli.ts`, `main.ts`), so an exact `uv sync` (check:py, `calib/scripts/check.sh`) can't silently
    turn align-room into Manhattan. The evals' real calib commands (`harness.mjs` `REAL_CALIB`, `align_eval.mjs`,
    `calib_eval.py`) carry the extra too. `uv run --extra rooms` installs the extra's four small packages on first use
    (from uv's cache offline); MASt3R's code and weights are still fetched once on its first solve.

### Code

11. **`evals/lib/harness.mjs`**: `startServer` passes `--rooms-dir <data>/rooms` (unless the caller passes its own), and
    the repo guard covers `rooms/` (its check is now "scenes/, layouts/, renders/, library/ and rooms/ were not
    touched"). `evals/library_api.sh` and `evals/product_live.mjs`, which start their own servers, pass `--rooms-dir`
    too. `evals/perf.mjs` doesn't: it A/Bs older targets that may not know the flag (the server creates `rooms/` only
    when a room is written, and perf makes none).
12. **TScert**: `tscert/config.json` and `tscert/tsconfig.server.json` gain `server/src/rooms/logic/**/*.ts`;
    `server/src/rooms/tsconfig.tscert.json` is deleted. `tscert-ratchet --update`: +79 entries (56 rooms server
    functions, plus 22 planner/spend functions that already certified but weren't baselined and one render function),
    and the two stale entries **removed**: `planner/logic/input.ts#keyCommand` and
    `planner/ui/logic/workspace.ts#workspaceKey`. Both are gone from the code on `main` too (`git grep` on `main` finds
    them only in `tscert/baseline.json`); they went with the keymap port. Result: 834/876 certify, all 834 baselined.
13. **proofs/diff/room** now tests `planner/logic/room.ts` (the one-line switch); room.ts loads no kernels and doesn't
    round rotations, so neither of the proofs track's caveats applied. Result below.
14. **planner/ui/test/rooms-ui.mjs** runs against the real server; `planner/ui/test/rooms-fake.mjs` is deleted. Kept
    rather than dropped: it drives UI flows E19 doesn't (the room card's menu, New room through `room-files`, delete
    and restore through the Scenes page). Not in any npm script (as in Phase B); run it through the lock (below).
15. **E19 wedge drag** (E19.49 failed against the real planner): the grab point 0.4 m along room-2's view is also inside
    later photos' wedges, and the plan's hit test took the topmost by member order. Fixed in the app: in Align photos
    the current (selected) photo's wedge wins where wedges overlap (`planner/logic/room.ts` `planHit`), and it is
    drawn last, on top (`planner/ui/room.ts`), so what you see is what you grab.
16. **E19 getRoom after a drag** (E19.50): the eval read `getRoom()` the moment the server showed `manual`, before the
    page had the PUT's answer. Eval-side fix: wait up to 3 s for the page to show it.
17. **E20 with the real CLI's mock** (E20.07/.10/.11 at 1e-6): calib's writer rounded positions to 4 decimals and yaw to
    3. Now 6 (as the server keeps poses), scale 6, and a yaw that rounds to −180 is written as 180 (it could leave the
    range before). `calib/src/midstudy_calib/rooms/{mock,command}.py`.
18. **Room examples re-recorded**: `contract/tools/record-examples.mjs` gains a rooms section (every §4.9 route and its
    refusals, room layouts, render with `room`, a member scene deleted and restored, room trash/restore, the
    `room.json`/`align.json`/room `trash.json` files) and a settings section (the settings routes had only hand-written
    examples, so the recorder's "every route has an example" check failed). Every example file is re-recorded (154
    examples, all valid; `files-room.json` and `files-align.json` are new). The hand-written 409 "restore while a room
    by that name exists" example is gone (a room name can't be reproduced on demand).
19. **nix/midstudy-calib.nix**: the import check gains `midstudy_calib.rooms.{command,photos,geometry,solver,score,
    manhattan,mock,mast3r}` and `scipy.spatial` (mast3r.py imports only the stdlib and numpy at load). Checked by
    importing the same list in calib's venv; the Nix package itself was not built here.
20. **check:rust**: the contract crate's generated `roundtrip` (one match arm per contract type) passed 100 lines with
    the room types; `core/crates/contract/build.rs` now marks it `#[allow(clippy::too_many_lines)]`.
21. **ui-smoke UI.27** ("Ctrl+Z puts it back") failed twice, independent of rooms: since the keymap port, undo is `mod+z`
    (⌘Z on a Mac; Ctrl+Z there is a different key) and the smoke pressed Control+z. The smoke now presses the key the
    toast names.

### Open issues from the Phase B reports not resolved by a change

- calib 5 (the constraint factor unplaces correct one-wall photos), 6 (a bare-wall first photo), 7 (memory with MoGe
  and MASt3R in one worker), 8 (real photos): properties of the solver; Phase D measures them. The server's anchor
  rule is the contract's (first member with a pose the result can't change); no change.
- calib: MASt3R's first use needs the network; 32 photos' run time is an estimate.
- app 6: no plan legend, pinch-zoom on the plan only checked by code.
- proofs 5: the floor-plan geometry and the server's clamp/apply code have no Lean diff yet.
- server 6/7: the server's TypeScript stand-in (`server/test/rooms-calib.ts`) stays for the server tests; the stub
  (`fixtures/stub_calib.py`) and the real CLI's mock now both pass E20 `--mock`.

## Gate results (this worktree, final code unless said)

GATES_PLACEHOLDER

## What Phase D needs

- The user's 8–12 photos of one room (§7), one tape measurement and 3–4 spots measured from two walls, written as
  `evals/real_room.mjs`'s measurements file; then
  `nix develop -c node scripts/eval-lock.mjs --exclusive -- npm run eval:real-room -- --photos <dir> --measurements <file>`
  (photos stay under `evals/out/`, git-ignored; never `fixtures/photos/private/`).
- `cd calib && uv sync --extra rooms` once on the machine that runs the server, and network once for MASt3R's code
  and weights (or the server's default `--calib` installs the extra itself on first use).
- Judge the room view on Metal (Safari or Helium, by the user), WebGPU and `?webgpu=0`; everything here ran on
  SwiftShader.
- If MASt3R fails on real photos: time manual alignment (ROOMS.md §5 Phase D).
