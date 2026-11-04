export const meta = {
  name: 'midstudy-v1',
  description: 'Build midstudy v1 from nook per PLAN.md: foundation, parallel build tracks, integration, black-box verify, packaging draft',
  whenToUse: 'Once, to build midstudy v1 on branch v1 from PLAN.md. Resume with resumeFromRunId after a pause.',
  phases: [
    { title: 'Foundation', detail: 'copy nook, strip scanning, rename, flake, contract, golden scenes, carried evals; commit' },
    { title: 'Build', detail: 'calib, app and evals tracks in parallel on disjoint paths; no commits' },
    { title: 'Integrate', detail: 'one agent runs every eval and fixes across boundaries; commit' },
    { title: 'Verify', detail: 'up to 2 rounds: 3 read-only black-box verifiers, then 1 fixer' },
    { title: 'Package', detail: 'NixOS module draft and docs/HANDOFF.md for the homeserver agent (alongside Verify)' },
    { title: 'Finish', detail: 'final eval run, STATUS and README; commit' },
  ],
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs. args may override the repo path; everything else lives in PLAN.md, which every agent reads itself.
const REPO = (args && args.repo) || '/Users/me/Developer/claude-workspace/midstudy'
const NOOK = `${REPO}/.upstream/nook`

const RULES = `
Repo: ${REPO} (branch v1). Nook's source, for reference and copying: ${NOOK}.
PLAN.md in the repo is the plan and the spec; read the sections your task names before you start, and read
contract/CONTRACT.md once it exists. Read docs/notes/*.md for what earlier agents left.

Hard rules:
- Tools only through the repo's dev shell: \`nix develop -c <cmd>\` from the repo root. Never brew/npm -g/pipx/nix profile install.
  Project dependencies (uv sync, npm install in the repo) are fine. Nix flakes only see files git tracks: \`git add\` new
  files (no commit needed) before relying on them through nix.
- fal is mocked: MIDSTUDY_FAL_MOCK=fixtures/fal (NOOK_FAL_MOCK before the renames land). The repo's .env holds a REAL
  FAL key: never read, print, copy, edit or delete .env, never set FAL_KEY, never make a paid call. Every serve.py or
  midstudy-add you start gets MIDSTUDY_NO_DOTENV=1 (and NOOK_NO_DOTENV=1), the mock variable, and for serve.py
  --daily-spend-usd 0, so a slip can't spend money. Evals must set these themselves.
- Real photos of the user's room are in fixtures/photos/ (git-ignored; read fixtures/photos/notes.md). Never commit them,
  never copy them anywhere tracked, and never open fixtures/photos/private/ (location data). The main real test photo
  is fixtures/photos/upper-lounge-camera.jpeg (0.5x ultrawide, EXIF without location).
- Never ssh anywhere, never touch homeserver, never git push, never change git config or remotes.
- Headless browser: Helium, /Applications/Helium.app/Contents/MacOS/Helium, with
  --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist (playwright-core, as nook's evals do).
- Servers you start: pick a free port (bind port 0 or try upward from your own base port given below) and stop every
  process you started before you finish. Scratch output goes to evals/out/ (git-ignored).
- Write what you built, how to run it and what's left to docs/notes/<your-track>.md (create or update). Be concrete.
- Your final answer is data for the orchestrator: fill the schema honestly. "partial" with clear open_issues beats a
  false "done". Every eval you report must be one you actually ran in this session.`

const COMMIT = `Commit on branch v1 with a short imperative subject and a body listing what changed and which evals passed.
End the message with the line: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Stage only paths you mean to commit (no blanket \`git add -A\` if another agent may be writing). Never push.`

const TRACK = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string', description: '3-8 sentences: what now exists and works' },
    evals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['name', 'passed'],
      },
    },
    open_issues: { type: 'array', items: { type: 'string' } },
    commit: { type: 'string', description: 'commit hash, or empty if this agent did not commit' },
  },
  required: ['status', 'summary', 'evals', 'open_issues'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    checked: { type: 'array', items: { type: 'string' }, description: 'what you actually exercised' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          area: { type: 'string' },
          title: { type: 'string' },
          repro: { type: 'string', description: 'exact steps or command' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          evidence: { type: 'string', description: 'file path of a screenshot/log in evals/out, or output excerpt' },
        },
        required: ['severity', 'area', 'title', 'repro', 'expected', 'actual'],
      },
    },
  },
  required: ['checked', 'findings'],
}

