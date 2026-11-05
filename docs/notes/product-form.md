# Product page: the form, the client call, the hook and E15 (builder B)

Contract §2.11 (Planner, hook) and §2.4. Built in parallel with the server route (`planner/serve.py`,
`planner/product_page.py`, builder A), so the form was checked first against in-browser stub answers (`--stub`), then
against the real route once it landed.

## What's here

| File | What |
|---|---|
| `planner/ui/panels/productsrc.js` (new) | The Product page source: link field, Read, status, error with Use Image link instead, picture strip, size picker, notes, and the prefill rules. `productSource({ lib, form, onChange, onUseLink })`. |
| `planner/ui/panels/libsheets.js` | Small, local edits only: the import, `source: 'product'` as the default, a fourth segment first in "Add from" (handles `lib-src-product`, `-photo`, `-link`, `-model`), `setSource()`, the product box in the body, the size picker and notes in the size row, one line each in `showSource`, `problem` and `submit`, and the sheet's subtitle. |
| `planner/data.js` | `lib.readProduct(url, { llm })`: `POST /api/library/product` through the existing `fetchJson` (so it carries `X-Midstudy: 1`). |
| `planner/main.js` | The hook `readProductPage(url, opts)`, next to `addItemFromUrl`. |
| `planner/styles/manage.css` | An appended, marked section "Add furniture › Product page". |
| `evals/product_ui.mjs` (new) | E15, `npm run eval:product-ui` (already in `package.json` and `evals/all.mjs`). |

## Decisions

- **Prefill rule:** each field remembers what the last prefill put in it. A field that is empty, or still holds that
  value, is replaced by the next read; anything else is the user's and is kept (per field, so a typed name survives a
  re-read while the size and category follow the new page). Picking a size is an explicit choice: it always fills all
  three and becomes the new "prefilled" value.
