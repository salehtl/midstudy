# f-perf (v2 Phase 1): E17, the performance eval, and the v1 baseline

Branch `v2-f-perf`, forked from `v2` at `0d40ff5`. Owns `evals/perf.mjs` and `evals/perf/**` (plus `eval:perf` in
`package.json`). Plan: [docs/REFACTOR.md](../REFACTOR.md) §4. Times below are UTC, as in the result files.

## What exists

| File | What |
|---|---|
| `evals/perf.mjs` | **E17** (`npm run eval:perf`). Measures every row of REFACTOR.md §4.1 through what every eval uses (the HTTP API, the `window.midstudy` hook, the CLIs) and the target worktree's own `evals/lib/harness.mjs`, so the same file measures v1, v2, or both interleaved. |
| `evals/perf/baseline.json` | The v1 baseline: the quietest of three full runs (every sample with its load average, machine, commits, commands) plus each metric's run-to-run `noise` and `run_medians` from all three. App code: `planner/`, `pipeline/`, `calib/`, `contract/` exactly as `main`'s `e1b717f` (v2's Phase 0 changed only the eval harness and `fixtures/make_scene.mjs`). |
| `evals/perf/profile_product.py` | `--profile` helper: cProfile of v1's product page reader in-process (the server reads pages in a handler thread, which cProfile can't see). |

## Run and check it

Always through the lock; `--exclusive` for numbers you'll keep (it takes all three slots machine-wide):

```
nix develop -c node scripts/eval-lock.mjs --exclusive -- npm run eval:perf -- --with-calib            # 5 runs + 1 warm-up, 8–10 min
nix develop -c node scripts/eval-lock.mjs --exclusive -- npm run eval:perf -- --compare evals/perf/baseline.json
nix develop -c node scripts/eval-lock.mjs -- npm run eval:perf -- --runs 1 --warmup 0 --only server,api   # smoke, ~10 s
nix develop -c node scripts/eval-lock.mjs --exclusive -- npm run eval:perf -- --profile --with-calib     # profiles, ~1 min
nix develop -c node evals/perf.mjs --results evals/out/perf/results.json --compare evals/perf/baseline.json  # no measuring
```

- `--repo <worktree>` measures another worktree with *its* harness, server, CLI and fixtures (default: this one).
- **A/B (REFACTOR.md §4.2):** `--target v1:<legacy worktree> --target v2:<v2 worktree>[:MIDSTUDY_SERVER=next,MIDSTUDY_ADD=next]`.
  Every suite's runs alternate between the targets in ABBA order (A B B A A B …), so a linear drift in machine load
  cancels, and every later target is compared with the first. Env after the path applies to that target only (one
  worktree twice with different switches works). Each target gets its own server and browser. Recipe below.
- `--compare <file>`: compare this run with a results or baseline file. `--results <file> --compare <file>`: compare two
  files, measure nothing. `[--label v1] --make-baseline a.json b.json c.json`: write `evals/perf/baseline.json` from the
  quietest run (lowest mean 1-min load over its samples) with each metric's noise across the runs. `--baseline`: write
  it from this run alone (within-run noise).
- `--only`/`--skip` take suite or metric names; `--runs N` (5), `--warmup N` (1), `--product-all` (adds the two pages
  whose answer is the 20 s read limit), `--out <file>` (a copy of results.json), `--label`.
- Output: `evals/out/perf/results.json` (every sample with its load average before/after, machine, commits incl. the last
  commit that changed app code, the commands), `evals/out/perf/table.txt`, `evals/out/perf/profiles/<label>/`
  (`.cpuprofile`, `.trace.json`, `.pstats`, `summary.json`). Exit 1 on a regression past the allowance or a metric with
  no valid sample.
- `MIDSTUDY_SERVER` / `MIDSTUDY_ADD` pass through to the target's harness (every server and CLI it starts inherits them).
  The two commands E17 spawns itself (`server_start`, `add_cli_*`) come from the harness's `serverCommand()` /
  `addCommand()` when it exports them (requested below), else legacy = `python3 planner/serve.py` /
  `uv run --project pipeline midstudy-add` and next = `node server/src/main.ts` / `node pipeline/src/cli.ts` (REFACTOR.md
  §1); `MIDSTUDY_PERF_SERVER_CMD` / `MIDSTUDY_PERF_ADD_CMD` override.

