# Synthetic product pages

Small, made-up shop pages that reproduce the patterns seen on real product pages (the golden set,
`evals/product_golden.json`): JSON-LD with sizes, OpenGraph only, a Shopify `.js` feed with size variants, the
WooCommerce Store API (with `dimensions`, and with unitless size terms), sizes only in a table or in text, inches with
letters and distractor box sizes, sizes inside a script's JSON, microdata, prose that only the language model can read,
a planted prompt injection, picture links to normalize, and the failure cases (blocked, rate limited, robot check, not a
page, private redirect, too many redirects, slow, huge, gzip, a gzip bomb, cookies).

`manifest.json` has the routes (served by `evals/lib/pages_server.mjs` on one local port) and, under `cases`, what
`POST /api/library/product` must answer for each (contract §2.11). The language model is mocked by
`fixtures/fal/openrouter-router/<slug>.json` (contract §2.11 Mock). Nothing here comes from a real shop.