// ---------------------------------------------------------------------------------------------------------------
phase('Foundation')

const foundation = await agent(`${RULES}

You are the FOUNDATION agent (base port 8790). Read all of PLAN.md first; you own §2, §3, §5, §6.1 and the contract.
Do these in order:

1. Git: create branch v1 from main (or check it out if it exists). Add \`.upstream/\` and \`fixtures/photos/\` to
   .gitignore. If ${NOOK} is missing, \`gh repo clone salehtl/nook ${NOOK} -- --depth 1\`.
2. Copy from nook what PLAN.md §2 keeps, and nothing it drops: planner/ (whole, as is), pipeline/, evals listed there
   plus whatever they import (evals/py, mock servers they use), fixtures/fal, fixtures/models, fixtures/library,
   fixtures/library-broken, contract/library.schema.json and layout.schema.json, nix/ minus gsplat.nix,
   nook-gsplat.nix and poses.nix, package.json, flake.nix, flake.lock, .gitignore (merged with the existing one).
   Start with an empty dev library: library/library.json with no items (valid against the schema) and a costs.csv
   header only.
3. Renames per PLAN.md §2 "Renames" across everything you copied (pipeline package and console script, env vars,
   header names, window.midstudy, data-midstudy, user-visible strings and the page title). Keep it mechanical.
4. flake.nix: dev shells only for now (aarch64-darwin and x86_64-linux: python312, uv, nodejs_22, git), no packages
   (the packaging agent adds them later). \`nix develop -c true\` must work. Then \`nix develop -c npm install\`.
5. CLAUDE.md for midstudy, adapted from nook's: purpose, conventions, the ownership table from PLAN.md §3, secrets and
   cost (mock rule), tooling (nix develop, uv, Helium flags), evals. Keep it short.
6. contract/CONTRACT.md: nook's contract with every scan / rooms / iOS / Spark / hosted section removed, renames
   applied, and PLAN.md §4 folded in as the scenes, calibration, planner, hook and render sections (PLAN.md wins on
   any conflict). Write contract/scene.schema.json and contract/calib.schema.json; change layout.schema.json to
   scene_name instead of room fields.
7. fixtures/stub_calib.py (Python stdlib only): a stand-in for \`midstudy-calib run <upload> --out <dir>\` with the
   same CLI and stdout contract (PLAN.md §4.3). It accepts JPEG and PNG only, copies the upload to photo.jpg (PNG:
   refuse with a clear message unless you can convert with stdlib; JPEG is enough), reads the size from the JPEG
   header, and serves calib.json/depth.png from MIDSTUDY_CALIB_MOCK by SHA-256 of photo.jpg, else writes the
   "default" fallback. The app and evals tracks use it while calib/ is being built, and fast evals keep using it.
8. Golden scenes per PLAN.md §6.1: fixtures/make_scene.mjs (adapt nook's fixtures/make_capture.mjs: headless Helium,
   three.js 0.180.0). Use textured surfaces (wood-like floor with planks, plaster walls, a rug, a door frame,
   a window) so a monocular depth model has real cues. Write fixtures/scenes/<id>/{photo.jpg,truth.json,depth.png,
   calib.json} and fixtures/calib/<sha256 of photo.jpg>/{calib.json,depth.png}. truth.json holds the camera block and
   the world positions (corners) of the sofa box and table. Add a self-check (fixtures/check_scenes.mjs or .py) that
   projects truth.json's sofa corners with the camera block per §4.1 and confirms they land on the sofa's corners in
   photo.jpg (render a marker image or compare against an id-colour render): this pins the camera convention down,
   signs included, for every later agent. Run it and make it pass.
9. Carried evals must pass under the new names: eval:pipeline and eval:library (mocked, $0). package.json scripts:
   serve, eval:pipeline, eval:library (the evals track adds the rest).
10. Write docs/notes/foundation.md, then commit everything (PLAN.md and .claude/workflows/ included) on v1.

Do not start any feature work in planner/ beyond the renames: the app track owns that next.
${COMMIT}`, { label: 'foundation', phase: 'Foundation', schema: TRACK })