Checked in this session: every suite end to end (three full baseline runs, 0 failed samples in runs 2 and 3), A/B with
one worktree as both targets (ratios 0.94–1.09 at load 28, "no regression"), `--compare` of run 3 against the baseline
(ratios 0.94–1.03 except the spiky `server_start` 0.67; exit 0) and of a copy with two metrics doubled (both `WORSE`,
exit 1), `--make-baseline`, `--profile --with-calib`.

## The metrics

Each: N runs (default 5) after one warm-up, median and p95 over the runs, `os.loadavg()` before and after every sample.
Times in ms. Browser numbers are headless Chrome 147 on SwiftShader (no real GPU), like every eval.

| Suite | Metric | Exactly |
|---|---|---|
| server | `server_start` | spawn → first `200` on `/planner/` (polled every 5 ms), fresh probe library, empty scenes |
| api | `api_{scenes,library,layouts}_{p50,p95}` | 200 sequential GETs per route per run (Node's default agent); 2 scenes; layouts of a scene with 3 |
| product | `product_read_{p50,p95,max}` | `POST /api/library/product {url, llm: false}` for the 55 pages of `fixtures/product-pages/manifest.json` (all but `slow` and `trickle`, whose answer is the 20 s limit), served by `evals/lib/pages_server.mjs`; per-page times in the samples |
| cli | `add_cli_{idol,sam3d,glb,rug}` | the furniture CLI end to end, fal mock, empty library, network blocked (E8's proxies), wall time incl. interpreter start-up, with bytecode/compile caches (decisions) |
| load | `planner_load_desktop`, `_desktop_warm`, `_phone` | fresh context → `/planner/?scene=<living-wide>` → `midstudy.ready` resolved + two animation frames, from navigation start; every sample checked on a screenshot (the photo at its place, median difference ≤ 12 levels). Extras: requests and KB by origin (the CDN in v1), heap after GC, long tasks, main-thread script/other time, when `window.midstudy` appeared. `_warm`: the same page reloaded |
| scene | `scene_open` | `openScene(living-wide)` from the Scenes page of a loaded planner, timed in the page; long tasks |
| edit | `add_item_glb`, `add_item_glb_textured` | `addItem()` of the probe box, then SheenChair (4 MB, 7 textures), first time in the page |
| edit | `drag_frames_{p50,p95}` | rAF intervals during a 2 s one-way mouse drag of the probe box (a move every 16 ms of wall time), checked that the piece moved |
| edit | `render_capture`, `render_keep_room` (+ `_client`, `_server`) | `renderView({model: 'nano-banana'[, keepRoom: true]})`, mock; `_server` = the `POST /api/render` fetch (Resource Timing), `_client` = the rest (capture, mask, encoding) |
| edit | `add_item_splat`, `splat_first_frame` | `addItem()` of the Idol fixture item (262,144 splats, made through the library API with the fal mock); then until the view is idle (three 2-frame round trips under 150 ms) |
| edit | `drag_splat` | a 5-move mouse drag of the probe box with the splat in view, ms per move until drawn |
| edit | `render_capture_splat` | `renderView()` with the splat in view (Spark sorts for the capture camera) |
| calib | `calib_first`, `calib_second` (`--with-calib`) | real MoGe-2: a fresh server, two uploads of golden living-wide one after the other, `POST /api/scenes` → job done; extras: MoGe's own `load_s`/`infer_s`/`floor_fit_s` from `calib.json` |

Each edit run uses a fresh copy of living-wide (no renders, no layouts) in a fresh page, and waits for the scene's
thumbnail PUT before measuring.

**Compare allowance.** A metric fails when `now > base × (1 + 10 % + noise)` and `now − base > 1 ms` (noise capped at
100 %). Against a baseline file, `noise` is the metric's measured run-to-run noise: the relative range of the per-run
medians over the baseline's three runs (two medians of the same code differed by that much tonight, so a smaller
difference can't be told from noise). In an A/B run it's the samples' own: 2σ of a difference of two medians
(2·√2 · 1.2533 · 1.4826 · MAD / √n, relative), the larger of the two targets', because interleaved samples share the
machine's load and the run-to-run range is mostly load changes. The 1 ms floor keeps sub-millisecond API timings from
failing on scheduler jitter. Informational metrics (`info: true`, none at present) never fail.

## The v1 baseline (`evals/perf/baseline.json`)

Run 2 (2026-11-05 19:26–19:34Z, mean 1-min load 8.1 over its samples), with the medians of all three runs:

| Metric | Median | p95 | Run medians (runs 1 / 2 / 3) | Noise | Notes |
|---|---:|---:|---|---:|---|
| `server_start` | 181 ms | 183 ms | 163 ms / 181 ms / 122 ms | 36 % |  |
| `api_scenes_p50` | 0.65 ms | 0.66 ms | 0.98 ms / 0.65 ms / 0.64 ms | 53 % |  |
| `api_scenes_p95` | 0.75 ms | 0.77 ms | 1.34 ms / 0.75 ms / 0.74 ms | 82 % |  |
| `api_library_p50` | 0.32 ms | 0.35 ms | 0.39 ms / 0.32 ms / 0.32 ms | 22 % |  |
| `api_library_p95` | 0.40 ms | 0.49 ms | 0.59 ms / 0.40 ms / 0.39 ms | 51 % |  |
| `api_layouts_p50` | 0.41 ms | 0.42 ms | 0.50 ms / 0.41 ms / 0.39 ms | 27 % |  |
| `api_layouts_p95` | 0.47 ms | 0.56 ms | 0.73 ms / 0.47 ms / 0.44 ms | 61 % |  |
| `product_read_p50` | 1.10 ms | 1.10 ms | 2.00 ms / 1.10 ms / 1.10 ms | 82 % |  |
| `product_read_p95` | 2.99 ms | 3.15 ms | 5.78 ms / 2.99 ms / 2.85 ms | 98 % |  |
| `product_read_max` | 1.76 s | 1.77 s | 2.13 s / 1.76 s / 1.74 s | 22 % | the `huge` page (12 MB); next: `gzip-bomb` 200 ms, then ≤ 6 ms |
| `add_cli_idol` | 852 ms | 858 ms | 1.36 s / 852 ms / 840 ms | 61 % |  |
| `add_cli_sam3d` | 413 ms | 429 ms | 596 ms / 413 ms / 413 ms | 44 % |  |
| `add_cli_glb` | 175 ms | 180 ms | 297 ms / 175 ms / 170 ms | 72 % |  |
| `add_cli_rug` | 191 ms | 195 ms | 309 ms / 191 ms / 186 ms | 64 % |  |
| `planner_load_desktop` | 1.80 s | 1.90 s | 3.07 s / 1.80 s / 1.78 s | 72 % | 53 requests, 1,414 KB (CDN: 12, 451 KB); `window.midstudy` at 193 ms; heap 4.7 MB; long tasks 774 ms |
| `planner_load_desktop_warm` | 1.79 s | 1.81 s | 1.93 s / 1.79 s / 1.77 s | 9 % | 53 requests, 963 KB (12 from the HTTP cache); `window.midstudy` at 155 ms |
| `planner_load_phone` | 1.76 s | 1.87 s | 3.57 s / 1.76 s / 1.72 s | 106 % | 50 requests, 1,391 KB (CDN: 12, 451 KB); `window.midstudy` at 199 ms |
| `scene_open` | 843 ms | 895 ms | 919 ms / 843 ms / 831 ms | 10 % | long tasks 105 ms, script 22 ms |
| `add_item_glb` | 4.7 ms | 4.7 ms | 8.2 ms / 4.7 ms / 4.6 ms | 77 % |  |
| `add_item_glb_textured` | 25 ms | 25 ms | 45 ms / 25 ms / 24 ms | 85 % |  |
| `drag_frames_p50` | 67 ms | 67 ms | 83 ms / 67 ms / 67 ms | 25 % | 33 frames, 31 moves in 2 s: 15 fps |
| `drag_frames_p95` | 68 ms | 74 ms | 133 ms / 68 ms / 67 ms | 96 % |  |
| `render_capture` | 406 ms | 471 ms | 619 ms / 406 ms / 399 ms | 54 % |  |
| `render_capture_client` | 399 ms | 464 ms | 604 ms / 399 ms / 391 ms | 54 % |  |
| `render_capture_server` | 7.5 ms | 7.7 ms | 9.5 ms / 7.5 ms / 8.4 ms | 24 % |  |
| `render_keep_room` | 746 ms | 805 ms | 832 ms / 746 ms / 734 ms | 13 % |  |
| `render_keep_room_client` | 700 ms | 759 ms | 776 ms / 700 ms / 688 ms | 13 % |  |
| `render_keep_room_server` | 46 ms | 47 ms | 56 ms / 46 ms / 47 ms | 21 % | the stub's `align` (a Python start) |
| `add_item_splat` | 157 ms | 163 ms | 793 ms / 157 ms / 159 ms | 400 % | 262,144 splats, 3,916 KB (CDN: Spark, 868 KB) |
| `splat_first_frame` | 303 ms | 322 ms | 437 ms / 303 ms / 299 ms | 46 % |  |
| `drag_splat` | 3.04 s | 3.63 s | 3.40 s / 3.04 s / 3.03 s | 12 % | per move: 15.2 s for 5 moves |
| `render_capture_splat` | 11.47 s | 11.58 s | 13.93 s / 11.47 s / 11.54 s | 21 % |  |
| `calib_first` | 8.02 s | 8.06 s | 8.98 s / 8.02 s / 7.75 s | 15 % | MoGe load 4.41 s, inference 1.31 s; the tool's total 7.65 s |
| `calib_second` | 7.84 s | 8.77 s | 8.52 s / 7.84 s / 7.74 s | 10 % | MoGe load 4.25 s, inference 1.29 s; the tool's total 7.43 s |

### How noisy (the Mac was busy tonight)

| Run | When | Mean 1-min load | Failed samples |
|---|---|---:|---:|
| 1 | 18:24–18:34Z | 14.7 (suites at 10–17) | 2 (`drag_frames`: the mid-drag check, since fixed) |
| 2 (baseline) | 19:26–19:34Z | 8.1 (2.7–5 except the edit suite, 13–17) | 0 |
| 3 | 19:51–19:59Z | 11.3 | 0 |

- **At moderate load (runs 2 and 3) the medians reproduce within 2 % on 26 of 34 metrics and within 6 % on all but two**
  (`server_start` 49 %: a ~0.15 s Python start, spiky; `render_capture_server` 12 %: an ~8 ms request).
- **At load ≈ 15 (run 1) everything CPU-bound is 1.1–2× slower**: planner loads 1.7–2.0×, the CLI 1.4–1.7×, renders 1.5×,
  `add_item_splat` 5× (the CDN fetch of Spark); the GPU-bound splat metrics and the calibration (MPS) only 1.1–1.2×.
  SwiftShader and Python compete for the same cores as the other agents' Rust, Lean and fuzzing jobs, which don't take
  the eval lock.
- Within a run, the 5 samples are tight (the medians' 2σ is under 5 % for most metrics).
- So the baseline's `noise` column (range over the three runs, dominated by run 1) is large: a later `--compare` against
  it allows 10 % + 20–100 %, which only catches gross regressions. **Decisions need the A/B** (§4.2), whose allowance
  comes from the interleaved samples themselves; the A/A check at load 28 stayed within ±9 %.

## Critical areas: the largest costs, against REFACTOR.md §4.1's targets

| Area (v1 median) | Where the time goes (profiles below) | §4.1 target, as measured |
|---|---|---|
| Splats in view: `render_capture_splat` 11.5 s, `drag_splat` 3.0 s per move, `splat_first_frame` 0.3 s | the GPU process rasterizing 262,144 splats (99 % busy); the splat pass is redrawn on every mesh move | "measured": SwiftShader numbers; a GPU sort won't show here (Dawn's SwiftShader adapter rasterizes on the CPU too). Not redrawing splats while a mesh moves would |
| Calibration: `calib_first` 8.0 s, `calib_second` 7.8 s | model build 3.3 s (random init), torch import 1.2 s, a Hugging Face request 0.5 s, inference ~1.3 s | "2nd photo ≥ 30 % faster": the warm worker removes ≈ 5 s, so ≈ 60 % is in reach; the random init and the Hub request are avoidable on the first photo too |
| Planner cold load: 1.80 s desktop, 1.76 s phone (53 / 50 requests, 12 from the CDN) | GPU frames and shader links (`onFirstUse` 0.75 s); the module graph is 0.2 s at load 8 but 1.3 s at load 15 | "≥ 40 % faster, far fewer requests": the bundle removes 40 requests and the CDN, but ≥ 40 % also needs the shader-compile wait gone |
| Product page read: max 1.76 s (`huge`), p95 3 ms, p50 1.1 ms | `html.parser` and per-node regexes over 136,000 elements | "≥ 2× on p95, no page over 1 s": p95 is 3 ms already (2× on it is noise-level); the real target is `huge` under 1 s |
| Furniture CLI: Idol 852 ms, SAM 3D 413 ms, GLB 175 ms, rug 191 ms | gzip level 9 (0.24 s) and the covariance eigen-solve (0.34 s) for Idol; ~0.15 s start-up each | "≥ 3×": needs both kernels in Rust and a cheap start; GLB and rug are mostly start-up |
| `scene_open` 843 ms | the GPU process (99 % busy); `loadDepth` 6 ms, `shEquirect` < 1 ms | "≥ 3× on those steps": achievable on the steps, but they are ~1 % of the metric |
| `render_keep_room` 746 ms (page 700 ms, server 46 ms) | two synchronous 1600 × 1200 `readPixels` (0.43 s) and first-use shader links; `dilate` + `captureMask` 23 ms | "mask ≥ 3×": the JS loops are ~3 % of it; the readbacks are the cost |
| API: p50 0.32–0.65 ms, p95 0.40–0.75 ms | Python stdlib, a new connection per request | "no regression": easy to keep; Node with keep-alive should be faster |

## Profiles: where the biggest costs go (v1, `--profile --with-calib`, 19:40Z, load ≈ 13)

Chrome's CPU profiler (main thread, 200 µs sampling) and a Chrome trace (how busy the GPU process's main thread was)
around each browser operation; cProfile for Python (the CLI, the calibration, the product reader in-process). Files:
`evals/out/perf/profiles/rf-f-perf/` (`*.cpuprofile` and `*.trace.json` open in Chrome DevTools, `*.pstats` in
`python -m pstats` or snakeviz). "Self" is time in the function itself.

**The browser is GPU-bound on SwiftShader; our own JS is 1–3 % of every browser metric.** In every browser operation
the GPU process's main thread (SwiftShader executing WebGL command buffers, `CommandBufferService:PutChanged`) is busy
for 92–99 % of the wall time, and the renderer's main thread either idles or blocks in a synchronous WebGL call that
waits for it:

| Operation (wall) | GPU process busy | Main thread, top self time |
|---|---:|---|
| `planner_load_desktop` (1.86 s) | 1.71 s | `(program)` 885 ms (native: module compile, GL waits); **`onFirstUse` (three.module.js:6491) 747 ms**: three.js's `debug.checkShaderErrors` calls `getProgramInfoLog` on each new program's first use, which blocks until SwiftShader has compiled and linked it; `engine.js:570` 12 ms, `canvasRect` 10 ms, `loadDepth` 5.7 ms |
| `scene_open` (885 ms) | 875 ms | idle 740 ms; `getProgramInfoLog` 103 ms (shader links); `loadDepth` 5.8 ms; `shEquirect` 0.5 ms |
| `render_keep_room`, first render in a page (1.96 s) | 0.45 s | **`getProgramInfoLog` 1,422 ms** (the capture and mask programs link on first use); `readPixels` 428 ms (two synchronous 1600 × 1200 readbacks); `toDataURL` 33 ms; `dilate` 14 ms; `captureMask` 9 ms |
| `render_capture_splat` (7.9 s) | 7.84 s | `readPixels` 3,870 ms + idle 3,620 ms: SwiftShader rasterizing 262,144 splats for the sort and the capture |
| `add_item_splat` (160 ms) | 67 ms | idle 141 ms (the CDN module, `splat.spz`, Spark's worker) |

So the JS loops §4.1 moves to Rust/WASM (`loadDepth`, `dilate`, `captureMask`, `shEquirect`, hull hit tests) are worth
6–25 ms each here: a 3× on them is real but moves `scene_open` and `render_keep_room` by 1–3 %. What would move the
browser metrics on this machine (and, scaled down, on a phone's GPU):

1. **Shader programs**: 0.75 s of the load and 0.1–1.4 s of the first open or render are the main thread waiting for
   program links. `renderer.debug.checkShaderErrors = false` outside development stops the blocking query; compile the
   known materials up front with `renderer.compileAsync()` (KHR_parallel_shader_compile); fewer program variants.
2. **Synchronous readbacks**: every render reads 1600 × 1200 back twice with `readPixels` (0.43 s here). An async
   readback (PBO + fence: three's `readRenderTargetPixelsAsync`), or the keep-room mask drawn from the pieces' projected
   boxes (it's dilated by 3 % anyway; in Rust/WASM with no GPU round trip), removes most of it.
3. **The splat pass redraws on every mesh move** (its key includes every piece's transform, because meshes hide
   splats): a drag with the Idol chair in view costs ≈ 3 s per frame in software (`drag_splat`). Drawing splats against
   a cached mesh depth, or not redrawing them while a mesh is dragged, matters more for Phase 4 than the GPU sort.
   Real-GPU numbers need a real device.
4. **The cold load's module graph**: `window.midstudy` appears 1.3 s after navigation on a cold load at load ≈ 15 and
   ≈ 0.2 s at load 8 or on the warm reload (12 CDN modules, 451 KB, parsed and compiled each time): v2's one minified
   bundle targets exactly this.

**The furniture CLI** (`add_cli_idol`, 923 ms wall with bytecode): `zlib.compress` 243 ms (the SPZ, `gzip` level 9 in
`splat.py:266`), `numpy.linalg.eigh` 215 ms + `det` 41 ms + `transform_covariances` 45 ms + `matrix_to_quat` 38 ms (the
per-axis covariance fit of 262,144 splats, `splat.py:136`), then interpreter and extension start-up (~0.15 s). SAM 3D
(483 ms): the same two, smaller. A Rust splat crate with a closed-form 3 × 3 eigen-solve and a faster deflate (or level
6) covers ~60 % of the Idol add; without bytecode (the dev shell's default) add ~0.33 s of `compile`.

**The product page reader**: every page but two answers in 1–6 ms. `huge` (12 MB, read up to the 10 MB cap) takes
1.8–2.1 s (3.8 s under cProfile): Python's `html.parser` over 136,000 elements (`goahead` 352 ms, `parse_starttag`
216 ms, `parse_endtag` 191 ms, `updatepos` 117 ms) and per-text-node regexes (`re.search` 577 ms in 272,000 calls,
`re.sub` 303 ms, `re.match` 231 ms in 1.1 M calls, `_squash` 145 ms, `_nl` 103 ms), plus `_unit_hint` 171 ms in one
call. `gzip-bomb` (186 ms): the socket read (94 ms) and one `re.sub` (73 ms). A linear-time Rust parser would put `huge`
well under 1 s; nothing else needs it.

**The calibration** (one real `midstudy-calib run`, 7.6 s profiled, cumulative): building the MoGe-2 model 3.31 s, of
which **3.28 s is PyTorch's random weight initialization** (`trunc_normal_` 2.52 s in 97 calls, `kaiming_uniform_`
0.76 s in 185 calls) that the checkpoint then overwrites; importing `moge` (torch) 1.23 s; **a Hugging Face Hub
metadata request on every run** (`hf_hub_download` → `get_hf_file_metadata`, 0.50 s of TLS connect, handshake and
read, even with the weights cached); inference 0.88 s; the lighting fit 0.25 s; the floor fit 0.08 s; ingest 0.04 s.
calib.json's own timings agree (`load_s` 4.25–4.41 s of `elapsed_s` 7.4–7.7 s). For the calib track: the warm worker
removes ≈ 5 s of ≈ 8 s from the second photo on; constructing the model without the random init
(`torch.device('meta')` + `load_state_dict(assign=True)`, or `skip_init`) saves ~3.3 s on the *first* photo too;
`HF_HUB_OFFLINE=1` when the weights are cached saves 0.5 s and the network round trip.

## Decisions (and why)

- **The target's own harness, imported per target** (`<repo>/evals/lib/harness.mjs?perf=<label>`, a module instance each,
  env applied around every call): v1's harness starts v1's server, v2's starts whatever `MIDSTUDY_SERVER` says, and the
  fixtures are each worktree's own. E17 never reads `planner/`, `server/` or `pipeline/` source; it drives the hook, the
  HTTP API and the CLIs, like E1–E16.
- **A fresh browser context per run, one warm-up run discarded.** The first page load in a browser compiles every
  shader into the GPU process's program cache and renders the library's missing thumbnails (probe box, SheenChair) and
  the scene's; the first CLI and calibration runs write bytecode. The measured runs are "a fresh page in a browser that
  has run the planner before". Each target gets its own browser, so caches never cross between v1 and v2.
- **"Shown" = `midstudy.ready` resolved + two animation frames**, checked on a screenshot every run (the photo at its
  place, median difference ≤ 12 levels): the same definition works for any renderer that presents frames, WebGPU too.
  Hook calls are timed inside the page (`performance.now()`), so CDP round trips aren't counted.
- **Compile caches as an installed tool has them.** The dev shell sets `PYTHONDONTWRITEBYTECODE=1`, so every
  `midstudy-add` recompiled ~280 modules (0.33 s of cProfile self time in `compile`) and every calibration recompiled
  torch's ~2,500 modules (none had bytecode); the Nix packages ship bytecode. E17 removes the variable for the CLI and
  the calibration server (and gives Node `NODE_COMPILE_CACHE`, for v2's CLI). The other servers keep the harness's
  environment (serve.py loads `product_page.py` without bytecode by design anyway).
- **Product pages: all but `slow` and `trickle`** (their answer is the 20 s read limit, by design; E14 checks them);
  `--product-all` adds them. Status mismatches are recorded (`extra.unexpected`), not failed: E14 judges answers.
- **The edit suite uses a fresh copy of living-wide per run** and waits for its thumbnail PUT: renders accumulate in a
  scene, and the first open saves a thumbnail in the background.
- **The CDN counts.** v1's cold load fetches 12 files (451 KB) from jsdelivr; that is a real cost the v2 bundle removes,
  so it stays in `planner_load_*` (the extras split requests and bytes by origin). `planner_load_desktop_warm` is the
  returning user (CDN cached; v1 serves its own files `no-cache`).
- **Splat metrics by moves, not by frames.** Spark's work lands asynchronously, so a "median of moves" was bimodal
  (16 ms / 68 ms / 3.7 s in one run). With the splat in view each drag frame costs seconds, so a time-boxed drag got two
  moves in; `drag_splat` is a fixed 5-move drag, ms per move. `render_capture_splat` is the deterministic one.
- **Drags read the piece's position only after the drag is drawn**: Chrome aligns pointer moves with animation frames,
  so under load a mid-drag read came before the moves were applied (2 false "didn't move" in run 1, fixed before runs 2
  and 3; run 1's 4 valid drag samples measured the same frames on a there-and-back path).
- **ABBA interleaving per suite run** for A/B: A and B samples are seconds apart, and a linear drift in load cancels.
- **API latency with Node's default agent** (keep-alive when the server allows it, as a browser does): v1's
  `http.server` closes every connection, a real cost the comparison should see.
- **The baseline was measured from `v2-f-perf`** (`9a3a828`), whose app code is v2's `0d40ff5` (identical to `main`'s
  `e1b717f` for `planner/`, `pipeline/`, `calib/`, `contract/`); the extra commits add only `evals/perf*`.

## Requests to other tracks

- **f-contract (`evals/lib/harness.mjs`)**: export `serverCommand()` and `addCommand()`, each returning the argv prefix
  the harness itself runs for the current `MIDSTUDY_SERVER` / `MIDSTUDY_ADD` (e.g. `['python3', 'planner/serve.py']`,
  `['node', 'server/src/main.ts']`; `['uv', 'run', '--project', 'pipeline', 'midstudy-add']`,
  `['node', 'pipeline/src/cli.ts']`). E17 uses them when present for the two things it spawns itself (`server_start`
  needs its own 5 ms poll; `add_cli_*` times the CLI alone); until then it mirrors those commands. And let
  `startServer(ev, { env: { MIDSTUDY_STRICT: '0' } })` override strict mode, so E17 can measure the new server's
  production configuration; if strict mode stays forced, E17's v2 numbers include the validation (say so in the A/B).
- **f-contract (`evals/README.md`)**: add the E17 row (not in `eval:all`: ~10 min and it needs the exclusive lock):
  `| npm run eval:perf | **E17** evals/perf.mjs (f-perf): performance, the same way on any worktree (--repo, A/B with
  --target a:<path> --target b:<path>): server start, API latency, product page reads, the furniture CLI, planner load
  (desktop, warm, phone), scene open, adds, drag frames, renders (page/server split), the Idol splat, and with
  --with-calib real MoGe calibrations. Median and p95 of 5 runs after a warm-up, load averages recorded; --compare
  evals/perf/baseline.json fails a metric worse by more than 10 % + its measured noise. See docs/notes/f-perf.md. | $0,
  ~10 min, under scripts/eval-lock.mjs --exclusive |`
- **gate-1 / whoever owns `scripts/eval-lock.mjs`**: exclusive waiters deadlock each other. Each `--exclusive` waiter
  takes slots as they free up and holds them, so two waiters each sit on part of the slots for good (tonight: calib's
  A/B, the WebGPU spike's perf check and this baseline); my first run-2 waiter was killed (SIGTERM, not by me) after
  ~30 min holding two slots. Suggested fix: an exclusive waiter takes slots only when all are free at once (or a FIFO
  ticket, releasing partial slots while an older ticket waits). E17's baseline runs used a wrapper that waits for an
  empty lock directory, then asks with `--wait-min 2` and retries.
- **engine / ui (Phase 2), webgpu-spike, calib, pipeline, product**: the findings under "Critical areas" and "Profiles"
  (shader links, synchronous readbacks, the splat pass redrawn per mesh move; MoGe's random init and Hub request; gzip
  level 9 and `eigh`; `huge`).

## The final A/B (Phase 4), step by step

```
git worktree add .claude/worktrees/perf-v1 0d40ff5          # v1 as baselined (or the v1 commit being compared)
(cd .claude/worktrees/perf-v1 && nix develop -c npm install)  # its harness imports playwright-core from its own tree
nix develop -c node scripts/eval-lock.mjs --exclusive -- \
  node evals/perf.mjs --with-calib --target v1:.claude/worktrees/perf-v1 --target v2:. --out evals/out/perf/ab.json
```

E17 runs from the v2 tree and imports each target's own harness, so v1 is measured exactly as v1's evals run it
(`serve.py`, `uv run … midstudy-add`, the CDN importmap) and v2 as v2's do. The first run of each target is a warm-up
(it also syncs `pipeline/` and `calib/` venvs and writes bytecode). The table ends with "compare v2 against v1": the
ratio of medians per metric, failing when v2 is worse by more than 10 % + the larger within-run noise of the two.
Before cutover, one worktree can be both targets: `--target legacy:. --target next:.:MIDSTUDY_SERVER=next,MIDSTUDY_ADD=next`.

## What's left / open

- E17 has only measured v1: nothing of v2 exists yet. The A/B machinery was checked with one worktree as both targets.
- The `next` commands are guesses from REFACTOR.md §1 until the harness exports `serverCommand()` / `addCommand()`;
  strict mode for the new server is whatever the harness forces (request above).
- `--profile` profiles v1's Python server code in-process (product reader) and the CLI under cProfile or
  `node --cpu-prof`; profiling a Node server process (v2) isn't wired in yet (run it with `--cpu-prof` by hand).
- All browser numbers are SwiftShader's; the splat metrics especially say little about a phone's GPU.
- A cross-time `--compare` against the baseline is lenient (tonight's run-to-run noise is large); rely on A/B.
