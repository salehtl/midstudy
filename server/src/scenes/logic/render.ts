// Render (contract §2.6, §4.7): v1's models, prompts, prices, the checks of POST /api/render with their sentences, the
// fal arguments and the metadata it stores and answers (planner/serve.py RENDER_MODELS, post_render, render, align).
// Pure (TScert).
import { fmtCost, pyRepr, pyRound, pyStrip } from '../../../../common/logic/pyfmt.ts'
import { isSlug } from '../../../../common/logic/slug.ts'
import { isNum, isRecord, pyStr, pyTruthy } from './values.ts'

/** The render models, in v1's order. */
export type RenderModel = 'kontext' | 'nano-banana' | 'qwen' | 'gpt-image'

/** The models that take the scene photo as image 2 with REFERENCE_RENDER_PROMPT (§4.7): nano-banana only. gpt-image,
 *  given the photo as image 2, redrew the photo and dropped the furniture (seen 2026-11-05 on an empty-room scene,
 *  main fc82c5c): it gets the composite alone, with COMPOSITE_RENDER_PROMPT when there is a scene. */
export function takesReference(model: RenderModel): boolean {
  return model === 'nano-banana'
}

/** One model's fal endpoint and the argument its image goes in. */
export interface ModelSpec {
  readonly endpoint: 'fal-ai/flux-pro/kontext' | 'fal-ai/nano-banana/edit' | 'fal-ai/qwen-image-edit' | 'openai/gpt-image-2/edit'
  readonly imageKey: 'image_url' | 'image_urls'
  /** Arguments of the model's own, sent with the image, prompt and output_format. */
  readonly extra: Readonly<Record<string, string>>
}

/** v1 RENDER_MODELS (contract §2.6's table). */
export function modelSpec(model: RenderModel): ModelSpec {
  switch (model) {
    case 'kontext': return { endpoint: 'fal-ai/flux-pro/kontext', imageKey: 'image_url', extra: {} }
    case 'nano-banana': return { endpoint: 'fal-ai/nano-banana/edit', imageKey: 'image_urls', extra: {} }
    case 'qwen': return { endpoint: 'fal-ai/qwen-image-edit', imageKey: 'image_url', extra: {} }
    // OpenAI's model on fal (added 2026-11-05, main 7a4f425): medium quality, about the input's size.
    case 'gpt-image': return { endpoint: 'openai/gpt-image-2/edit', imageKey: 'image_urls', extra: { quality: 'medium', image_size: 'auto' } }
  }
}

/** The price recorded for a render (§2.6): kontext $0.04, nano-banana $0.0398, qwen $0.03 a megapixel of the input
 *  (rounded to 4 places), gpt-image an estimated $0.07. */
export function renderPrice(model: RenderModel, width: number, height: number): number {
  switch (model) {
    case 'kontext': return 0.04
    case 'nano-banana': return 0.0398
    case 'qwen': return pyRound(0.03 * ((width * height) / 1e6), 4)
    // Billed by tokens on fal, so an estimate: its table gives $0.043–0.068 at medium for 1–3.7 MP with one input image;
    // the scene photo is a second one.
    case 'gpt-image': return 0.07
  }
}

/** v1 DEFAULT_RENDER_PROMPT (nook's, the composite alone). */
export const DEFAULT_RENDER_PROMPT = 'Turn this 3D planning render into a photorealistic interior photograph. Keep the exact camera angle, '
  + 'room geometry, and every piece of furniture with its position, size, shape and color. Realistic materials, '
  + 'soft natural daylight, subtle contact shadows. Do not add, remove or move anything.'

/** v1 REFERENCE_RENDER_PROMPT (§4.7: nano-banana with the scene photo as image 2). */
export const REFERENCE_RENDER_PROMPT = 'Image 1 is a photo of a room with 3D models of furniture placed in it. Image 2 is the same room as photographed. '
  + "Make the furniture in image 1 look like it was photographed in this room: realistic materials, lighting, "
  + "reflections and contact shadows that match the room's light. Keep the camera, the room and everything already in "
  + "it exactly as in image 2. Keep each piece of furniture's position, size, shape and color. Do not add, remove or "
  + 'move anything.'