if (!foundation || foundation.status === 'blocked') {
  log('Foundation blocked; stopping before any parallel work.')
  return { foundation }
}
log(`Foundation ${foundation.status}: ${foundation.evals.filter(e => e.passed).length}/${foundation.evals.length} evals passed`)

// ---------------------------------------------------------------------------------------------------------------
phase('Build')

const CALIB = `${RULES}

You are the CALIB track (no server ports needed). You own calib/ and fixtures/photos-public/ only; do not edit any other
path (planner/ and evals/ are being written by other agents right now). Read PLAN.md §4.1–§4.3, §5, §6 and §11.

Build calib/ as a uv project (Python 3.12) exposing \`midstudy-calib\` exactly as PLAN.md §4.3 specifies: run, ingest,
fit, fallbacks, device selection (cuda → mps with PYTORCH_ENABLE_MPS_FALLBACK=1 → cpu), the MIDSTUDY_CALIB_MOCK mode,
and the one-JSON-line stdout contract, plus \`align\` (§4.3, §4.7: nano-banana's output is about 1 MP at a fixed
aspect and drifts 1-2 %, so it must be registered to the photo before the keep-room composite). Pin MoGe (git+https://github.com/microsoft/MoGe at a specific commit) and
confirm the real MoGe-2 checkpoint names on Hugging Face before choosing the default (expected
Ruicheng/moge-2-vitl-normal; the -normal variants give normals). Weights download to the HF cache, never into the
repo. Guard ingest: Pillow decompression-bomb limit, 25 MB cap, refuse anything that isn't JPEG/PNG/HEIC/HEIF/WebP.

Get the conventions right against ground truth: fixtures/scenes/*/truth.json are exact cameras, and
fixtures/check_scenes.* shows the convention. Convert MoGe's OpenCV camera frame (x right, y down, z forward) to the
three.js frame carefully and verify the signs of pitch and roll on the golden scenes, not by reasoning alone.

Real photos: use fixtures/photos/ if it has any. If it's empty, download 4-6 public-domain or CC0 interior photos
(rooms with visible floor, a mix of landscape and portrait, at least one with a rug and one taken looking down
steeply) from Wikimedia Commons into fixtures/photos-public/, with fixtures/photos-public/LICENSES.md giving each
file's source URL, author and licence. Images only; never run anything you download.

Measure and record in docs/notes/calib.md: per golden scene, the fitted camera vs truth (fov, height, pitch, roll) and
depth error; per real photo, the fitted camera, floor inlier ratio, device and runtime; first-run model download time.
Save an overlay image per photo (the 50 cm floor grid from the fitted camera drawn on the photo) in evals/out/calib/
and look at each one yourself: say in the notes whether the grid sits on the floor. If MoGe does badly on the synthetic
golden scenes but well on real photos, say so plainly; do not edit fixtures/ (the integration agent decides).
The evals track is writing evals/calib_eval.* from the spec in parallel; once it exists, run it too.`

