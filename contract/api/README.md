# The HTTP API's schemas

One JSON Schema (draft 2020-12) per JSON payload of contract/CONTRACT.md's HTTP API, requests and answers, normative
since v2 (CONTRACT.md §0). [routes.json](routes.json) says which schema each route takes and answers with, by status;
an error status without its own entry answers [error.schema.json](error.schema.json). Each schema's `$id` is
`midstudy/api/<file>`, and its `title` is the name of its generated type.

| Route (contract) | Request | Answers |
|---|---|---|
| `GET /api/spend` (§2.9) | | 200 `spend` |
| `GET /api/settings` (§2.9 Settings) | | 200 `settings` |
| `PUT /api/settings` | `settings-put` | 200 `settings` (400 out of range, 409 with `--daily-spend-usd`) |
| `POST /api/render` (§2.6, §4.7) | `render-request` | 200 `render-meta`, 402 `spend-refused` |
| `GET /api/renders[?scene=]` | | 200 `render-list` |
| `POST /api/renders/<name>/upscale` (§4.7 Upscale) | `upscale-request` | 200 `render-meta`, 402 `spend-refused` |
| `GET /api/layouts?scene=` or `?room=` (§2.7, §4.9) | | 200 `layout-list` |
| `GET /api/layouts/<layout>?scene=` | | 200 `../layout.schema.json` |
| `PUT /api/layouts/<layout>?scene=` | `layout-put` | 200 `../layout.schema.json` |
| `DELETE /api/layouts/<layout>?scene=` | | 200 `layout-deleted` |
| `GET /api/library` (§2.8) | | 200 `library-get` |
| `POST /api/library/items` | raw body; `X-Midstudy-Meta`: `library-meta` | 202 `library-add-accepted`, 402 `spend-refused` |
| `POST /api/library/items/from-url` | `library-from-url` | 202 `library-add-accepted`, 402 `spend-refused` |
| `POST /api/library/product` (§2.11) | `product-request` | 200 `product-result`, 4xx `product-error` |
| `GET /api/library/jobs` | | 200 `library-jobs` |
| `GET /api/library/jobs/<id>` | | 200 `library-job` |
| `PATCH /api/library/items/<id>` | `library-patch` | 200 the item (`../library.schema.json#/$defs/item`), 202 `library-rescale-accepted` |
| `DELETE /api/library/items/<id>` | | 200 `library-deleted` |
| `POST /api/library/items/<id>/restore` | | 200 the item |
| `PUT /api/library/items/<id>/thumb` | `thumb-put` | 200 the item |
| `GET /api/scenes` (§4.4) | | 200 `scene-list` |
| `POST /api/scenes` | raw body; `X-Midstudy-Meta`: `scene-meta` | 202 `scene-created` |
| `GET /api/scenes/jobs` | | 200 `scene-jobs` |
| `GET /api/scenes/jobs/<id>` | | 200 `scene-job` (a `CalibrationJob` or a `LightJob`); 404 only for an id this server run never made |
| `GET /api/scenes/<name>` (§4.4, §4.8) | | 200 `scene-detail` |
| `PUT /api/scenes/<name>` | `scene-put` | 200 `scene-detail` |
| `DELETE /api/scenes/<name>` | | 200 `scene-deleted` |
| `PUT /api/scenes/<name>/thumb` | `thumb-put` | 200 `scene-thumb-saved` |
| `POST /api/scenes/<name>/calibrate` | | 202 `calibrate-accepted` |
| `POST /api/scenes/<name>/light` | | 202 `light-accepted`, 200 `light-done` |
| `POST /api/scenes/<name>/restore` | | 200 `scene-object` |
| `GET /api/rooms` (§4.9) | | 200 `room-list` |
| `POST /api/rooms` | `room-create` | 201 `room-detail` |
| `GET /api/rooms/jobs` | | 200 `room-jobs` |
| `GET /api/rooms/jobs/<id>` | | 200 `room-job` (an `AlignJob`); 404 only for an id this server run never made |
| `GET /api/rooms/<room>` | | 200 `room-detail` |
| `PUT /api/rooms/<room>` | `room-put` | 200 `room-detail` |
| `DELETE /api/rooms/<room>` | | 200 `room-deleted` |
| `POST /api/rooms/<room>/align` | no body, or `align-request` | 202 `align-accepted` |
| `POST /api/rooms/<room>/restore` | | 200 `room-object` |

Shared definitions are in [common.schema.json](common.schema.json) (`Slug`, `DateTime`, `Usd`, `JobStatus`, the JPEG and
PNG data URIs, `PublicCalib`: calib.json as the API serves it). The schemas reuse the file schemas by `$ref`: the camera
block (`../calib.schema.json#/$defs/camera`), the look and the upload (`../scene.schema.json#/$defs/…`), the library
item and its dims (`../library.schema.json#/$defs/…`), the layout, calib.json and lighting.json. Outside `api/`:
[../trash.schema.json](../trash.schema.json) (what the server writes beside a deleted scene or item) and
[../add-summary.schema.json](../add-summary.schema.json) (`midstudy-add`'s summary line), which strict mode checks too.

## As strict as the contract

`additionalProperties: false` wherever the contract (or v1, below) lists every key; enums, ranges, patterns and
nullability as the contract states them; dates are RFC 3339 (`format: date-time`). Where CONTRACT.md is silent and v1
sends or takes something, the schema follows v1:

- `GET /api/renders` also answers `mock` (whether the server runs with the fal mock).
- `DELETE /api/layouts/<layout>` answers `{ok, name, scene, trash}` (the contract shows `{ok, trash}`); `trash` is
  `<layouts folder name>/<scene>/.trash/<layout>-<stamp>.json`.
- `DELETE /api/library/items/<id>` answers `{ok, trash}` with `trash` = `.trash/<id>-<stamp>` (the contract shows `{ok}`).
- `DELETE /api/scenes/<name>`'s `trash` names the scenes folder as it is called (`scenes/.trash/…` by default).
- A light job carries `calib: null` as well as `lighting`; a library job's `cost_usd` is null until it is done (and
  stays null when it fails); a rescale job's `engine` is `glb`; job ids are `c-…` and `l-…` (the rest is free).
