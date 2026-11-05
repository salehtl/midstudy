// The hook's argument checks and every sentence the engine and the stores report (contract §2.3 Errors, §2.4, §4.6):
// v1's wording exactly (the evals read it). `status` is the HTTP status of a failed request, null when the server
// didn't answer. Pure, for TScert.
import { isSlug } from './layout.js'

/** §2.9: every POST, PUT, PATCH and DELETE the page makes carries X-Midstudy: 1 (v1's withMidstudy test). */
export function needsMidstudyHeader(method: string): boolean {
  return /^(POST|PUT|PATCH|DELETE)$/i.test(method)
}

/** A request that got no answer (v1's apiJson / fetchJson). */
export function unreachableText(url: string, why: string): string {
  return `could not reach ${url} (${why})`
}

/** A download that got no answer (v1's fetchBytes). */
export function unfetchableText(url: string, why: string): string {
  return `could not fetch ${url} (${why})`
}

/** A non-2xx answer: the server's own sentence when it gave one. */
export function httpErrorText(url: string, status: number, serverError: string | null): string {
  return serverError ?? `${url} returned HTTP ${String(status)}`
}

/** openScene / waitForScene with a name that isn't a slug. */
export function sceneNameText(name: string): string {
  return `Scene names are slugs like "scene-20261104-201500" (got "${name}")`
}

/** deleteScene / restoreScene with a name that isn't a slug. */
export function sceneSlugText(name: string): string {
  return `Scene names are slugs (got "${name}")`
}

export function isSceneName(name: unknown): name is string {
  return typeof name === 'string' && isSlug(name)
}

export function saveLayoutNameText(name: string): string {
  return `Layout name must be a slug like "reading-corner" (got "${name}")`
}

export function loadLayoutNameText(name: string): string {
  return `Layout name must be a slug (got "${name}")`
}

export function createSceneText(status: number | null): string {
  if (status === 413) return 'That photo is too big (25 MB at most)'
  if (status === 400) return 'Not a scene'
  return 'Could not upload the photo'
}

export function openSceneText(name: string, status: number | null): string {
  return status === 404 ? `There's no scene "${name}"` : `Could not open the scene "${name}"`
}

export function restoreSceneText(name: string, status: number | null): string {
  return status === 409 ? `Can't restore "${name}": a scene by that name exists again` : `Could not restore the scene "${name}"`
}

export function saveSceneText(status: number | null): string {
  return status !== null && status !== 0 ? 'Could not save the scene' : "Not saved: the server isn't answering"
}

export function recalibrateText(status: number | null): string {
  return status === 409 ? 'This scene is already calibrating' : 'Could not start the calibration'
}

/** Why the light couldn't be inferred, as the Look panel shows it (lighting_error). */
export function lightWhyText(status: number | null): string {
  if (status === 409) return 'the scene is calibrating; its light comes with it'
  return status !== null && status !== 0 ? "the server couldn't start it" : "the server isn't answering"
}

export function lightStartText(status: number | null): string {
  return status === 409 ? 'This scene is calibrating; its lighting comes with it' : 'Could not start inferring the light'
}

export function lookSaveText(status: number | null): string {
  return status !== null && status !== 0 ? 'Could not save the look' : "The look isn't saved: the server isn't answering"
}

export function saveLayoutText(name: string, status: number | null): string {
  return status !== null && status !== 0 ? `Could not save layout "${name}"` : `Layout "${name}" not saved: the server isn't answering`
}

export function loadLayoutText(name: string, status: number | null): string {
  return status === 404 ? `No layout named "${name}" in this scene` : `Could not load layout "${name}"`
}

export function renderFailText(status: number | null): string {
  return status === 402 ? "Not rendered: today's fal budget is used up" : 'Render failed'
}

/** renderView's model check (contract §4.7): the models, the default first. */
function unknownModelText(model: string, models: readonly string[]): string {
  return `Unknown render model "${model}" (use ${models.join(', ')})`
}

/** The library manager's add (data.ts): why an add was refused. */
export function addErrorText(status: number | null, offline: boolean): string {
  if (status === 402) return "Not added: today's fal budget is used up"
  if (status === 413) return 'Not added: the file is too big'
  if (status === 400) return 'Not added'
  if (offline) return "Not added: the server isn't answering"
  return 'Could not add the piece'
}

export function editErrorText(id: string, offline: boolean): string {
  return offline ? "Not changed: the server isn't answering" : `Could not change "${id}"`
}

export function removeErrorText(id: string, offline: boolean): string {
  return offline ? "Not removed: the server isn't answering" : `Could not remove "${id}" from the library`
}

export function restoreErrorText(id: string, status: number | null): string {
  if (status === 409) return `"${id}" is in the library again: remove that one first`
  if (status === 404) return `"${id}" isn't in the library's trash`
  return `Could not restore "${id}"`
}

/** POST /api/scenes through XHR (data.ts upload): a refusal, with the server's sentence or the status. */
export function uploadErrorText(status: number, why: string): string {
  return status === 413 ? `That photo is too big: ${why}` : `Couldn't make a scene from that photo: ${why}`
}

/** readProduct (§2.11): a server that isn't answering or fails is reported; a shop's refusal is the page's answer. */
export function productReported(offline: boolean, status: number | null): boolean {
  return offline || (status !== null && status >= 500)
}

export function productErrorText(offline: boolean): string {
  return offline ? "Couldn't read the page: the server isn't answering" : "Couldn't read the page"
}

/** The hook's renderView options, checked as v1 does: the model (nano-banana by default) and the prompt. */
export type RenderArgs =
  | { readonly ok: true; readonly model: string; readonly prompt: string | null; readonly keepRoom: boolean }
  | { readonly ok: false; readonly error: string }

/** `modelText` is the model as v1's message prints it (`${model}`, the shell's String()). */
export function renderArgs(model: unknown, modelText: string, prompt: unknown, keepRoom: boolean, models: readonly string[]): RenderArgs {
  const m = model ?? 'nano-banana'
  if (typeof m !== 'string' || !models.includes(m)) return { ok: false, error: unknownModelText(modelText, models) }
  if (prompt !== null && prompt !== undefined && typeof prompt !== 'string') return { ok: false, error: 'Render prompt must be a string' }
  return { ok: true, model: m, prompt: typeof prompt === 'string' ? prompt : null, keepRoom }
}

/** The hook's setRenderSettings(s): the Look part (exposure or warmth given) and contact shadows (a boolean). */
export interface RenderSettingsArgs {
  readonly look: boolean
  readonly contactShadows: boolean | null
}

export function renderSettingsArgs(exposure: unknown, warmth: unknown, contactShadows: unknown): RenderSettingsArgs {
  return { look: exposure !== undefined || warmth !== undefined, contactShadows: typeof contactShadows === 'boolean' ? contactShadows : null }
}

/** compare(a, b): each a render name or a render (its `name`); both must be non-empty. */
export function bothNamed(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && a !== '' && typeof b === 'string' && b !== ''
}