const APP = `${RULES}

You are the APP track (base port 8800). You own planner/ (the browser app and planner/serve.py). Do not edit calib/,
evals/, fixtures/ (except new files under fixtures/ that only you use, if unavoidable), contract/ or pipeline/.
Read PLAN.md §1, §4 (all of it) and §6.2, then contract/CONTRACT.md, then planner/ as copied from nook.

Turn the nook planner into the midstudy planner:
- serve.py: the scenes API, calibration job queue and static rules (§4.4), layouts per scene, the render changes
  (§4.7: reference photo for nano-banana, keep_room + mask handled server-side by \`<calib CMD> align\`, -raw.jpg,
  new meta fields; when calib/ isn't there yet, treat align as not applied), \`--calib CMD\`
  invoked without a shell (argument list, never string interpolation of user input), \`--scenes-dir\`. Remove the
  rooms API, the scan proxy, retrain, and everything else §2 drops. Keep nook's §2.8/§2.9 behaviour (library API,
  X-Midstudy, Origin, Host allowlist, path normalisation, spend cap including renders) intact.
- Planner (§4.5): Scenes page, the locked camera from scene.json registered to the photo (letterboxed, photo drawn
  untouched by tone mapping/Look), 2D zoom and pan via setViewOffset, the floor grid and Adjust floor, items on the
  floor with drag/rotate/Up-Down, occlusion from depth.png (§4.5), layouts per scene, render capture at photo
  resolution plus the keep-room item mask (§4.7, toggle default off), and Compare in the Renders panel. Remove Spark and every
  splat/room/scan/walk/viewpoint/shell/hang/retrain path, and its UI.
- The hook and test handles exactly as §4.6 lists them (other agents' evals are written against those names).
- Phone (390 × 844, touch) and desktop both first-class; reuse nook's UI kit and look.

calib/ is being built in parallel; do not wait for it. Develop against \`--calib "python3 fixtures/stub_calib.py"\`
with MIDSTUDY_CALIB_MOCK=fixtures/calib and the golden scenes in fixtures/scenes/ (their truth.json gives exact
geometry to check registration against). The server's default --calib stays the real \`uv run --project calib
midstudy-calib\`. Check your work as you go with small playwright scripts in evals/out/ and by looking at screenshots;
the evals track is writing the official evals in evals/ in parallel, and you may run them once they exist.`

const EVALS = `${RULES}

You are the EVALS track (base port 8810). You own new files in evals/ and the eval scripts in package.json. Write the
task evals of PLAN.md §6.2 (E1-E6, E9, E10; E7 and E8 already exist) from the SPEC ONLY: PLAN.md §4 and §6,
contract/CONTRACT.md and its schemas, fixtures/. Do not read planner/ or calib/ source: these evals are the
independent check on what the app and calib tracks build at the same time. You may read nook's old evals in
${NOOK}/evals for harness patterns (starting serve.py, driving the hook in Helium, mock servers).

- Each eval starts its own server on a free port with temp scenes/layouts/renders dirs and a temp costs file, uses
  MIDSTUDY_FAL_MOCK=fixtures/fal, and, except E2, \`--calib "python3 fixtures/stub_calib.py"\` with
  MIDSTUDY_CALIB_MOCK=fixtures/calib. They must never write into the repo's own scenes/, layouts/, renders/ or library.
- E2 (evals/calib_eval.*) runs \`uv run --project calib midstudy-calib\` against fixtures/scenes/*/photo.jpg and
  compares to truth.json with §6.2's tolerances; \`--mock\` covers ingest only (generate test inputs yourself: a
  rotated-EXIF portrait JPEG, PNG, WebP, an oversize file, a non-image; HEIC if you can produce one on this Mac, e.g.
  with \`sips -s format heic\`).
- Print one PASS/FAIL line per check with the measured value, exit non-zero on any FAIL, and fail clearly ("hook
  missing: getScreenRect") rather than crash when the implementation isn't there yet.
- Wire package.json: eval:scenes-api, eval:calib, eval:planner, eval:occlusion, eval:floor, eval:render, eval:phone,
  eval:all (E1 and E3-E9; E2 with --with-calib). Document each in evals/README.md (rewrite nook's for midstudy).

Prove the harnesses themselves work: run each against what exists now and report which checks fail only because the
feature isn't built yet versus because the eval is wrong. Things you can check today (fixtures vs truth, stub calib,
carried library API) must pass.`

const build = await parallel([
  () => agent(CALIB, { label: 'build:calib', phase: 'Build', schema: TRACK }),
  () => agent(APP, { label: 'build:app', phase: 'Build', schema: TRACK }),
  () => agent(EVALS, { label: 'build:evals', phase: 'Build', schema: TRACK }),
])
const [calibR, appR, evalsR] = build
for (const [k, r] of [['calib', calibR], ['app', appR], ['evals', evalsR]]) {
  log(r ? `${k}: ${r.status}, ${r.open_issues.length} open issues` : `${k}: agent returned nothing`)
}