- **Engine:** a rug page sets Flat rug and remembers the engine before it; a later non-rug read puts that engine back,
  unless the user changed the engine in between (then it's theirs). A non-rug page never touches the engine. Nothing
  assumes `sam3d` is the default (main is making Idol the default).
- **Category for a rug** with no category on the page is prefilled as `rug` by the form itself (not by the sheet's
  `rugDefaults`), so a later read can replace it.
- **Errors:** a `4xx` from the route (blocked shop, not a page, no product) is the page's answer: it shows in
  `product-error` and is **not** pushed to `window.midstudy.errors` (the eval asserts that list stays empty). Only a
  server that doesn't answer or fails with `5xx` is reported as an app error (toast + `errors`). The hook rejects with
  the server's sentence either way. Use Image link instead shows on every server error; when the pasted link is itself
  a picture (`.jpg` …), it is carried into the Image link field.
- **Make** is blocked with a plain reason on the button: "Paste a product page link", "Read the page first", "Read this
  link first" (the field was edited after the read), "No picture on the page", "Choose a picture" (every picture failed
  to load), then the sheet's own "Give it a name" / "Enter its size in cm". It calls `lib.addFromUrl(chosenPicture.url,
  meta)` exactly as Image link does; price box and budget follow the engine.
- **Pictures:** `<img>` gets `referrerpolicy="no-referrer"` **before** `src` (set as a property, then `src` last),
  `loading="lazy"`, `decoding="async"`, alt text. A picture that fails is hidden; if it was chosen, the next loadable one
  is chosen; the notes say how many were left out. The strip scrolls sideways inside itself.
- **Status** says what was found and where, e.g. "Found the name, 3 sizes and 3 pictures (from the page’s structured
  data and the page text)." Where = `source_layers_used` plus each candidate's `source`, in plain words. No size or no
  picture adds a short instruction.
- **Notes** (in the size row, under W × D × H): for the chosen size, "A language model found this size … check it." when
  `source` is `llm`, its `unit_note` and `notes`, and the page's own words (`quote`) for `text`/`llm` readings; shop
  sizes whose `dims_index` is null; the warnings; "Read from …"; "The language model cost $0.0009." when `cost_usd > 0`
  (or "a test stand-in: no charge" when mocked).
- **Phone:** "Product page" shows as "Product" (the rest of the label is `display: none` on a phone, the button's
  `aria-label` stays "Product page"), so four segments fit one row at 390 px. The Add sheet's segments are 44 px tall
  on a phone (they were 40 px, which the 44 px audit flags). Read is wide enough for "Reading…" so the field doesn't jump.
- No `role="status"` on `product-status`: `aria-live="polite"` is enough, and the harness's 44 px audit counts any
  `[data-midstudy]` element with a `role` as a target.

## E15 (`evals/product_ui.mjs`)

Pages server (`syntheticPages()`) + `startServer(env MIDSTUDY_FETCH_ALLOW=127.0.0.1:<pages port>)`, a seeded golden
scene, then the same flow on desktop (1280 × 800, clicks, Enter to read) and phone (390 × 844, taps), screenshots in
`evals/out/product-ui/<device>-<n>-<stage>.png`, phone 44 px audit and the no-horizontal-scroll check at each stage:

1. Product page is the default, the four segments fit (labels whole, 44 px on the phone), field type/inputmode url.
2. Rug page: the loading state (the answer is held 1.5 s in the browser), then 3 sizes, Flat rug, 160 × 230 × 0.8, 3
   pictures from `/media/` (no-referrer, lazy, alt), the strip inside the sheet, the notes say where it came from.
3. Size 2 → 200 × 300; picture 2 marked. No library job and no server fetch of a picture before Make (pages server hits
   with a `midstudy` User-Agent); the browser's picture requests carry no Referer.
4. Make: the from-url request body (chosen picture, 200 × 300 × 0.8, engine rug, name, slug), one job, done, the item's
   `dims_cm` and `source.input`, exactly one server fetch of the chosen picture.
5. Chair page: 76 × 84 × 98, armchair, no picker, engine unchanged; a typed name survives a rug read and a chair read;
   the engine goes rug and back.
6. Hook: `readProductPage(chair)` = the 200 body (all §2.11 keys), nothing added; `readProductPage(blocked)` rejects
   with the sentence.
7. Blocked: the contract's sentence in `product-error`, `product-use-link` switches to Image link (name kept).
8. Prose page: "a language model" in status and notes, 90 × 40 × 120, no charge (mock). The model's cost note with the
   answer patched to `cost_usd: 0.0009` in the browser (the real mock costs $0).
9. A picture that fails to load (answer patched to a `/media/missing-picture.jpg` that the browser gets as 404) is hidden
   and the next is chosen.
10. No console errors (the browser's own "Failed to load resource" lines for the blocked page's 422 and the deliberate
    404 picture are expected and counted separately), no page errors, `window.midstudy.errors` empty.

Picture links to made-up `*.example` hosts (the prose page's og:image) are answered in the browser with the fixture
picture, so the eval never leaves the machine.

`--stub` answers `POST /api/library/product` inside the browser with contract-shaped bodies built from the manifest's
expectations (`ui-rug`, `ui-chair`, `prose-llm`, `blocked`); Make still goes to the real from-url add. The default mode
uses the real route.

## Results (2026-11-05)

- `--stub` first, while the route was being written: 114/114 (`E15: 114/114 checks passed in 36.5 s`).
- Real route (builder A's `serve.py` + `product_page.py`, uncommitted in the worktree) once it landed: passed on the
  first run with no form changes; final runs `E15: 115/115 checks passed in 37.4 s` and `… 36.8 s`, and once more for
  the screenshots now in `evals/out/product-ui/` (real mode).
- Screenshots looked at, desktop and phone: no overflow, the four segments fit at 390 px, the strip and sizes stay inside
  the sheet. Fixed from them: Read was narrower than "Reading…" (the field jumped while reading), and the server's notes
  had no full stop, unlike the form's own.

## Left / ideas

- Phone, three sizes: the 2-column grid leaves the third one alone on its row (fine, but a one-column list is an option).
- The size label repeats the size when the shop's label is already W × D ("160 x 230 cm" over "160 × 230 × 0.8 cm"):
  kept, as the second line adds the thickness and the conversion.
- No `llm: false` switch in the form (the hook takes it); the hint says when the model runs and what it costs.
- Not checked here: a live shop page in the form (that's `eval:product-live` for the reader; the form only needs the 200 body).
