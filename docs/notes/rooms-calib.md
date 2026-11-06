# rooms-calib: the Phase A solver spike (A2, stage 1)

Track calib, branch `rooms-calib`, new files only under `calib/spike/`; nothing is wired into `midstudy-calib`.
Plan: [docs/ROOMS.md](../ROOMS.md) §2, §3.1, §5 (A2). Stage 2 measures on A1's golden room fixtures with the commands
below.

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

## Install, licence

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

## Open issues (for stage 2 and Gate A)

- **No measurement yet on wide baselines.** Everything above has at most 0.7 m and 30° between photos and one source
  render; A1's golden room fixtures (6 cameras, a low-overlap pair, a blank wall) are the real test. Expect the ML
  solvers to differ much more there; Manhattan's greedy matching is untested on partial overlap.
- **Confidence is uncalibrated.** Weights (`CONF_OVERLAP`, `CONF_RESIDUAL_CM`, `CONF_TILT_DEG`, `MIN_CONFIDENCE` at the
  top of `run.py`) were set by eye on these sets; stage 2 should tune them on the room fixtures against
  `confident_wrong`. Manhattan placed a real photo 16.6 cm off with confidence 0.71: the residual can't tell a shift
  that MoGe's own depth error allows.
- The first member is always the origin with confidence 1; if it is the stranger (a photo of another room), every other
  member looks wrong. Phase B should pick the origin by the solver's agreement, or let the user reorder.
- Peak memory: `peak_mem_gb` = peak RSS + peak MPS driver memory (sampled at 0.1 s); on unified memory these may
  overlap, so it is an upper bound. VGGT's 10 GB RSS is the fp32 checkpoint loaded on the CPU before moving to MPS.
- Timing note: Manhattan's first-ever run took 15 s cold (scipy import / bytecode); later colds were ~2–5 s.
- Every model load asks the Hugging Face Hub whether its revision moved (a network round trip, unauthenticated;
  nothing about the photos is sent). Phase B should pin revisions and load offline, as calib does for MoGe.
- `scripts/ownership.json` already gives `calib/**` to calib, so `calib/spike/` needs no new entry.