// ---------------------------------------------------------------------------------------------------------------
phase('Integrate')

const brief = (k, r) => r
  ? `${k} (${r.status}): ${r.summary}\n  open issues: ${r.open_issues.join(' | ') || 'none'}`
  : `${k}: the agent returned nothing; inspect its paths yourself`

const integrate = await agent(`${RULES}

You are the INTEGRATION agent (base port 8820). You own everything now; no other agent is writing. Read PLAN.md fully,
contract/CONTRACT.md and every docs/notes/*.md. The three build tracks reported:
${brief('calib', calibR)}
${brief('app', appR)}
${brief('evals', evalsR)}

1. Run \`npm run eval:all\` and \`eval:calib\` (real MoGe). For every failure decide whether the code or the eval is
   wrong, against PLAN.md, and fix the right one. An eval may only be loosened if PLAN.md is on its side; say so.
2. Make the real path work end to end on this Mac with no mocks for calibration: start serve.py with the default
   --calib (real MoGe), upload a real photo (fixtures/photos/ or fixtures/photos-public/) through POST /api/scenes,
   wait for calibration, open it in the planner, add fixtures/models/SheenChair.glb through the library API (GLB add,
   $0), place it, drag it, save a layout, render in fal mock mode (once with keep-room on: align must apply), and
   compare two renders. Use fixtures/photos/upper-lounge-camera.jpeg (and check upper-lounge.jpg, the same shot
   without EXIF, lands on a similar camera): say in the notes whether the floor fit picked the real floor despite
   the ultrawide lens, the reflective marble and the void behind the glass balustrade. Screenshot each step into
   evals/out/integrate/ and look at the screenshots.
3. Resolve every open issue above or move it to docs/notes/integrate.md with the reason. Update the notes files that
   went stale. If the golden scenes need to change for MoGe's sake, change fixtures/make_scene.mjs, regenerate, and
   rerun everything that depends on them.
4. Commit on v1 when eval:all passes (or, if something cannot pass, commit with the failure named in the message).
${COMMIT}`, { label: 'integrate', phase: 'Integrate', schema: TRACK })

// ---------------------------------------------------------------------------------------------------------------
// Verify (read-only verifiers, then one fixer per round) runs alongside Package (nix/, flake.nix, docs/HANDOFF.md).

const LENSES = [
  {
    key: 'ux',
    port: 8830,
    prompt: `You are a first-time user of midstudy with a phone photo of your living room. Using PLAN.md §1 only as the
story (not the implementation), drive the real app in headless Helium at 390 × 844 with touch emulation and at
1440 × 900: create a scene from a real photo (fixtures/photos/ or fixtures/photos-public/), check and adjust the floor,
add a GLB piece (fixtures/models/SheenChair.glb via the Library panel), place it deep in the room and near the camera,
turn it, raise it, save two layouts, render each (fal mock), compare them, delete and restore. Take a screenshot at
every step and look at it. Report what is broken, unreachable, confusing, misaligned, ugly, slow or inconsistent
between phone and desktop, with the screenshot path as evidence.`,
  },
  {
    key: 'calib-visual',
    port: 8840,
    prompt: `Judge whether the 3D really sits in the photos. For each golden scene (fixtures/scenes/, with truth.json)
and each real photo, open it in the app with real calibration, show the floor grid, place a 76 × 89 × 94 cm chair at
2 m and at 4 m, and screenshot. Check: does the grid lie flat on the floor and run parallel to floorboards or walls
where you'd expect; is the chair's size plausible against things of known size (doors about 2 m tall, seats about
45 cm, tables about 75 cm); does occlusion hide the chair behind real furniture without large halos, and never hide it
behind the floor; does zoom keep it registered; do renders capture the full photo at its resolution. Use the golden
scenes' truth to quantify where you can (eval numbers are not enough: look at the images).`,
  },
  {
    key: 'contract-security',
    port: 8850,
    prompt: `Check the server and calib CLI against PLAN.md §4.3-§4.4, §4.7 and contract/CONTRACT.md's carried §2.8-§2.9
rules, adversarially. Every mutating route without X-Midstudy or with a foreign Origin; a foreign Host; path tricks
(%2e%2e, /./, encoded slashes) toward scenes/*/source.*, calib.json, .trash, library raw/, costs.csv; uploads that
are oversize, missing Content-Length, a non-image, a decompression bomb, a polyglot, filenames with shell
metacharacters, quotes, newlines or ../ (confirm --calib runs without a shell and the filename never reaches a
command line); scene names that aren't the server's own; concurrent uploads; the spend cap across renders and library
adds with MIDSTUDY_FAL_MOCK_COST=1; render requests with a foreign scene or a huge image. Privacy: a scene made from
fixtures/photos/upper-lounge-camera.jpeg must serve a photo.jpg with no EXIF/XMP at all, and nothing the server serves
or sends to fal may carry camera metadata. Report each hole with a curl repro.`,
  },
]