- `PUT /api/layouts/<layout>`: v1 fills a missing `uid` (`<id>-<n>`), `render` (`glb`) and `rotation_y_deg` (0), so an
  item needs only `id` and `position`; the body's `name`, `scene_name` and `updated` are ignored (the URL and the server
  decide); `title` has its whitespace collapsed, then at most 120 characters.
- `PUT /api/scenes/<name>`: camera values and look numbers may be any number (they are clamped), `title` is trimmed
  (then at most 200 characters), and a look key set to null is removed.
- `X-Midstudy-Meta` of an add: `mount` may also be null; keys the contract doesn't list are refused here (v1 ignores
  them; the planner never sends any).
- `POST /api/library/product`: `url` at most 4096 characters (v1 answers 400 above).
- The product result: `source_layers_used` takes `jsonld`, `microdata`, `opengraph`, `title`, `shopify`,
  `woocommerce`, `text`, `llm` (in that order); a rug's thickness `h` can be 0.1–30 cm (other axes 1–2000 cm);
  `category` is one of the contract's list.
- `GET /api/scenes`: a trashed scene's `created` is null when its scene.json has none.
- `GET /api/scenes/<name>` carries scene.json's `look` and `upload` when scene.json has them.
- The summary line: `engine` is `rescale` after `--rescale`; `paths` are as `--library` was given (relative or not).

No contradiction between v1 and the contract was found: every answer of every route, recorded from v1 (below), matches.

**Rooms (§4.9, 2026-11-06)** have no v1: their schemas follow CONTRACT.md §4.9 alone, and their examples
(`*-api-rooms*.json`) are hand-written from it (their `recorded` says so) until a server implements the routes and
`record-examples.mjs` records them. Additions to existing schemas are optional keys, so the server without rooms still
conforms: the scene object's `room`, the render request's and meta's `room`, the layout's `room_name` (a layout has
exactly one of `scene_name` and `room_name`), the layout delete's `room` (exactly one of `scene` and `room`), the
scene trash's `room`. The settings routes' examples are hand-written too (they had none).

## Generated code

`node scripts/gen-contract.mjs` (`--check` to compare without writing) makes, from every schema here and in
`contract/`:

- `contract/gen/types.ts`: one `export type` per named type (each schema's root, each `$defs` entry, each inline
  subschema whose `title` is an identifier), deeply readonly, `unknown` for free-form objects (`calib.moge`,
  `lighting.fit`) and for the keys open objects may carry.
- `contract/gen/validate.js` + `validate.d.ts`: Ajv standalone validators (ESM, no runtime dependency), one type guard
  per type (`isSceneDetail(x): x is SceneDetail`), `validators` keyed by schema URI (the URIs routes.json uses) and
  `violation(uri, data)` → `{schema, path, message} | null` for strict mode's `contract violation: <schema> <path>`.
- `contract/gen/routes.js` + `routes.d.ts`: routes.json as a typed module, with `matchRoute(method, path)` →
  `{route, params} | null` and `responseSchema(route, status)` → the schema URI an answer must match (or null: a
  status the route doesn't have). Strict mode is `violation(responseSchema(route, status), body)`.
- `core/crates/contract/schema.json`: one draft-07 bundle of every named type, from which the `midstudy-contract`
  crate's build script generates serde types with typify (`cargo test -p midstudy-contract`).

The types are a little looser than the validators: patterns, ranges, keys that must be absent (`PublicCalib` is `Calib`)
and anyOf branches that only say which keys are required are validation only. In Rust, an optional key that may be null
is an `Option<T>`, so null and absent read the same (`LookPatch`'s "null removes the key" can't be told from "leave it":
don't forward patch requests through the Rust types); everything else round-trips exactly, including the unknown keys of
open objects (kept in `extra`).

## Examples and recordings

`contract/examples/<method>-<path>.json` hold real requests and answers of every route (`kind`: `response`, `request`
or `header X-Midstudy-Meta`; `status`; `schema`; `type`; a `note`), recorded from v1 with the eval mocks by
`nix develop -c node contract/tools/record-examples.mjs` (`--check` records into `evals/out/` instead). Only fixtures go
in: golden scenes, `fixtures/models`, `fixtures/fal`, `fixtures/product-pages`.

`node --test contract/test/contract.test.mjs` checks the schemas compile (strict), routes.json, that `contract/gen/` is
fresh, that every example passes its generated validator, and that the validators refuse unknown keys, missing keys and
the contract's other refusals. The Rust test round-trips every example through the generated types.

Any eval run can record its API calls: `MIDSTUDY_RECORD_API=<dir>` (absolute) makes `evals/lib/harness.mjs` and
`evals/library_api.sh` append one JSON line per `/api` call, and `node contract/tools/check-recordings.mjs <dir>`
validates every answer, and every accepted request and meta header, against routes.json.
