# midstudy v2: the refactor plan

> **Done.** v2 replaced v1 on `main` at `84dd8ad` (2026-11-06); WebGPU passed its gate and is the default, and Spark
> went with it. The plan below is kept as written. Where things stand: [STATUS.md](STATUS.md).

Branch `v2`, forked from `main` at `e1b717f` (2026-11-05). Goal: the same product (contract/CONTRACT.md stays the
behavioural spec), rebuilt so that it is **faster where it matters** and **much more rigorous**: every boundary typed
from one schema source, the logic certified or proved where tools allow it, hot paths in Rust compiled to WebAssembly,
and no dead or duplicate code left behind. The work runs as dynamic workflows (agent fan-out with gates between
phases), shaped by Anthropic's "Building agents: when to fold subagents into your main agent loop" (§9).

Nothing here changes what the user sees, except the speed (and WebGPU if it passes its gate, §4.4).

---

## 1. Target stack

| Layer | v1 | v2 |
|---|---|---|
| Spec | CONTRACT.md + 5 file schemas | the same, plus **API schemas** for every HTTP JSON payload (`contract/api/`), and **generated** TS types, standalone validators and Rust types from them (`contract/gen/`, drift-checked) |
| Planner (browser) | ~6k lines of JS, no build, three.js and Spark from a CDN | **strict TypeScript**, bundled by esbuild (three.js 0.180 and Spark from npm, no CDN), pure logic in self-contained modules checked by **TScert** |
| Hot kernels | JS loops and Python/numpy | **Rust → WebAssembly** (wasm-bindgen, SIMD128), in a Web Worker in the browser and loaded by Node on the server |
| Renderer | three.js `WebGLRenderer`, Spark 2.4 for splats, hand-written GLSL passes | WebGL first (Phase 3). **WebGPU** (three.js `WebGPURenderer` + TSL, WebGL2 fallback built in, our own WebGPU splat renderer with a GPU sort) lands in Phase 4 **only if every browser eval passes on both backends** (§4.4) |
| Server | `planner/serve.py` (2,658 lines) + `planner/product_page.py` (2,219), stdlib Python | **TypeScript on Node 22** (`node:http`, no framework: the §2.9 framing rules need low-level control), run directly with Node's type stripping (`node server/src/main.ts`), validating its own responses and files against the schemas in strict mode |
| Furniture CLI | `midstudy-add`, Python (trimesh, numpy, Pillow) | **TypeScript on Node 22** (`node pipeline/src/cli.ts`) with Rust kernels for splats and bytes, gltf-transform for GLB, obj2gltf for OBJ zips, libheif-js for HEIC |
| Calibration | Python, MoGe-2 loaded per photo | **stays Python** (PyTorch), now **pyright-strict** with types generated from the schemas, outputs validated before they are written, and a **warm worker** (`midstudy-calib serve`) so MoGe loads once |
| Proofs | none | **Lean 4 + Mathlib** (`proofs/`): the camera model of contract §4.1 over ℝ, rotations, clamps, units; **Aeneas** extracts the integer Rust kernels to Lean where it builds on this Mac |
| Rust checks | — | `#![forbid(unsafe_code)]` outside the wasm glue, clippy `-D warnings`, proptest, **Miri**, **cargo-fuzz** on every byte parser, **Kani** if it can be packaged in Nix |
| Browser for evals | Helium | headless Chrome from the user's flake (`$PUPPETEER_EXECUTABLE_PATH`), WebGL on SwiftShader, WebGPU on Dawn's SwiftShader adapter |

### Decisions and deviations (with the evidence)