const FIX = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    not_fixed: { type: 'array', items: { type: 'string' }, description: 'finding title — reason' },
    evals: TRACK.properties.evals,
    commit: { type: 'string' },
  },
  required: ['fixed', 'not_fixed', 'evals'],
}

async function verifyAndFix() {
  const rounds = []
  let lenses = LENSES
  let previous = []
  for (let round = 1; round <= 2 && lenses.length; round++) {
    const perLens = await parallel(lenses.map(l => () => {
      const recheck = previous.filter(f => f.lens === l.key)
      return agent(`${RULES}

You are a READ-ONLY VERIFIER (lens: ${l.key}, round ${round}, base port ${l.port}). Do not edit any tracked file; write
only under evals/out/verify-${l.key}/. Read PLAN.md and docs/notes/*.md for how to run things, but form your own view:
the builders' notes are claims, not evidence.

${l.prompt}
${recheck.length ? `\nThe previous round reported these; confirm each is fixed or report it again:\n${recheck.map(f => `- [${f.severity}] ${f.title}: ${f.actual}`).join('\n')}` : ''}

Severity: high = a story step fails, data is lost, money or security rule broken; medium = works but wrong or clearly
poor; low = polish. Only report what you reproduced.`, { label: `verify:${l.key}:r${round}`, phase: 'Verify', schema: FINDINGS })
        .then(r => r ? { lens: l.key, checked: r.checked, findings: r.findings.map(f => ({ ...f, lens: l.key })) } : null)
    }))
    const results = perLens.filter(Boolean)
    const findings = results.flatMap(r => r.findings)
    const serious = findings.filter(f => f.severity !== 'low')
    log(`Verify round ${round}: ${serious.length} high/medium, ${findings.length - serious.length} low`)
    if (!findings.length) { rounds.push({ round, results, fix: null }); break }

    const fix = await agent(`${RULES}

You are the FIXER for verify round ${round} (base port 8860). The packaging agent is writing nix/, flake.nix and
docs/HANDOFF.md right now: do not touch those. Everything else is yours. Fix every high and medium finding below, and
low ones that are cheap. For each fix, add or extend an eval in evals/ that would have caught it. Then run
\`npm run eval:all\` (and eval:calib if you touched calib/). Update docs/notes/*.md where they went stale.

Findings (JSON):
${JSON.stringify(findings, null, 1)}

${COMMIT}`, { label: `fix:r${round}`, phase: 'Verify', schema: FIX })

    rounds.push({ round, results, fix })
    const flagged = new Set(serious.map(f => f.lens))
    lenses = LENSES.filter(l => flagged.has(l.key))
    previous = serious
  }
  return rounds
}

