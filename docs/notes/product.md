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

- `eval:product` (E13): synthetic pages in `fixtures/product-pages/` served by `evals/lib/pages_server.mjs`, model mocked; in `eval:all`.
- `eval:product-ui` (E14): the form on desktop and phone; in `eval:all`.
- `eval:product-live`: the golden set, live (`--live`) or from the snapshots (default), model off unless `--llm` (which needs the main session and the user's OK); not in `eval:all`.
