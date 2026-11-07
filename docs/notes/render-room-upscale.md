# Render every photo, and Upscale (2026-11-07)

Two features, contract §4.7 (new bullets *Upscale* and *Render every photo of a room*).

## Upscale

- `POST /api/renders/<name>/upscale` `{scale?: 2 | 4}` → `clarityai/crystal-upscaler` (`image_url` data URI, `scale_factor`,
  `output_format: "jpg"`), writes `<name>-upscaled.jpg` and adds `upscaled {url, scale, cost_usd, mock, created, out_w, out_h}`
  to `<name>.json`. $0.016 per output megapixel (fal's page, 2026-11-07), reserved against the cap first; cost row
  `upscale:crystal`. Mock: a copy of the render, $0. 404 unknown, 400 bad scale or unreadable size, 409 while one is running.
- Schemas: `render-meta` gains optional `upscaled` (`UpscaleInfo`), new `upscale-request`; routes.json and a recorded example
  (`contract/examples/post-api-renders-render-upscale.json`, recorded with `record-examples.mjs --check` and copied alone, so the
  other examples keep their bytes).
- Planner: the render viewer has `Upscale 2× · $x` (`data-midstudy="upscale"`), then `Upscale 4×`; an `Upscaled` tab shows it.
- Not checked live: the price and the answer shape come from fal's model page; no paid call was made.

## Render every photo

- Planner only. In a room view with two or more placed photos, the Render confirm has *This photo / Every photo (N)*
  (`render-room`); the button shows the total. Each placed photo in member order is opened (`setRoomPhoto`) and rendered
  (`renderViewInternal`, same model, prompt and keep-room); rows show "Waiting/Rendering · photo i of N"; a failure is a failed
  row (Retry opens that photo and the confirm) and the run goes on; the view goes back to its start photo. Photo switches
  during the run don't clear the list (the scene listener checks `roomRun`); opening another room or scene stops it.

## Bug fixed on the way

- Keep-room renders after a room photo switch failed after a page reload with "Could not capture the view: Invalid value used
  as weak map key": `drawMask` drew the scene with `scene.environment` set while the photo's environment map was being made
  again (no GPU texture yet). The mask needs no environment, so `drawMask` now draws without it (engine.passes.ts). E6, E13 and
  E19 pass with the change.

## Evals

- E6 (`eval:render`) +4 checks: the upscale API, its 400/404, the viewer button and Upscaled tab, 4× offered after 2×.
- E19 (`eval:room-planner`) +3 checks: Every photo (7) in the dialog, 7 renders (one per photo, room, room layout), back to
  the start photo.