const PACKAGE = `${RULES}

You are the PACKAGING agent. You own nix/, the packages and nixosModules outputs of flake.nix (keep the dev shells as
they are) and docs/HANDOFF.md. Do not edit planner/, calib/, pipeline/ or evals/: if the packaging needs a change
there (a flag, a path), write it into docs/HANDOFF.md as a request instead. Do not commit; the Finish agent does.
Read PLAN.md §5, §8 and §9, docs/notes/*.md, and nook's nix/ (in ${NOOK}/nix and the copy in nix/) as the model.

Draft, for x86_64-linux: midstudy-add (from nook-add.nix and fal-client.nix), midstudy-calib (torch with CUDA via
torch-bin in its own nixpkgs instance with unfree allowed, as nook-gsplat.nix does; MoGe and its Python deps
packaged; the weights either a fixed-output derivation or pre-seeded into a cache dir the service sets), midstudy (the
web app wrapper running serve.py with --calib pointing at midstudy-calib and --nook-add's successor pointing at
midstudy-add), and nixosModules.default = services.midstudy (webPort, dataDir, falKeyFile, dailySpendUsd,
allowedHosts, calibDevice; systemd hardening as nook's module has).

You cannot build Linux derivations on this Mac. Evaluate what you can (\`nix eval\`, \`nix flake check --no-build\`,
evaluating a minimal nixosSystem that imports the module) and say exactly what was only evaluated and what was never
built. Never ssh to homeserver.

docs/HANDOFF.md is for a Claude agent running on homeserver that will take over hosting. It knows nothing about this
session. Give it: what midstudy is (two lines), the repo layout, what to build and how, what is unverified and the order
to verify it in, the service options and suggested values beside nook (nook uses webPort 8765-range and apiPort 8095:
pick non-clashing ones and say so; it serves https://nook.salehtl.com/planner/), where the FAL key file and data dir go,
how to seed MoGe weights, how to run the evals on homeserver, the live checks in PLAN.md §8, and any requests for code
changes you collected.`

const [verifyRounds, packaging] = await parallel([
  () => verifyAndFix(),
  () => agent(PACKAGE, { label: 'package', phase: 'Package', schema: TRACK }),
])

// ---------------------------------------------------------------------------------------------------------------
phase('Finish')

const lastRound = (verifyRounds || [])[(verifyRounds || []).length - 1]
const leftover = lastRound && lastRound.fix ? lastRound.fix.not_fixed : []

const finish = await agent(`${RULES}

You are the FINISH agent (base port 8870). No other agent is running. Read PLAN.md, docs/notes/*.md and
docs/HANDOFF.md.
Packaging reported: ${packaging ? `${packaging.status}: ${packaging.summary}` : 'nothing (agent failed)'}
Findings the last fixer could not fix: ${leftover.length ? leftover.join(' | ') : 'none'}

1. Run \`npm run eval:all\` and \`eval:calib\`. Fix only small, clear breakage; anything larger goes into STATUS.
2. Write docs/STATUS.md for the user, who has been away: what works now (with the eval table: name, pass/fail,
   measured values), what was verified by looking at screenshots, what is not verified (live fal calls, the Linux
   packaging), known gaps and the open findings, and the exact next steps (PLAN.md §8). Plain and short.
3. Rewrite README.md for midstudy: what it is, how to run it locally (\`nix develop -c npm run serve\`), how to add
   furniture, how calibration works and its first-run model download, evals, and a pointer to docs/HANDOFF.md.
4. Commit everything still uncommitted that belongs in the repo (packaging's nix/, flake.nix and docs/HANDOFF.md
   included; never scenes/, renders/, layouts/, evals/out/, fixtures/photos/, .upstream/ or anything secret). Check
   \`git status\` is clean apart from ignored files.
${COMMIT}`, { label: 'finish', phase: 'Finish', schema: TRACK })

return {
  foundation,
  build: { calib: calibR, app: appR, evals: evalsR },
  integrate,
  verify: (verifyRounds || []).map(r => ({
    round: r.round,
    findings: r.results.flatMap(x => x.findings).map(f => `[${f.severity}] ${f.lens}: ${f.title}`),
    fixed: r.fix ? r.fix.fixed : [],
    not_fixed: r.fix ? r.fix.not_fixed : [],
  })),
  packaging,
  finish,
}