/** gpt-image with a scene (§4.7): a real photo with 3D furniture drawn into it, sent alone. */
const COMPOSITE_RENDER_PROMPT = 'This is a photo of a room with 3D models of furniture placed in it. Make every piece of furniture look like it '
  + "was really photographed in this room: realistic materials and textures, lighting, reflections and soft contact "
  + "shadows that match the room's light. Keep every piece of furniture: its position, size, shape and color. Keep the "
  + 'camera, the room and everything else in the photo exactly as it is. Do not add, remove or move anything.'

/** v1's 400 for an image that isn't a usable JPEG data URI. */
export const NOT_JPEG_URI = 'image must be a JPEG data URI (data:image/jpeg;base64,...)'
/** v1's 400 for a composite whose size can't be read (qwen is priced by it). */
export const NO_FRAME = "the image's size can't be read from its JPEG frame header: send a plain baseline or progressive JPEG"
/** v1's 409 for a scene without photo.jpg. */
export const NO_PHOTO_YET = 'this scene has no photo yet: wait for it to finish calibrating'
/** v1's 400 for keep_room without a scene. */
export const KEEP_ROOM_NEEDS_SCENE = 'keep_room needs the scene: send scene with it'
/** v1's 400 for keep_room without a usable mask. */
export const KEEP_ROOM_NEEDS_MASK = "keep_room needs a mask: a PNG data URI (data:image/png;base64,...) at the photo's size"

/** What `model` came to: a model, v1's 400 sentence, or the Python exception v1 answered with 500 (a list or a dict
 *  isn't hashable, so `model not in RENDER_MODELS` raised). */
export type ModelChoice =
  | { readonly kind: 'model'; readonly model: RenderModel }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'crash'; readonly error: string }

/** Python's `repr(model)` in v1's 400 (`{model!r}`). */
function modelRepr(v: unknown): string {
  return typeof v === 'string' ? pyRepr(v) : pyStr(v)
}

/** v1: `model = body.get("model") or "nano-banana"`, then it must name one of RENDER_MODELS. */
export function modelChoice(v: unknown): ModelChoice {
  if (!pyTruthy(v)) return { kind: 'model', model: 'nano-banana' }
  if (v === 'kontext' || v === 'nano-banana' || v === 'qwen' || v === 'gpt-image') return { kind: 'model', model: v }
  if (Array.isArray(v)) return { kind: 'crash', error: "TypeError: unhashable type: 'list'" }
  if (isRecord(v)) return { kind: 'crash', error: "TypeError: unhashable type: 'dict'" }
  return { kind: 'refused', error: 'unknown model ' + modelRepr(v) + ' (choose from kontext, nano-banana, qwen, gpt-image)' }
}

/** The layout a render records: the request's `layout` when it is a slug, else null. */
export function renderLayout(v: unknown): string | null {
  return typeof v === 'string' && isSlug(v) ? v : null
}

/** The prompt sent: the request's unless it is missing or blank, else v1's default for the request (the reference
 *  prompt when the scene photo goes along). */
export function renderPrompt(prompt: string | null, reference: boolean, composite = false): string {
  if (prompt === null || pyStrip(prompt) === '') return reference ? REFERENCE_RENDER_PROMPT : composite ? COMPOSITE_RENDER_PROMPT : DEFAULT_RENDER_PROMPT
  return prompt
}

/** v1's 400 for a mask that isn't the photo's size, or null when it is (or the photo's size can't be read). */
export function maskSizeProblem(maskW: number, maskH: number, photoW: number | null, photoH: number | null): string | null {
  if (photoW === null || photoH === null) return null
  if (maskW === photoW && maskH === photoH) return null
  return 'the mask is ' + String(maskW) + ' x ' + String(maskH) + ", but it must be the photo's size (" + String(photoW) + ' x ' + String(photoH) + ')'
}

/** v1's 502 when fal answered without an image URL (the call is billed and recorded). */
export function noImage(endpoint: string, cost: number): string {
  return 'fal ' + endpoint + ' returned no image ($' + fmtCost(cost) + ' recorded)'
}

/** v1's 502 when the result couldn't be downloaded (the call is billed and recorded). */
export function downloadFailed(why: string, cost: number): string {
  return 'could not download the render (' + why + '); $' + fmtCost(cost) + ' recorded'
}

