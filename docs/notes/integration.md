# integration notes

## State machines W5: tooling-eval-lock

`scripts/eval-lock.mjs` now uses `scripts/lib/dirlock.mjs` for its slots and the exclusive marker, keeping the lock root, the slot names and an owner.json the old script can read. A live pid on this host is never stale; `--stale-min` only applies to an owner on another host. The exclusive run keeps its marker until it ends and waits for live slots past its own `--slots`. Flags are strict (bad value or unknown flag: usage, exit 2). The command runs in its own process group with stdin ignored; signals go to the group, SIGKILL after 60 s or on a second signal, and the same bounded wait applies to group members left after a normal exit, before the slots go back. Tests: `scripts/test/eval-lock.test.mjs`.

Beyond the design: a shared request re-reads the marker after claiming its slot and backs off if one went up (marker-then-scan against claim-then-check, so a `--slots 5` request can't slip in behind the exclusive scan); signals within 2 s of the first count once, as in createEval, so a wrapper's duplicate forward doesn't SIGKILL an eval mid-cleanup; `MIDSTUDY_EVAL_LOCK_GRACE_S` shortens the grace for tests only.

During the wave a worktree still on the old script keeps respecting the new holders, but it can still reclaim a live holder past 180 min by age, until it merges this.

## State machines W7: integration-close

Gates on `sm-next` at c7ba919, run with `MIDSTUDY_TRACK=integration`: `npm run check` all ok; `eval:engine-races` 73/73; `eval:selftest` 50/50; `eval:selftest-runner` 18/18; `eval:ui-smoke` 189/189. `npm install --package-lock-only` changes nothing and `tscert/baseline.json` needs no entries (879 certified, 879 baselined), so neither file changed. No `eval:all` or `eval:calib` here: the wave's merge runs them.

`eval:perf --compare evals/perf/baseline.json`, exclusive, exit 1 on both runs, against v1's numbers. For attribution the same gate ran once at 3a25cc6, the commit before wave 1. Machine load was 14 to 30 in these runs: other worktrees were busy.

| Metric | v1 baseline | 3a25cc6 | c7ba919 run 1 | c7ba919 run 2 |
|---|---|---|---|---|
| splat_first_frame | 303 ms | 14.15 s WORSE | 13.03 s WORSE | 13.63 s WORSE |
| render_keep_room | 746 ms | 1.74 s WORSE | 1.67 s WORSE | 1.78 s WORSE |
| drag_frames_p50 | 66.6 ms | 108.4 ms WORSE | 109.5 ms WORSE | 108.4 ms WORSE |
| planner_load_desktop_warm | 1.79 s | 2.21 s WORSE | 2.5 s WORSE | 2.16 s WORSE |
| api_scenes_p95 | 0.75 ms | 0.77 ms same | 1.78 ms WORSE | 1.92 ms WORSE |
| planner_load_desktop | 1.8 s | 2.22 s same | 3.41 s WORSE | not flagged |
| drag_frames_p95 | 68.3 ms | not flagged | 123.9 ms same | 167.6 ms WORSE |
| drag_splat | 3.04 s | not flagged | 3.16 s same | 4.09 s WORSE |

The first four rows (and `render_keep_room_client`) are not from the state-machine waves. `api_scenes_p95` is new in both runs, about 1 ms, cause not looked for. The last three rows failed in one run of two. One run at the earlier commit is thin evidence for anything but the large rows.

**A/B, 2026-11-10** (`eval:perf --target pre:<3a25cc6> --target now:<1cf66ed>`, interleaved, exclusive lock, started at
5-minute load below 8): no metric is worse after the waves, on WebGPU or on WebGL2 (`MIDSTUDY_WEBGPU=0`).
`api_scenes_p95` 0.84 → 0.87 ms; the 1.8 to 1.9 ms above was load (14 to 30), and the extra `.calibrating` and input
checks per scene cost about 0.03 ms. On WebGL2 every edit and render metric matches within 2 %. `splat_first_frame` on
WebGPU, 9 runs each: 11.97 s → 12.01 s (one 35 s outlier on each side across the runs). `planner_load_phone` is
bimodal on both commits (about 1.25 s, or 2.1 s when a ~950 ms script task lands), so a 5-run median can land on
either. What still fails `--compare` against v1 (splat first frame, drags, keep-room render, warm load) predates
wave 1: v2 against v1, not the state-machine work.

Deviation: `docs/notes/state-machines.md` is listed in this package but isn't tracked on `sm-next` and sits in the main checkout, outside this worktree; its close-out is here and in STATUS.md instead.

## Merge of `nix-mast3r` (2026-11-13)

`origin/nix-mast3r` (b8f7900, branched at 3a25cc6) merged into `main` as 9b87071. One conflict, `calib/src/midstudy_calib/rooms/mast3r.py`: W7 had replaced `ensure_code()` with a flock on `<parent>/.mast3r.lock` and a `.midstudy-ready` stamp, and the branch had added a `.midstudy-commit` stamp for the Nix store copy (no `.git`). Main's provisioning is kept; the store copy is checked first, with no lock, because the lock file can't be created next to a copy in `/nix/store`. A copy has to be stamped *and* have no `.git` to count, so a git checkout is never trusted on a stamp alone. Two tests in `calib/tests/test_mast3r_provision.py`: the right commit is used with no git call and no lock file (parent folder read-only), and another commit is refused. Gates: `check:py` ok, calib pytest 200 passed and 5 skipped, the `midstudy-calib` and `mast3r.code` derivations for x86_64-linux evaluate, `nix flake check --no-build --all-systems` ok. Not built: they are Linux packages, and nothing here builds them. `docs/notes/rooms-calib.md` still says MASt3R isn't packaged; that was true when it was written.

