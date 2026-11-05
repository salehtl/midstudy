# Product page reader (orchestrator's notes)

Started 2026-11-05 on branch `claude/product-import-6b48ab` (worktree). The spec is contract §2.11 and §2.9 Page fetches.

## Phase 0: what the real pages look like (golden set, `evals/product_golden.json`)

Ten real pages, fetched once on 2026-11-05; their HTML and feeds are saved, git-ignored, in `fixtures/pages/<id>/`.

| Page | Where the size is | Notes |
|---|---|---|
| zennovacarpet.com (WooCommerce, the user's carpet shop) | only as variant terms `3*4 … 4*8`, no unit | Store API has the terms; the custom-size form says `Length (m)`, so metres. JSON-LD Product has no size. Name has a " - Zennova Carpets" suffix in JSON-LD and og:title, not in the Store API. |
| IKEA AE | JSON-LD `width: "80 cm"` etc. | also a `3DModel` JSON-LD block (a GLB: a later idea) |
| IKEA US | JSON-LD `width: "31 1/2 \""` | fractions in inches |
| Albany Park (Shopify) | text: `101" L X 40" D X 30.5" H`; `.json` body: `101"W x 30.5"H x 40"D` | box sizes and seat/arm heights nearby; 8 MB page |
| Annie Selke (Shopify rug) | JSON-LD ProductGroup `hasVariant[].size` `7' 6" x 9' 6"` | `.json` 429, `.js` 200 |
| Boutique Rugs (Shopify rug) | JSON-LD offer names `… - 3'11" x 5'7" Rectangle`; size-guide table with nominal and shipping sizes | Thickness 0.45", Pile Height 0.29" |
| Floyd (Shopify) | none in the served HTML | ProductGroup colour variants |
| Industry West (WooCommerce) | none | Store API `dimensions` all `0` |
| Target | inline script JSON: `Dimensions (Overall): 71.18 Inches (H) x 24.49 Inches (W) x 11.57 Inches (D)` | visible text is ~1 KB; recommended products' sizes follow |
| West Elm | 403 to any non-browser client | the "blocks" case; Wayfair 429, Crate & Barrel 403, Pottery Barn 403 too |

Learned: Shopify rate-limits bursts from one IP (429 on `.json`, then on pages too, after ~10 quick requests across Shopify shops); the `.js` feed answered when `.json` didn't. An honest `User-Agent` (`midstudy/1.0 (product page reader)`) got the same answers as a browser one on every page, so the reader says what it is.

## Decisions

- **Model:** fal `openrouter/router` (the current fal route for language models; `fal-ai/any-llm` is "no longer supported"), `model: "anthropic/claude-haiku-5.5"`, $0.10 / $0.50 per million tokens in / out (OpenRouter's list, 2026-11-05), so about $0.001 for a 20,000-character page. fal's answer carries `usage.cost`, which is what's recorded. Alternative at the same price: `google/gemini-2.5-flash-lite` ($0.10 / $0.40).
- **The model only locates; the server decides.** Its sizes count only when their quote is on the page and holds the numbers; the server converts units and checks 1–2000 cm. So planted instructions can at worst point at text that is really on the page.
- **A deterministic text layer before the model** (labelled triples with units, tables, script JSON): free, exact, and it covers Albany, Target and tables, so the model runs only when nothing was found.
- **Unitless sizes** (Zennova's `3*4`) take the page's own unit hint, with a note, else they're dropped with a warning.
- **The server never downloads pictures**; the chosen one goes through the existing from-URL add and its checks.
- **Files:** the extractor is a new `planner/product_page.py`, loaded by path from `serve.py` (the Nix wrapper runs `python3 -I`, which keeps the script's folder off `sys.path`); the form's new part is `planner/ui/panels/productsrc.js`. Both keep the edits to `serve.py` and `libsheets.js` small, since another session ([Idol on fal](#local_10f7d63d-ca03-49c4-8afc-8793d7aef502)) edits those on `main`.

## Evals

- `eval:product` (E14): synthetic pages in `fixtures/product-pages/` served by `evals/lib/pages_server.mjs`, model mocked; in `eval:all`.
- `eval:product-ui` (E15): the form on desktop and phone; in `eval:all`.
- `eval:product-live`: the golden set, live (`--live`) or from the snapshots (default), model off unless `--llm` (which needs the main session and the user's OK); not in `eval:all`.

## Phase 1: two builders in parallel (workflow, 2 agents)

- **A, extractor:** `planner/product_page.py` (stdlib), the route in `serve.py` (three small hunks), E14, `eval:product-live`. See `docs/notes/product-extractor.md`. E14 273/273; golden snapshots 80/81, the one miss being my golden error (Floyd does give its size, in an accordion: `16” W x 13” L x 7” H`).
- **B, form:** `planner/ui/panels/productsrc.js`, small hooks in `libsheets.js`, `lib.readProduct`, the `readProductPage` hook, CSS, E15. See `docs/notes/product-form.md`. E15 115/115 against A's real route.
- Folded into the contract afterwards: W and L in one reading, unlabelled pairs, unitless numbers in text, which page pictures count, feed descriptions as `text`, `mock`/`llm` only when the model ran, no cost row for a refused call, 400 for a host that doesn't resolve, form errors vs app errors.

## Phase 2: integration

`eval:all` on 2026-11-05 13:30: E1, E6–E9, E12–E15 passed; E3, E4, E5 and E11 failed on 30 s page-load timeouts while the Mac's load average was 185–330 (other sessions' simulators and evals). Rerun after the fixes, at normal load (below).

## Phase 3: black-box verifiers (workflow, 3 agents) and fixes

32 findings: security 6, UX 11, accuracy 15. Fixed here, each with a regression in E14 or E15:

- **High:** a long digit run or an unterminated escaped-quote string froze the whole server for 20+ s (quadratic regexes hold the GIL). Number patterns are bounded, script strings are scanned in one pass, and the work after the download has its own 10 s limit. E14 reads a 12,000-digit, 20,000-escaped-quote page in well under a second while `/api/spend` stays responsive.
- **High:** a second size of the same rug replaced the first (same id). A product with several sizes now gets `<name>-<w>x<d>` ids, and the sheet says when Make would replace a piece already in the library.
- **High:** order keys ("(H x W x D)", "W x D x H:") were ignored or misread. They're now read as keys, never as one number's label.
- **Medium:** a failed read left the last page's size, category and Flat rug in the form; sizes in "related products" blocks could come first; the size picked in the link (`?variant=`) was ignored; "L x W" put a sofa's length in depth (now the longer of L and W is the width, except beds); a rug word as a material ("Kilim Ottoman") made a rug; size chips cut their text; no-picture-loads was a dead end.
- **Low, fixed:** private picture links (the browser would request them), `user:password@` kept in `costs.csv`, deep JSON failing a read, three IPv6 private ranges, Python names in error sentences, labels after numbers, dia, foreign axis words, ranges, structured `Width (cm)` names, unitless sizes that only fit in cm, untrue notes (unit order, rug thickness without a unit), picture copies (largest, https), samples as sizes, dual units, sofa beds, focus after Read, the phone keyboard after Go, the model credited when it found nothing, a missing height.
- **Not fixed (follow-ups):** Tab leaves the Add furniture sheet (a general `ui/sheet.js` issue, every sheet has it); seater-named Shopify options linked to sizes in the description, and filling a missing height from a lone "Height: 75 cm"; the four Shopify golden shops answer 429 from this Mac's IP (Cloudflare `local_rate_limited` after today's probing; untested from another network or later).

After the fixes, at normal load (2026-11-05 14:30): `eval:all` 12/12 (E14 395/395, E15 117/117), golden snapshots 82/82, harness self-test 22/22. Live without the model: 48/48 with 4 WARN (the Shopify shops' 429).
