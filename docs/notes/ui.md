# ui (v2 Phase 2): planner/ui in strict TypeScript, its logic certified by TScert

Branch `v2-ui` (from `v2` at 979677c), worktree `.claude/worktrees/rf-ui`. Plan: docs/REFACTOR.md §1–§8; the TScert
guide is `tscert/README.md` (there is no `docs/notes/tscert.md`, gate-1 says so). Owned: `planner/ui/**`,
`planner/styles/**`, `planner/index.html`, plus `tscert/baseline.json` (shared-append) and this note. The engine track
ports `planner/{main,engine,lighting,input,data}.js` at the same time; here they stay legacy JavaScript (allowJs) and the
UI calls them exactly as v1 did.

## What exists

Every v1 file of `planner/ui/` is now a `.ts` file of the same name (`git mv`-style: the `.js` is gone, main.js's
`./ui/*.js` specifiers resolve to the `.ts` through esbuild and tsc). Styles and `index.html` are unchanged.

| File | What |
|---|---|
| `ui/seam.ts` (new) | The one place the UI meets the legacy JS. Types of everything the UI uses from `engine.js`, `data.js` and `input.js` (`Engine`, `ScenesStore`, `LibraryStore`, their events and data shapes, loose on purpose: what v1 tolerates, `?.`/`\|\|`, not what contract/gen promises), `UiContext` (the ctx main.js passes to every `mount`, plus what the areas add: `workspace`, `scenesPage`, `library`, `renders`), and the helpers the UI imports from engine.js/data.js (`dimsText`, `quiet`, `MAX_ELEVATION`, `CAMERA_RANGE`, `SLUG`, `RENDER_MODELS`, `renderPrice`, `fmtUsd`, `sceneTitle`, `relDate`, `friendlyDate`, `fmtBytes`, `estimateCost`, `LIB_PRICE`, `DEFAULT_IMAGE_ENGINE`) re-exported with declared types. tsc checks every use against these; when engine.ts/data.ts land, tsc checks the declarations against the real modules. |
| `ui/bus.ts` (new) | `Events<M>` (typed `addEventListener`/`removeEventListener` over a map of event → detail) and `Bus<M>`, the shell's typed emitter: listeners per type in registration order, a listener added twice called once, one removed during a dispatch not called, a throwing listener reported through `window.reportError` (what an EventTarget does) while the others run, `emit()` → false when a cancelable event was cancelled. No cast anywhere: the registry is a mapped type keyed by the event name. |
| `ui/kit.ts` | `h()` typed by its selector (`h('input.x')` is an `HTMLInputElement`, a union of selectors a union of elements) through one overload; attributes typed (`Attrs`: known props, `aria-*`, and every `on<event>` handler with its event type, so `onpointerdown: (e) => e.pointerId` is typed); v1's attribute rules kept exactly (null/undefined/false left out, a non-string value set as the property when the element has one, else an attribute, `dataset`/`style` through `Object.assign`). `button`, `iconButton`, `pill`, `kbd`, `toggle`, `segmented` (generic in its value), `slider`, `chip`, `field`, with their extra members (`row.input`, `seg.set`, …) typed via `Object.assign`. |
| `ui/icons.ts`, `ui/sheet.ts`, `ui/shell.ts`, `ui/sun-dial.ts`, `ui/workspace.ts`, `ui/scenes.ts`, `ui/panels/{common,inroom,layouts,library,libsheets,productsrc,renders,scene}.ts` | The DOM shells, ported line for line: typed event handlers, narrowing with `instanceof` and type guards, no `any`, no `!`, no casts but `as const`, no ts-ignore. `shell.Shell` is an explicit interface (overloaded `confirm`: `Promise<boolean>` for OK/Cancel, `Promise<V \| null>` for custom actions). |
| `ui/logic/*.ts` (new, 14 modules) | The pure UI logic, TScert-certified: `text` (minus signs, plurals, money, monogram, clipping, sentences, sizes, the forms' number parsing), `dates` (from a Date's parts), `lists` (`uniqueBy`, `countBy`), `chrome` (mode, sheet detents, where a drag or fling settles, chrome metrics, dock split, toast life, menu and tooltip placement, keyboard inset), `workspace` (render chip, switcher state, height field, horizon drag, grip / label / horizon-handle placement, clip, stage insets, the workspace's keys and sentences), `sundial` (the dial's maths and keys), `scenes`, `layouts` (slug, name check, card, sort), `library` (search, filter, counts, jobs), `look` (the Scene panel's words, Reset, touch-slide value), `libforms` (Add/Edit: size fields, meta, problems, Flat rug prefill, budget, patch), `product` (the product-page reading's words, notes, size picker, picture fallback, Make's needs), `renders`, `glyphs` (stroke width, ring arc). Trigonometry (`Math.tan`, `Math.sin/cos/atan2`, `Math.hypot`) comes in as parameters so results stay bit-identical to v1. |
| `ui/test/logic-vs-v1.mjs` (new) | Differential test: each logic function against the v1 expression it replaced (copied verbatim from 979677c), on seeded random inputs plus edge cases (±0, NaN, ±Infinity, 1e21, empty strings, accents, emoji, decimal commas, U+2212…). Outputs compared with `Object.is`/JSON (`addMeta` and `editPatch` by their JSON: the bytes the server gets). |

## Commands (worktree root)

```sh
nix develop -c npm run build                                   # bundle (esbuild resolves ./ui/*.js to .ts)
MIDSTUDY_TRACK=ui nix develop -c npm run check -- ownership types lint dead tscert
nix develop -c node scripts/check-ownership.mjs ui --base 979677c
nix develop -c node scripts/tscert-ratchet.mjs --files $(ls planner/ui/logic/*.ts | tr '\n' ',')   # one line per unit
nix develop -c node planner/ui/test/logic-vs-v1.mjs [--seed N] [--n ROUNDS]                       # differential vs v1
nix develop -c node scripts/eval-lock.mjs -- npm run eval:{phone,ux,ux2,product-ui,lighting,floor,planner,render,splat}
```

## Measurements (rabbit, 2026-11-06, legacy server, fal mocked, headless Chrome from `$PUPPETEER_EXECUTABLE_PATH`)

| What | Before (v1 UI at 979677c, this worktree) | After (TS UI) |
|---|---|---|
| eval:phone (E9) | 49/49 | 49/49, 49/49 |
| eval:ux (E11) | 29/29 | 29/29, 29/29 |
| eval:ux2 (E12) | 27/27 | 27/27, 27/27 |
| eval:product-ui (E15) | 135/135 | 135/135, 135/135 |
| eval:lighting (E16) | 57/57 | 57/57, 57/57 |
| eval:floor (E5) | 35/35 | 35/35, 35/35 |
| eval:planner (E3) | 56/56 | 56/56, 56/56 |
| eval:render (E6) | 37/37 | 37/37, 37/37 |
| eval:splat (E13) | 51/51 | 51/51, 51/51 |
| check:types / lint (planner area) | — (no .ts) | ok / ok, 33 .ts files |
| check:dead (knip) | ok | ok |
| check:tscert | nothing to check | 195/195 units certified (14 files), all baselined |
| logic-vs-v1 | — | 208,019 checks (seed 7, 4,000 rounds) and 1,040,019 checks (seed 12345, 20,000 rounds): no difference; a mutated copy fails (negative control) |
| `planner/dist/app.js` (minified) | 349 kB (357,004 B; UI 136,960 B) | 362 kB (369,935 B; UI 149,914 B: +12,954 B, +9.5 % of the UI, +3.6 % of app.js) |

Where the bytes went: the logic modules (≈25 kB) less the shells (−12 kB); the rest is `String(n)` in templates (the
lint's `restrict-template-expressions` refuses numbers), braced arrow bodies (`no-confusing-void-expression`) and the
property names of the facts objects passed to logic (not minified). Parse cost of 13 kB is well under a millisecond;
eval:perf (E17) was not run here (a gate/A-B measurement).

## Decisions

- **The seam instead of `.d.ts` files.** `planner/engine.d.ts` would be the engine track's path, and inferred types
  from the JS are mostly `any` (`let sceneData = null`), which the lint refuses. So the UI declares what it uses
  (`ui/seam.ts`), and the free helpers are re-exported through it with declared types (assigning a JS function whose
  inferred type is `(s: any) => any` to a declared function type is a declaration, not a cast, and the lint accepts it).
  The data types are what v1 tolerates, not contract/gen's: the probe library in the evals, for one, has no `notes` or
  `mount`, and v1 reads `item.assets?.glb`.
- **`h()`'s one overload** (`h<S>(sel: S, …): ElementOf<S>` over an implementation returning `HTMLElement`) is the
  only place a type is narrowed by declaration; it is what `document.createElement`'s own overloads do, and it holds
  for every tag in `HTMLElementTagNameMap`.
- **Engine events are declared, shell events are owned.** `engine.events`, `scenes.events`, `lib.events` are the
  engine's EventTargets; the seam declares their events and details (`EngineEvents`, …). `shell.events` is a `Bus`.
  `ctx.renders.events` stays a plain EventTarget (nobody listens; kept as v1's API).
- **captureComposite is awaited** (renders.ts, the only UI caller; the UI never calls captureMask). The seam types it
  `Shot | Promise<Shot>`, so today's value and the engine track's Promise both work.
- **v1's quirks kept** (behaviour first; for a fixer to decide): the desktop Drop to floor button gets `data-kbd="null"`
  (v1 assigned `kbd: null` into the dataset), so its tooltip shows a "null" keycap; the Scenes page's `--page-w`
  (940 px) is set through `Object.assign` on the style, which sets no custom property, so the page is the CSS default
  880 px wide; `toast.close(true)` in Library's "Placing…" toast was always the animated close (the handle ignores the
  argument). No style changed.
- **What changed, only for inputs that cannot happen** (each noted where it is): lookups that were object literals
  indexed by run-time strings are Maps or switches (`modelShort`, the product page's "where read from", `pill`, the icon
  paths), so a key like `constructor` no longer reads `Object.prototype`; the product page's answer is parsed by type
  (`parseProduct`: a field of the wrong type is left out, a null variant no longer throws); an attribute value that is
  an object (Attrs does not allow one) is written as "" instead of "[object Object]"; `fill()`'s nested lists flatten
  fully (v1 one level; no caller nests).
- **Dead code removed**: v1's `numberControl` and `VIEW_WORD` (panels/common.js), `isSheetOpen`/`closeSheet`
  (sheet.js), `paths`/`names` (icons.js) and the `slugify`/`pretty`/`lightWords`/`BOOKMARKLET`/`whereText`/`dimsLabel`
  exports were used by nothing; their logic lives on in `ui/logic` where something uses it.
- **TScert shapes**: `addMeta` and `editPatch` return every key, `undefined` when it does not apply (TScert refuses a
  key-adding write after a nested branch); `JSON.stringify` leaves `undefined` out, so the body sent is v1's byte for
  byte (the differential test compares the JSON), and `changes(p)` replaces v1's `Object.keys(p).length`.
- **knip**: module-local names are not exported; the areas' `mount` (called by main.js through
  `Object.entries({ workspace, library, … })`, which knip does not follow) carries `/** @public */`.
- `navigator.platform` (deprecated in lib.dom) is still read first, as v1 did, to tell a Mac; the one eslint-disable
  in the UI says so.

## Requests

- **engine** (and integration, Phase 3): type `engine.events`, `scenes.events` and `lib.events` so that
  `addEventListener<K>(type: K, fn: (e: CustomEvent<Detail[K]>) => void)` works, e.g. with `ui/bus.ts`'s `Events<M>`
  and the maps in `ui/seam.ts` (`EngineEvents`, `ScenesEvents`, `LibEvents`); a plain `EventTarget` is not assignable
  to it. main.ts should type `ctx` as `UiContext` (`ui/seam.ts`) and pass the engine typed, so tsc checks the seam's
  `Engine`, `ScenesStore` and `LibraryStore` against the real objects; then `ui/seam.ts`'s re-exports can become plain
  `export { … } from '../engine.js'`. Signatures the UI relies on are listed there (e.g. `getItem(uid: string | null)`,
  `layoutDisplayName(name): string`, `captureComposite(opts): Shot | Promise<Shot>`, `saveLayoutInternal(name, { title })`).
- **engine**: `prettyLayout` (engine.js) and the UI's `pretty` (logic/layouts.ts) are the same function; one can go
  when the seam is reconciled.
- **integration**: `planner/ui/test/logic-vs-v1.mjs` is not run by any gate (no planner test runner yet); consider
  adding it to `npm run check` or a `test:ui` script (package.json is shared-append; not added here).

## Not done

- eval:perf (E17) not run (performance gate, A/B at Phase 4); the bundle size change is above.
- No browser-level differential (DOM snapshot v1 vs v2); the nine evals and the logic differential are the check.