- **WebGPU is gated, not assumed.** Headless Chrome here exposes WebGPU only with `--enable-unsafe-webgpu
  --use-webgpu-adapter=swiftshader` on a secure-context page (tested 2026-11-05: compute shaders run; there is no real
  GPU in the headless shell, so GPU speed is measured in software only). Spark 2.4 is WebGL2-only (RawShaderMaterial),
  and the occlusion, photo and shadow passes are GLSL. So WebGPU needs our own splat renderer and TSL ports of those
  passes. That work starts as a spike in Phase 1 and lands in Phase 4 if it passes every browser eval on WebGPU **and**
  on the WebGL2 fallback (`MIDSTUDY_WEBGPU=0`). Otherwise it stays on branch `v2-webgpu`.
- **Calibration stays Python.** MoGe-2 is PyTorch. Its speed problem is architectural (the model reloads for every
  photo, about 4 s of 10), so the fix is the warm worker, not a language.
- **TScert covers what it can, and the code is shaped for it.** TScert (a research checker, Lean-backed, one function
  at a time, refuses `any`, trusts library types through reviewed contracts) cannot be assumed to read DOM, three.js
  or Node APIs. So v2 follows *functional core, imperative shell*: pure logic in self-contained modules that only
  import types (`planner/logic/`, `server/src/logic/`, `pipeline/src/logic/`), certified by TScert; the shells (DOM,
  WebGL, HTTP, files) stay under strict tsc and lint. A ratchet (`tscert/baseline.json`) records every certified
  function; nothing may drop off it. TScert's licence is "NON-AI MIT" (it excludes training or improving ML systems);
  running it as a checker on this code is neither.
- **Floats are tested, not proved.** Lean proves the camera model over ℝ. The Rust and TS float code is checked against
  the same properties with property tests and against the golden scenes (`truth.json`), which pin the convention.
- **The evals do not change**, except where the harness starts things: the browser (headless Chrome), the server
  (`MIDSTUDY_SERVER=legacy|next`), the furniture CLI (`MIDSTUDY_ADD=legacy|next`), strict mode, and the planner build.
  E1–E16 are the independent check that v2 behaves as v1 does.

---

## 2. Layout after the refactor

```
contract/            CONTRACT.md, *.schema.json (files), api/*.schema.json (HTTP payloads), examples/ (recorded)
contract/gen/        generated from the schemas: types.ts, validate.js (+ .d.ts); never edited by hand
core/                Rust workspace: crates/{media,geom,raster,splat,product,contract,wasm-web,wasm-node}, fuzz targets
core/js/             the typed TypeScript faces of the wasm builds (web.ts for the planner, node.ts for Node)
proofs/              Lean 4 + Mathlib (+ Aeneas output)
planner/             index.html, styles/, *.ts and ui/**/*.ts, logic/ (pure, TScert), gpu/ (WebGPU, Phase 4)
server/              src/**/*.ts (the HTTP server), src/logic/ (pure, TScert), src/product/ (the product page reader)
pipeline/            src/**/*.ts (midstudy-add), src/logic/
calib/               Python, as before, typed
evals/               as before, plus perf.mjs (E17) and perf/baseline.json
tscert/              TScert wrapper config and the ratchet baseline
scripts/             build, checks, ownership, the eval lock
build/               wasm and bundle outputs (git-ignored)
```

Removed at cutover: `planner/serve.py`, `planner/product_page.py`, the Python `pipeline/` package, every `planner/*.js`.

---

## 3. Gates

`npm run check` runs all of these; each prints one summary line and exits non-zero on failure.

