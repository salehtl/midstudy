# rooms-calib: the Phase A solver spike (A2)

Track calib, branch `rooms-calib`, new files only under `calib/spike/`; nothing is wired into `midstudy-calib`.
Plan: [docs/ROOMS.md](../ROOMS.md) §2, §3.1, §5 (A2). Stage 1 built the script and checked conventions; **stage 2
(the Phase A measurement on A1's golden room fixtures) is the section "Stage 2" below, with the table for Gate A.**

## What exists

| File | What |
|---|---|
| `calib/spike/pyproject.toml`, `uv.lock` | the spike's own uv project (Python 3.12). Base deps (numpy, pillow, scipy) are all Manhattan needs; the `ml` extra adds torch, torchvision, huggingface-hub, safetensors, einops, opencv-python-headless, roma, scikit-learn, trimesh, matplotlib, tqdm. calib's own lock and checks are untouched. |
| `calib/spike/setup.sh` | clones Solv3R, VGGT and MASt3R at pinned commits into `$MIDSTUDY_SPIKE_REPOS` (default `~/.cache/midstudy-spike/repos`), `uv sync --extra ml`, and downloads the official weights into the Hugging Face cache (`--no-weights` skips that). Nothing big goes in the repo. |
| `calib/spike/run.py` | the one script: N scene folders → per member `pose {x_m, z_m, yaw_deg}`, `scale`, `confidence`, `residual_cm` (ROOMS.md §3.1, first member = origin), `loop_residual_cm`, `unplaced`, timing (cold/warm) and peak memory; `--truth` adds the error row. |
| `calib/spike/make_virtual.py` | a convention check of my own: re-renders a golden scene (photo, depth.png, the floor plane) from 4 known §3.1 poses by forward splatting into `evals/out/`. Not a measurement (splatted photos, one source viewpoint); it proved the pose signs before A1's fixtures exist. |

Pinned: Solv3R `ef8da34` (github.com/ubc-vision/solv3r), VGGT `a288dd0` (facebookresearch/vggt), MASt3R `f5209af`
(naver/mast3r, with its dust3r/croco submodules). Weights: `jgkwak/solv3r` `solv3r.safetensors` (448 MB),
`facebook/VGGT-1B` `model.pt` (4.7 GB), `naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric` (2.6 GB).

## How to run (exact commands for stage 2)

From the worktree root (`/Users/saleh/Developer/claude-workspace/midstudy/.claude/worktrees/rooms-calib`; in another
worktree use its own path, and `MIDSTUDY_SPIKE_REPOS` if the repos live elsewhere):

```sh
nix develop -c calib/spike/setup.sh            # once: venv, repos, weights (~8 GB in ~/.cache); idempotent

# one solver over a room: first folder = origin (A1's room frame is living-wide's, so put it first)
nix develop -c uv run --project calib/spike python calib/spike/run.py \
  fixtures/scenes/living-wide fixtures/scenes/room-1 ... fixtures/scenes/room-6 \
  --solver solv3r --truth --out evals/out/rooms-spike/room-solv3r.json
#   --solver solv3r | vggt | mast3r | manhattan
#   --device auto (default: cuda, then mps, then cpu) | mps | cpu
#   --repeat 2 (default): solve twice in one process; timing.cold_s = import + model load + first solve, warm_s = second
#   stdout: one JSON object (progress and the solvers' own chatter go to stderr)

# all four, every member set you want (stderr kept for the timing lines):
for s in manhattan solv3r vggt mast3r; do
  nix develop -c uv run --quiet --project calib/spike python calib/spike/run.py <dirs...> --solver $s --truth \
    --out evals/out/rooms-spike/room-$s.json > /dev/null 2> evals/out/rooms-spike/room-$s.log
done

# the convention check (virtual members of living-wide with known poses)
nix develop -c uv run --project calib/spike python calib/spike/make_virtual.py fixtures/scenes/living-wide \
  --out evals/out/rooms-spike/virtual
V=evals/out/rooms-spike/virtual
nix develop -c uv run --project calib/spike python calib/spike/run.py $V/v0 $V/v1 $V/v2 $V/v3 $V/v4 --solver manhattan --truth
```

Each folder needs `photo.jpg`, `calib.json` and `depth.png` (contract §4.2); `truth.json` is read only for
`--truth` (`pose_in_room {x_m, z_m, yaw_deg}`, optional `scale`; a `truth.json` without `pose_in_room` counts as the
origin, as the five original golden scenes all stand at living-wide's camera). The answer's `truth` block holds
`pos_err_cm_median/max`, `yaw_err_deg_median/max`, `scale_err_pct_max`, `unplaced`, `confident_wrong` (a placed member
off by more than 2× a Phase A target with confidence ≥ 0.5) and a row per member. Truth is re-expressed relative to
the first member, so any member order works.

Real photos need MoGe first (calib's own CLI, outputs under `evals/out/`, never committed):
`nix develop -c uv run --project calib midstudy-calib run <photo> --out evals/out/rooms-spike/real/<name>`.

## How a solver's answer becomes a §3.1 pose

1. The ML solver gives each view a camera-to-world pose (OpenCV axes) in its own frame and units, intrinsics and a
   depth map. Solv3R: `cameras_from_pose_enc` (camera-to-world, as its docstring says; checked: tilt ≤ 0.2° on the
   virtual set); VGGT: `pose_encoding_to_extri_intri` (world-to-camera, inverted); MASt3R: sparse global alignment's
   `cam2w`.
2. Each scene's calib gives that camera's rotation in its own floor-up frame (`Rx(pitch)·Rz(roll)`, three.js axes →
   OpenCV by `diag(1, −1, −1)`). Each view's up in the solver frame is `Rs·Rcᵀ·ŷ`; their mean is the room's up;
   `tilt_deg` per member is how far its own up is from the mean (solver vs calib disagreement about the floor).
3. A rotation takes that up to +Y; the yaw of each view is the Ry turn left in `A·Rs·Rcᵀ`; the room yaw puts the first
   member at 0.
4. **Scale** (decision, below): the floor. Pixels that the calib calls floor (`depth.png` 0 and clearly below the
   horizon) give the solver's floor height along the room's up (median over all views); metres per solver unit make
   the first member's camera height its calib `height_m`; each member's `scale` makes its effective camera height
   (`height_m × scale`, §3.1) the solver's. `scale_by_depth` (depth.png against the solver's depth) is reported beside
   it as a diagnostic; it is the fallback when no view shows floor.
5. Positions: `σ·A·(c_i − c_0)`, x and z are the pose. Together that is the 2D similarity on the floor, fixed by the
   first member.

**Manhattan** (no ML): each member's `depth.png` lifted floor-up through its own calib (points 0.1–2.0 m high);
the walls' direction mod 90° from depth normals (`|n_y| < 0.25`, the circular mean of 4θ); then each member is placed
against the room built so far by FFT cross-correlation of 5 cm top-down density maps over the four 90° turns and
scales 0.94–1.06 (step 0.02), refined by 2D ICP (turn and shift). Greedy: the best-matching remaining member next.
`peak_ratio` (best vs best other turn) feeds its confidence.

**Residual and confidence (every solver):** each member's `depth.png` points lifted into the room and projected into
every other member's camera; the median |view-axis depth difference| (cm, room scale) over points the other member
sees within 50 cm = `residual_cm` (median over its pairs); `loop_residual_cm` = the median over all pairs (for a
joint solver there is no loop to close, so this is the pairwise agreement). Confidence =
`min(1, overlap/0.3) · exp(−residual/20 cm) · exp(−tilt/5°) · solver's own (Manhattan's peak ratio)`; under 0.15 the
member is `unplaced` (its pose kept as `rejected_pose` for inspection). The first member is always 1.

## Results (stage 1: sanity checks, not the Phase A measurement)

All on this Mac (M3 Max, 36 GB), MPS unless noted; runs in `evals/out/rooms-spike/runs/`.

**Virtual set** (living-wide + 4 virtual members at known poses, 0.2–0.7 m and 12–30° apart, `make_virtual.py`):

| solver | pos err median / max (cm) | yaw err median / max (°) | scale err max (%) | unplaced | confident wrong | cold / warm (s) | peak mem (GB) |
|---|---|---|---|---|---|---|---|
| manhattan (CPU) | 0.36 / 0.45 | 0.02 / 0.08 | 0.0 | 0 | 0 | 4.9 / 4.5 | 0.17 |
| solv3r | 0.81 / 1.31 | 0.04 / 0.22 | 0.73 | 0 | 0 | 3.5 / 1.1 (CPU: 5.7 / 3.3) | 1.2 RSS + 3.7 MPS (CPU 7.3) |
| vggt | 1.08 / 1.70 | 0.07 / 0.13 | 0.06 | 0 | 0 | 11.6 / 2.6 | 10.4 RSS + 9.8 MPS |
| mast3r | 1.77 / 3.57 | 0.15 / 0.51 | 0.49 | 0 | 0 | 35.1 / 25.6 | 5.8 RSS + 4.5 MPS |

**Golden scenes** (living-wide, steep-roll, portrait, living-cool, living-warm: one camera position, so the truth is
identity; portrait's aspect differs, which exercises the pad path): every solver near identity. Solv3R pos ≤ 0.7 cm,
yaw ≤ 0.05°, scale ≤ 1.2 %; VGGT pos ≤ 4.2 cm; Manhattan ≤ 0.3 cm; MASt3R pos ≤ 6.0 cm, scale ≤ 6.7 %, loop 20 cm
(zero baselines are degenerate for its triangulation-based alignment).

**Mixed** (v0–v2 plus the real lounge photo, a different room): every solver left the lounge photo `unplaced`. Joint
solvers are disturbed by the stranger: Solv3R's v1 error went 0.8 → 3.5 cm, VGGT's to 4.3 cm, and MASt3R placed v1
and v2 60–90 cm off, but with confidence < 0.01, so they were unplaced, not confidently wrong.

**Real photos** (`fixtures/photos/`: the camera original, the chat copy and the AI-empty version, all one viewpoint;
calibrated with real MoGe into `evals/out/rooms-spike/real/`): every solver loads them. The camera original and the
chat copy are **the same image**, so their true relative pose is identity: Solv3R (0.2 cm, 0.06°), VGGT (0.3 cm,
0.11°), MASt3R (0.0 cm, 0.00°), Manhattan (16.6 cm, 0.87°, with confidence 0.71: a confidently wrong placement).
Scales from the floor: 1.056 (Solv3R), 1.058 (VGGT), 1.056 (MASt3R), consistent with the two MoGe heights
(1.432 / 1.356 = 1.056). Residuals are 13–19 cm for every ML solver: MoGe's depth of the two copies disagrees by that
much (and `scale_by_depth` disagrees with the floor scale by 14–27 %: reflective marble, glass), so on real photos the
residual measures MoGe as much as the solver.

## Stage 2: the golden room (the Phase A measurement)

A1's fixtures (`rooms-foundation` at `0540806`, `fixtures/scenes/{living-wide,room-1..room-6}`, `truth.json`
`pose_in_room` in living-wide's frame), copied into `evals/out/rooms-spike/fx/` (synthetic renders; nothing from a
user photo). True scale is 1 for every member (each fixture's calib carries its true height). Hard cases: room-6 faces
a bare wall (0 % overlap with living-wide, 58 % with room-3); room-4 stands 4.7 m away facing back (12–22 % overlap
with room-1, 18 % with living-wide).

### New in stage 2 (all under `calib/spike/`)

- `bench.sh FIXTURES OUT TAG [SOLVERS…]`: every solver over five member sets: **all** (living-wide + room-1..6, 7
  photos), **low-overlap** (room-1, room-4), **low-overlap-lw** (living-wide, room-4), **blank-wall** (room-3, room-6),
  **blank-wall-lw** (living-wide, room-6). First folder = origin. `REFINE=icp` adds `--refine icp`.
- `table.py OUT [--members] [--min-conf X]`: the worse of the runs per (set, solver), per metric. `off_target` = placed
  members outside any target (5 cm, 1.5°, 2 %) at any confidence; `confident_wrong` = run.py's (off by more than 2× a
  target with confidence ≥ 0.5). `--min-conf X` re-reads the answers as if MIN_CONFIDENCE were X.
- `run.py`: **a constraint factor in every member's confidence** (decision below) and `--refine icp` (a negative
  result, below; off by default).

### Exact commands (worktree root; the eval lock was held exclusively for every timed run)

```sh
F=../rooms-foundation/fixtures/scenes; X=evals/out/rooms-spike/fx; mkdir -p $X
cp -R $F/living-wide $F/room-* $F/steep-roll $F/portrait $F/living-cool $F/living-warm $X/
for r in r1 r2; do
  nix develop -c node scripts/eval-lock.mjs --exclusive --wait-min 120 -- calib/spike/bench.sh $X evals/out/rooms-spike/s2c $r
done
# 11 photos (the 7 + the four other goldens at living-wide's spot), for run time at a realistic count:
bash -c 'X=evals/out/rooms-spike/fx; O=evals/out/rooms-spike/s2c-n11; mkdir -p $O
  D="$X/living-wide $X/room-1 $X/room-2 $X/room-3 $X/room-4 $X/room-5 $X/room-6 $X/steep-roll $X/portrait $X/living-cool $X/living-warm"
  for r in r1 r2; do for s in solv3r vggt mast3r manhattan; do
    nix develop -c node scripts/eval-lock.mjs --exclusive --wait-min 60 -- uv run --quiet --project calib/spike \
      python calib/spike/run.py $D --solver $s --truth --out $O/n11-$s-$r.json > /dev/null 2> $O/n11-$s-$r.log
  done; done'
calib/spike/.venv/bin/python calib/spike/table.py evals/out/rooms-spike/s2c [--members] [--min-conf 0.5]
calib/spike/.venv/bin/python calib/spike/table.py evals/out/rooms-spike/s2c-n11
```

Each `run.py` call solves twice in one process (`--repeat 2`: cold = import + load + first solve, warm = second), and
each set was run in two processes (r1, r2): four solves per cell, the table shows the worse process per metric.
Earlier passes kept for the record: `s2/` (before the constraint factor), `s2-icp/` (with `--refine icp`), `s2-n11/`.

### Result: the full room (7 photos), worse of 2 runs, default MIN_CONFIDENCE 0.15

Target: yaw ≤ 1.5°, position ≤ 5 cm, scale ≤ 2 %, ≤ 1 unplaced, no confident wrong placement.

| solver | pos median / max (cm) | yaw median / max (°) | scale max (%) | unplaced | off target | confident wrong | cold / warm (s) | peak mem (GB) | meets target |
|---|---|---|---|---|---|---|---|---|---|
| **MASt3R** | 1.29 / **2.28** | 0.09 / 0.21 | 0.37 | 1 (room-6) | 0 | 0 | 66.9 / 55.8 | 11.4 | **yes** |
| Solv3R | 3.44 / 19.36 (room-4) | 0.42 / 1.04 | 2.61 (room-3) | 1 (room-6) | 2 | 1 (room-4, conf 0.57) | 5.4 / 2.4 | 6.1 | no |
| VGGT | 4.64 / 12.42 (room-4) | 0.07 / 0.50 | 1.94 | 1 (room-6) | 2 | 1 (room-4, conf 0.65) | 14.8 / 5.5 | 22.3 | no |
| Manhattan | 1.46 / 13.55 (room-1) | 0.17 / 0.35 | 2.0 (grid step) | 1 (room-6) | 2 | 1 (room-1, conf 0.92) | 8.8 / 8.4 (CPU) | 0.2 | no |

**11 photos** (the same 7 + four at living-wide's spot), worse of 2 runs: MASt3R 3.16 cm / 0.49° / 0.32 %, 1 unplaced
(room-6), 0 off target, **152 s cold / 135 s warm**, 11.6 GB; Solv3R 15.7 cm (room-4, conf 0.69: confident wrong),
12.7 / 10.1 s, 8.8 GB; VGGT 10.5 cm (room-4, conf 0.81: confident wrong), 31.0 / 18.5 s, 27.1 GB; Manhattan 13.7 cm
(room-1, conf 0.92: confident wrong), 25.8 / 25.4 s, 0.3 GB. MASt3R's time grows with the pairs (it matches every
pair): ~56 s for 7 photos, ~135 s for 11.

### The hard subsets (pairs; the second photo is the hard one)

| set | MASt3R | Solv3R | VGGT | Manhattan |
|---|---|---|---|---|
| low-overlap (room-1 → room-4, 12–22 %) | placed **14.5 cm** off, conf 0.31–0.32 | unplaced | placed **16.3 cm**, 1.04°, 2.25 %, conf 0.30 | placed **321 cm / 89°** off (wrong 90° turn), conf 0.16 |
| low-overlap-lw (living-wide → room-4, 18 %) | placed **19.6 cm**, 1.13°, conf 0.17–0.21 | unplaced | placed **11.5 cm**, conf 0.40 | placed **321 cm / 89°**, conf 0.33 |
| blank-wall (room-3 → room-6, 58 %) | unplaced | unplaced | unplaced | unplaced |
| blank-wall-lw (living-wide → room-6, 0 %) | unplaced | unplaced | unplaced | unplaced |

No solver places room-4 within target from a single low-overlap partner; every one that places it does so with
confidence under 0.5 (never "confident wrong"), but at the default MIN_CONFIDENCE 0.15 they are still **placed**
(off target). With **MIN_CONFIDENCE 0.5** (`table.py --min-conf 0.5`) every such pair placement becomes unplaced and
MASt3R's full-room row is unchanged (all its placed members have confidence ≥ 0.76); Solv3R's and VGGT's room-4 still
pass 0.5 and stay confidently wrong. In the full room, MASt3R places room-4 within 1.5 cm via the other photos.

### What the numbers say

- **Yaw is easy for every ML solver** (≤ 1.1° everywhere they place). **Position is the discriminator**: Solv3R and VGGT
  are 10–20 cm off on the far, wide-baseline photo (room-4, 4.7 m away; 3–4 % along the line of sight) while their
  residual (2.5–5 cm) and confidence (0.57–0.81) look fine. MASt3R's per-pair matching with metric depth places it at
  1.2–1.5 cm.
- **Manhattan** fails on its own scale grid (0.02 steps: room-1 picks 0.98 → 13.5 cm off at confidence 0.92) and on
  low overlap (the wrong 90° turn). Fine as the no-dependency fallback only when the user checks the result.
- **Run to run**: Solv3R, VGGT and Manhattan are deterministic (identical numbers in r1 and r2); MASt3R's sparse global
  alignment is not (positions differ by ~0.1–0.5 cm between runs; before the constraint factor, its blank-wall
  placement's confidence went 0.32 → 0.44 → 0.60 across runs).

## Stage 2 decisions

- **Confidence gets a geometric constraint factor** (`constraint()` in run.py, `CONF_CONSTRAINT = 0.1`). Before it,
  every solver placed or nearly placed room-6 (the bare wall) along the wall: MASt3R put it **2.0 m off with confidence
  0.32–0.60** (0.60 = confident wrong, in the 11-photo run), because a plane slid along itself leaves the depth
  residual small. The factor is λmin/λmax of the horizontal parts of the member's own depth.png surface normals: 0.000
  for room-6, 0.36–0.92 for every other fixture photo. It is solver-independent, needs no tuning on the answers (the
  gap is wide), and it is a property of the photo, so Phase B can also tell the user *why* ("this photo shows only one
  wall: include a corner or furniture"). It was added after seeing the stage-2 numbers: say so at Gate A.
- **MIN_CONFIDENCE: recommend 0.5 for Phase B** (the spike default stays 0.15 so the tables are comparable). Also
  chosen after seeing the numbers; it turns every low-overlap pair placement (11–20 cm off, confidence 0.17–0.40; Manhattan's 3 m flips 0.16–0.33) into
  unplaced and costs MASt3R nothing on the full room. It does not rescue Solv3R or VGGT (their room-4 errors carry
  0.57–0.81). The confidence formula is still uncalibrated beyond these fixtures.
- **`--refine icp` is a negative result; do not build it.** Re-fitting each member (turn + floor shift) against the
  others' depth points by trimmed ICP (`s2-icp/`) made Solv3R and VGGT worse on the full room (to 62 and 282 cm max: a
  wrong member drags the others), and it **made wrong placements look right**: after ICP, MASt3R's 2 m blank-wall
  placement had residual 0.18 cm and confidence 0.78–0.81, and Solv3R/VGGT's blank-wall pair placements became
  confident wrong. It helped only MASt3R's low-overlap pairs (worst 20.3 → 5.7 cm). The residual is only a confidence signal
  if the solver did not minimise it.

## Install, licence

Measured on disk: the spike's venv 0.96 GB (torch 0.58 GB, opencv 0.12 GB, scipy 0.07 GB); repos MASt3R 11 MB,
Solv3R 68 MB, VGGT 144 MB; weights below. Total per solver (venv + repo + weights): **MASt3R ≈ 3.6 GB, Solv3R ≈
1.5 GB, VGGT ≈ 5.8 GB, Manhattan ≈ 0.1 GB** (numpy, scipy, pillow; already in calib).

| solver | install (beyond calib's torch) | weights | licence |
|---|---|---|---|
| Solv3R | torch stack ~0.75 GB (shared with calib), repo 68 MB (mostly examples) | 0.45 GB | code Apache-2.0; weights **NVIDIA non-commercial** (research and evaluation only; `LICENSES/NVIDIA-LICENSE.txt`), built on DVLT |
| VGGT | same stack, repo 144 MB | 4.7 GB | code: VGGT License (commercial use allowed, not military, since 2025-07-29); `facebook/VGGT-1B` weights **non-commercial**; `VGGT-1B-Commercial` exists but is gated behind an application form (not used here) |
| MASt3R | same stack + roma, scikit-learn, trimesh, matplotlib (~60 MB), repo 11 MB | 2.6 GB | **CC BY-NC-SA 4.0**, checkpoints also bound by their training sets' terms (`CHECKPOINTS_NOTICE`, several non-commercial) |
| Manhattan | numpy, scipy, pillow (~0.1 GB), no weights | none | ours |

None needs CUDA: all four ran on MPS (`PYTORCH_ENABLE_MPS_FALLBACK=1` is set but no fallback warning appeared).
Solv3R's bfloat16 autocast is CUDA-only, so on MPS/CPU it runs in fp32 (as its `autocast()` does by design).

## Decisions

- **Scale comes from the floor, not depth ratios** (ROOMS.md §3.1 leaves "scale relative to the first member" open on
  how). My first version used depth.png ÷ the solver's depth; on the real photos it gave 1.11 and 0.93 for a pair that
  should be 1.056 (heights disagreed by 8 and 18 cm), because MoGe's depth and its floor disagree there. The floor
  version makes every member's effective camera height agree with the solver's, which is what the planner draws
  (furniture stands on y = 0). The depth version stays as `scale_by_depth` and as the fallback.
- **Pose definition:** `p_room = Ry(yaw)·(scale·p_scene) + (x, 0, z)` — scale applies in the scene frame before the
  turn, so `(x, z)` is where the member's camera stands on the room floor. This matches §3.1 (pose maps the scene
  frame; scale multiplies the effective camera's height). The contract (A1) should say so in these words.
- **Mixed aspects:** when members' aspect ratios differ, each photo is fitted into a square and centred on white (VGGT's
  "pad" mode) for Solv3R and VGGT; the same aspect keeps the native aspect. MASt3R uses its own loader (centre crop).
- MASt3R needed one shim: its `sparse_ga.py` calls `scipy.cluster.hierarchy.distance`, an alias newer scipy dropped;
  `run.py` restores it. Photos reach MASt3R as symlinks named `m00.jpg…` in a temp dir (its cache keys on names).
- The spike is ruff-clean under calib's config (calib's `ruff check calib` covers `calib/spike/`); calib's pyright
  `include` doesn't cover it, and it isn't pyright-strict (torch and the solver repos are untyped).

## Recommendation for Gate A

**MASt3R** is the only candidate that meets every Phase A target on the golden room: 2.3 cm / 0.21° / 0.37 % worst over
7 photos (3.2 cm / 0.49° / 0.32 % over 11), one unplaced photo (the bare wall, correctly), no wrong placement at any
confidence in the full room, in both runs. Its costs, plainly:

- **Licence: CC BY-NC-SA 4.0** (non-commercial, share-alike), and the checkpoint is also bound by its training sets'
  terms, several non-commercial. Fine for this personal tool; it rules out any commercial use of the feature as built.
- **Run time: ~1 minute for 7 photos, ~2.3 minutes for 11** on MPS (M3 Max), growing with the number of pairs; cold
  start adds ~10 s. A room alignment is a background job (ROOMS.md §3.3), so this is a wait, not a freeze, but 12
  photos will be over 2 minutes.
- **Memory ~11.5 GB peak** (RSS + MPS, an upper bound on unified memory); 2.6 GB of weights, ~3.6 GB installed.

Alternatives, if the licence or the wait is unacceptable: **Solv3R** (2–10 s, 6–9 GB, NVIDIA non-commercial weights) or
**VGGT** (5–18 s, 22–27 GB, non-commercial weights; a commercial checkpoint exists behind an application form) both
miss the position target on the far photo by 3–4× and do so with high confidence, so either would need the user to
check every alignment (Phase B's Align photos mode). **Manhattan** (no ML, ours) misses too (scale grid, 90° flips on
low overlap) and stays the no-dependency fallback per ROOMS.md §5 Phase B. In Phase B, keep the constraint factor and
use MIN_CONFIDENCE 0.5 whichever solver is chosen.

## Open issues

- **Synthetic fixtures only.** All stage-2 numbers come from A1's renders (exact depth, exact calib, flat-shaded
  surfaces). Real photos bring MoGe's depth error (13–19 cm residual on the real lounge pair, stage 1) and real texture
  (which may help the ML solvers more than these renders do). The ranking may change in Phase D; the real E20 / `eval:real-room` decides.
- **Confidence is tuned after the fact** on these fixtures (CONF_CONSTRAINT, and the 0.5 threshold recommendation);
  nothing holds out. Solv3R's and VGGT's far-photo errors are invisible to the residual, so no threshold fixes them.
- **Low-overlap pairs are unsolved by everything**: a room-4-like photo can only be placed through a third photo that
  overlaps both (as in the full room). ROOMS.md §7's photo advice ("each photo overlaps the previous") matters.
- MASt3R is non-deterministic at the ~0.5 cm level; Phase B's pytest against truth needs a tolerance, not equality.
- The first member is always the origin with confidence 1 (stage 1 issue, unchanged): if it is the bare wall or a
  stranger, everything else looks wrong. Phase B should pick the best-constrained, best-connected member as origin.
- `check-ownership calib --base main` with this branch's script fails on `docs/notes/rooms-calib.md` only; A1's script
  on `rooms-foundation` (which accepts `docs/notes/rooms-<track>.md`) passes. It resolves when A1's branch merges.
- Peak memory = peak RSS + peak MPS driver memory, an upper bound on unified memory. Each model load contacts the
  Hugging Face Hub for its revision (no photo data); Phase B should pin revisions and load offline.
- calib/spike is ruff-clean (`check:py` ok) but not pyright-strict and not `ruff format`-ed (not gated).