/** The result URL in fal's answer: `images[0].url` when it is there (v1: any truthy value). */
export function resultUrl(answer: unknown): unknown {
  if (!isRecord(answer)) return null
  const images = answer['images']
  if (!Array.isArray(images) || images.length === 0) return null
  const first: unknown = images[0]
  if (!isRecord(first)) return null
  const url = first['url']
  return pyTruthy(url) ? url : null
}

/** Keep-room's align result (render-meta's `aligned`), in v1's key order. */
export type AlignResult =
  | { readonly applied: true; readonly inliers: number | null; readonly residual_px: number | null }
  | { readonly applied: false; readonly inliers: number | null; readonly residual_px: number | null; readonly reason: string }

/** `align` that couldn't run or failed: nothing applied, why. */
export function alignFailed(reason: string): AlignResult {
  return { applied: false, inliers: null, residual_px: null, reason }
}

/** v1 `align`'s result from the tool's `{ok: true, applied, inliers, residual_px, reason?}` line: applied only when it
 *  said so and wrote the image (`wrote`); otherwise its reason, or why there is none. */
export function alignResult(line: Readonly<Record<string, unknown>>, wrote: boolean): AlignResult {
  const inliersValue = line['inliers']
  const residualValue = line['residual_px']
  const inliers = isNum(inliersValue) ? inliersValue : null
  const residual = isNum(residualValue) ? residualValue : null
  const applied = line['applied'] === true
  if (applied && wrote) return { applied: true, inliers, residual_px: residual }
  const reasonValue = line['reason']
  const reason = typeof reasonValue === 'string' ? reasonValue : applied ? 'align said it applied but wrote no image' : 'align did not apply'
  return { applied: false, inliers, residual_px: residual, reason }
}

/** v1's sentence when align ran past its timeout. */
export function alignTimedOut(seconds: number): string {
  return 'align ran for more than ' + String(seconds) + ' s and was stopped'
}

/** A render's metadata (render-meta.schema.json), in v1's key order. */
export interface RenderMeta {
  readonly name: string
  readonly url: string
  readonly input_url: string
  readonly raw_url: string | null
  readonly model: RenderModel
  readonly endpoint: ModelSpec['endpoint']
  readonly cost_usd: number
  readonly mock: boolean
  readonly prompt: string
  readonly created: string
  readonly scene: string | null
  readonly layout: string | null
  readonly reference: boolean
  readonly keep_room: boolean
  readonly aligned: AlignResult | null
  readonly width: number
  readonly height: number
  readonly out_w: number | null
  readonly out_h: number | null
  /** The room it was made in (contract §4.9): present exactly when the request named one (the shell adds it). */
  readonly room?: string
}

/** What a render was, for its metadata. */
export interface RenderFacts {
  readonly name: string
  readonly model: RenderModel
  readonly cost: number
  readonly mock: boolean
  readonly prompt: string
  /** isoUtcMs of the request. */
  readonly created: string
  readonly scene: string | null
  readonly layout: string | null
  readonly reference: boolean
  readonly keepRoom: boolean
  readonly aligned: AlignResult | null
  /** The composite's size. */
  readonly width: number
  readonly height: number
  /** The result's size, null when its frame header can't be read. */
  readonly outW: number | null
  readonly outH: number | null
}

/** v1 `render`'s metadata: what renders/<name>.json holds and POST /api/render answers. */
export function renderMeta(f: RenderFacts): RenderMeta {
  return {
    name: f.name,
    url: '/renders/' + f.name + '.jpg',
    input_url: '/renders/' + f.name + '-input.jpg',
    raw_url: f.keepRoom ? '/renders/' + f.name + '-raw.jpg' : null,
    model: f.model,
    endpoint: modelSpec(f.model).endpoint,
    cost_usd: f.cost,
    mock: f.mock,
    prompt: f.prompt,
    created: f.created,
    scene: f.scene,
    layout: f.layout,
    reference: f.reference,
    keep_room: f.keepRoom,
    aligned: f.aligned,
    width: f.width,
    height: f.height,
    out_w: f.outW,
    out_h: f.outH,
  }
}