| Gate | What |
|---|---|
| `check:types` | `tsc --noEmit`, `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `erasableSyntaxOnly` |
| `check:lint` | typescript-eslint strict-type-checked: no `any`, no non-null `!`, no `as` casts except `as const`, no `@ts-ignore`/`@ts-expect-error` |
| `check:dead` | knip: no unused files, exports or dependencies |
| `check:gen` | regenerate `contract/gen/`; the diff must be empty |
| `check:tscert` | TScert over the `logic/` modules; every function in `tscert/baseline.json` still certifies; prints coverage |
| `check:rust` | fmt, clippy `-D warnings` (workspace lints), tests, proptest, Miri on the byte parsers, Kani harnesses if available, a short fuzz smoke per target |
| `check:proofs` | `lake build` in `proofs/`, no `sorry`, `admit` or new `axiom` |
| `check:py` | pyright strict and ruff on `calib/` |
| `check:ownership` | a track's branch touches only its own paths (§6) |
| evals | E1–E16 (`eval:all`, run twice at each gate), E2 real and `--mock`, E17 performance |

**Strict mode** (`MIDSTUDY_STRICT=1`, set by the harness for the new server): every response body and every file the
server writes is validated against its schema; a violation is a 500 with `contract violation: …`, so every eval is
also a contract-conformance test.

---

## 4. Performance

### 4.1 Where the time goes (v1, to be measured by E17 before any change)

| Area | v1 | v2 change | Target (revised against the baseline) |
|---|---|---|---|
| Calibration, second photo onward | MoGe reloads every photo (≈4 s of ≈10 s) | warm worker | ≥ 30 % faster |
| Planner cold load to `midstudy.ready` | ~40 ES modules, three.js and Spark from jsdelivr | one minified bundle, vendored | ≥ 40 % faster, far fewer requests |
| Scene open (depth decode, environment map) | JS loops on the main thread | Rust/WASM in a worker | ≥ 3× on those steps |
| Keep-room mask, thumbnails, hull hit tests | JS loops | Rust/WASM | ≥ 3× |
| `midstudy-add` post-processing (no fal wait) | Python + numpy + trimesh start-up and loops | Node + Rust/WASM | ≥ 3× (Idol 262k splats, SAM 3D) |
| Product page read, worst fixture | Python regexes, bounded at 10 s | a linear-time parser in Rust (the `regex` crate guarantees it) | ≥ 2× on p95, no page over 1 s |
| API latency (GET scenes, library, layouts) | Python stdlib | Node | no regression |
| Splats on screen | Spark, CPU sort (1–4 s a frame on SwiftShader) | Phase 4: GPU sort in a compute shader | measured; real-GPU numbers need a real device |

### 4.2 E17 (`evals/perf.mjs`)

Written before the code changes. It measures each row above (median of 5, p95 where it applies), with machine load
recorded. The final comparison is **A/B interleaved** (legacy worktree vs v2, alternating runs on a quiet machine),
because the Mac is shared with other sessions. Gate: no metric worse by more than 10 %, and the targets met or the
miss explained with numbers.

---

## 5. Phases and workflows

One workflow per phase, so the main session reads the real results (it re-runs the gates itself) before the next
fan-out. Parallel tracks each work in **their own git worktree and branch** (`v2-<track>`, under
`.claude/worktrees/rf-<track>/`) on **paths no other track touches** (§6), so runtime state (servers, built bundles,
half-finished ports) never leaks between them. Only gate and integration agents write `v2`. Nothing is pushed.

| Phase | Workflow | Agents (parallel unless noted) |
|---|---|---|
| 0 | main session | branch, this plan, ownership and eval-lock scripts, the browser switch, the Cargo workspace root |
| 1 | `v2-foundation` | **f-toolchain** (flake, TS/esbuild/eslint/knip, Rust + wasm + Miri + fuzz, Lean, TScert, Aeneas, Kani; the planner bundle; the check scripts), **f-contract** (API schemas checked against recorded v1 responses, codegen, the harness switches), **f-perf** (E17 and the v1 baseline), **k-media** (Rust byte kernels: sniffing, JPEG/PNG/GLB metadata stripping, frame sizes, path and slug rules, zip safety; differential tests against the Python), **k-geom** (Rust geometry and raster kernels: §4.1 projection, horizon, landing, hulls, bounds, depth decode, masks, environment map, SH rotation) → then **gate-1** (one agent merges, runs every check and `eval:all` twice on v1 behaviour, commits) |
| 1x | `v2-longrun` (alongside 1–2) | **proofs** (Lean: camera, rotation, clamps, units; later Aeneas on the media kernels), **calib** (types, validation, warm worker), **webgpu-spike** (WebGPURenderer + TSL passes and a WebGPU splat renderer, as new files only, with go/no-go numbers) |
| 2 | `v2-build` | **server-core** → then **server-routes** and **product** in parallel (pipeline: they build on the core's real seams); **engine** (planner engine, lighting, input, data, hook → TS on the kernels); **ui** (planner UI → TS); **pipeline** (`midstudy-add` → TS + the splat crate); **kernels-hardening** (Kani/Miri/fuzz campaigns, SIMD) |
| 3 | `v2-integrate` | **one** integration agent: merges everything, wires the kernels, reconciles the engine/UI seam, unifies the safe fetch, switches the harness to the new server and CLI, deletes the legacy code, runs every gate twice, commits |
| 4 | `v2-harden` | **webgpu-swap** (on `v2-webgpu`; merged only if green on both backends), three read-only **verifiers** (UX/visual, contract/security/privacy, performance/rigor), **packaging** (Nix for the new server and CLI), **proofs-final** → a **fixer** → **finish** (ports any commits that landed on `main` meanwhile, final evals, A/B performance, STATUS, commit) |

Every agent returns the same structured result (status, branch, commit, checks and evals it actually ran, interfaces it
provides, decisions, open issues), and writes `docs/notes/<track>.md`.

---

## 6. Ownership

`scripts/ownership.json` is the source; `node scripts/check-ownership.mjs <track>` enforces it. Every path belongs to
exactly one track in a phase. **Shared-append files** (any track may add entries, never edit or remove others'; the
gate agent unions conflicts and regenerates the lockfile): `package.json`, `package-lock.json`, `core/Cargo.lock`.

| Track (phase) | Owns |
|---|---|
| f-toolchain (1) | `flake.nix`, `flake.lock`, `nix/**`, `tsconfig*.json`, `eslint.config.*`, `knip.*`, `scripts/**` (except the two Phase 0 scripts), `planner/index.html`, `.gitignore`, `tscert/**` |
| f-contract (1) | `contract/**` (except §4.3's worker subsection), `core/crates/contract/**`, `evals/lib/harness.mjs`, `evals/library_api.sh`, `evals/pipeline_offline.sh`, `evals/README.md` |
| f-perf (1) | `evals/perf.mjs`, `evals/perf/**` |
| k-media (1) | `core/crates/media/**`, `core/crates/wasm-node/**`, `core/js/node.ts` |
| k-geom (1) | `core/crates/geom/**`, `core/crates/raster/**`, `core/crates/wasm-web/**`, `core/js/web.ts` |
| proofs (1x–4) | `proofs/**` |
| calib (1x) | `calib/**`, CONTRACT.md §4.3 "Worker" subsection |
| webgpu-spike (1x) | `planner/gpu/**` |
| server-core, server-routes (2) | `server/**` except `server/src/product/**` (core first, then routes) |
| product (2) | `server/src/product/**`, `core/crates/product/**` |
| engine (2) | `planner/{main,engine,lighting,input,data}.*`, `planner/logic/**` |
| ui (2) | `planner/ui/**`, `planner/styles/**` |
| pipeline (2) | `pipeline/**`, `core/crates/splat/**` |
| kernels-hardening (2) | `core/crates/{media,geom,raster,wasm-web,wasm-node}/**`, `core/js/**` |
| integration (3), fixer and finish (4) | everything |

Everyone writes their own `docs/notes/<track>.md`.

---

## 7. Rules for every agent

- Work only inside your own worktree (`cd <worktree> && …` on every command; absolute paths under it for file
  tools). Commit to your own branch (`v2-<track>`) whenever useful; never write `v2` unless you are a gate or
  integration agent; never push; never change git config or remotes.
- Before you finish, `node scripts/check-ownership.mjs <track>` must pass.
- Every `npm run eval:*` goes through the lock: `node scripts/eval-lock.mjs -- npm run eval:…` (three slots machine-wide;
  `--exclusive` for performance measurements). A timing check that fails once under load is re-run before it counts.
- Browser: the harness uses `$PUPPETEER_EXECUTABLE_PATH`. Never launch Helium or any browser the user browses with.
- Money and secrets (CLAUDE.md): fal always mocked, never read `.env`, never set `FAL_KEY`. Photos: never commit
  `fixtures/photos/`, never open `fixtures/photos/private/`.
- Tools only through the dev shell (`nix develop -c …`) or one-off `nix shell nixpkgs#…`; no global installs.
- Behaviour comes from CONTRACT.md. When v1 and the contract disagree, say so in your notes and keep v1's behaviour
  unless the contract is clearly right (the evals were written from the contract).
- "partial" with precise open issues beats a false "done". Report only checks you actually ran.

---

## 8. Risks and fallbacks

| Risk | Fallback |
|---|---|
| TScert cannot read multi-file projects or our types | certify the `logic/` modules as self-contained files; ratchet whatever certifies; report coverage honestly |
| Aeneas or Kani won't build on aarch64-darwin | Lean proofs of a Lean reference implementation, differentially fuzzed against the Rust; Miri + proptest + fuzz |
| Mathlib's Lean differs from nixpkgs' | pin the Lean that Mathlib needs in `nix/` (fixed-output fetch), not elan |
| Porting the server drifts from v1 in an untested corner | the switch keeps v1 runnable until every eval passes on the new server; strict mode catches contract drift |
| The live fal path can't be tested here (mock only) | the new CLI and server record their mock requests; they must equal what v1 sends, byte for byte where it matters. A live check needs the user's OK |
| Evals flake under load | the eval lock; re-run once; `eval:all` twice at every gate |
| `main` moves on while v2 is built | the finish agent ports every new `main` commit into v2 and re-runs its evals |
| WebGPU can't pass every eval tonight | WebGL v2 ships; WebGPU stays on `v2-webgpu` with its numbers and what's left |

---

## 9. How this follows the article

"Building agents: when to fold subagents into your main agent loop" argues for **one agent loop by default**, with
subagents kept only when a single loop degrades from **context bloat**, when **independent tasks can run in parallel
with fresh, discardable context**, or when one agent would **struggle to pick the right tools**. This refactor meets all
three: 34k lines in four languages, independent components, and a different toolchain per component. So:

1. **Divide by context, not by problem type.** Each track owns a component end to end (code, types, tests, proofs for
   its slice), with a clean interface: the schemas, the wasm ABI, the HTTP routes, the CLI contracts. No "test writer"
   or "type annotator" agents over someone else's files: that is the telephone game the article warns about.
2. **Fold specialists that chain.** The product reader owns its Rust parser; the pipeline owns the splat crate; the
   server core and its routes are a pipeline, not two agents guessing at each other's seams; **integration is one
   agent**, because merging needs shared context across everything.
3. **Evals first, owned centrally.** E1–E16 are the end-to-end set, owned by the main session and the integration
   agent; E17 is written before any code changes. Each track ships its own smaller checks (unit tests, proofs, fuzz),
   as the article's skills ship their evals.
4. **A shared response schema, and verification against real data in the main loop.** Every agent returns the same
   structured result; the main session re-runs the gates itself between workflows instead of trusting reports.
5. **Hard preconditions live in tools.** Ownership, the eval lock and the mock-money guard are scripts that refuse, not
   instructions to remember.
6. **One change at a time, measured.** The server, the CLI and the renderer each switch behind their own flag and are
   evaluated alone before the next switch. Evals run twice, because one failure in two runs is still a failure.
7. **The main loop keeps the conversation.** One workflow per phase, read before the next, so the plan is revised from
   real results (the planner also executes).
