// The Renders panel's words (ui/panels/renders.ts, contract §4.7): model names, the list's lines, a running or failed
// render's row, why a render failed, the confirm's labels, the viewer's lines and Keep room's result. Pure,
// TScert-checked.

import { dots, money } from './text.js'

export const ABOUT_S = 25 // seconds a render usually takes

/** A render's metadata (GET /api/renders), as far as these lines read it. */
export interface RenderFacts {
  readonly model?: string | null
  readonly cost_usd?: number | null
  readonly mock?: boolean | null
  readonly keep_room?: boolean | null
  readonly aligned?: AlignFacts | null
}
export interface AlignFacts {
  readonly applied?: boolean | null
  readonly inliers?: number | null
  readonly residual_px?: number | null
  readonly reason?: string | null
}

/** A model's short name ("Nano Banana"), else its long label, else its key. */
export function modelShort(model: string | null | undefined, label: string | null | undefined): string {
  const short = model === 'nano-banana' ? 'Nano Banana' : model === 'kontext' ? 'FLUX Kontext' : model === 'qwen' ? 'Qwen' : ''
  return short || (label ?? '') || (model ?? '')
}

/** What each model is like, under its name in the confirm. */
export function modelNote(model: string): string {
  return model === 'nano-banana' ? 'Uses the photo as a reference' : model === 'kontext' ? 'Freer light, may move things' : model === 'qwen' ? 'Restyles more, slower' : ''
}

/** A prompt that is one of the server's defaults reads as no prompt (planner/serve.py's two). */
export function ownPrompt(p: string | null | undefined): string {
  return p && !p.startsWith('Image 1 is a photo of a room with 3D models of furniture') && !p.startsWith('Turn this 3D planning render into a photorealistic') ? p : ''
}

/** A render's price as listed: $0 for the mock. */
export function renderCost(m: RenderFacts): string {
  return m.mock ? '$0' : money(m.cost_usd)
}

/** What all the scene's renders cost (the mock's nothing). */
export function spentOn(renders: readonly RenderFacts[]): number {
  let s = 0
  for (const m of renders) s += m.mock ? 0 : (m.cost_usd ?? 0) || 0
  return s
}

/** A row's meta: the date when the layout is the title, the model, and Keep room's result. */
export function renderMeta(layout: string, date: string, modelName: string, m: RenderFacts): string {
  return dots([layout ? date : null, modelName, m.keep_room ? (m.aligned?.applied ? 'room kept' : 'keep room not applied') : null])
}

/** A running render's row: "Nano Banana · keep room · about 20 s" (or "any moment"). */
export function runningMeta(modelName: string, keepRoom: boolean, elapsedS: number): string {
  const left = Math.max(0, ABOUT_S - elapsedS)
  return `${modelName}${keepRoom ? ' · keep room' : ''} · ${left > 2 ? `about ${String(Math.ceil(left / 5) * 5)} s` : 'any moment'}`
}

/** A failed render's title. */
export function failedTitle(reason: string): string {
  return `Failed${reason ? ` · ${reason}` : ''}`
}

/** Why a render failed, in a few words, from the error's message ("" when it says nothing known). */
export function failureReason(msg: string): string {
  return /timed? ?out/i.test(msg) ? 'timed out'
    : msg.includes('FAL_KEY') ? 'no fal key'
      : /budget/i.test(msg) ? "today's budget is used up"
        : /isn't answering|could not reach/i.test(msg) ? "the server isn't answering" : ''
}

/** Compare's hint while picking. */
export function pickHint(picked: number, phone: boolean): string {
  return picked ? 'Now pick the second render' : `${phone ? 'Tap' : 'Click'} two renders to compare them`
}

/** The confirm's title and subtitle: a new render, Render again (from a past one), or a retry. */
export function confirmTitle(again: boolean, retry: boolean): string {
  return again ? 'Render again' : retry ? 'Try the render again' : 'Render'
}
export function confirmSub(againDate: string | null, retry: boolean): string {
  return againDate !== null ? `From ${againDate} · the same picture, change anything` : retry ? 'Nothing was charged' : 'Photoreal, paid'
}

/** The Render button: "Render · $0.04", or "Render · $0 (mock)". */
export function goText(mock: boolean, price: number): string {
  return mock ? 'Render · $0 (mock)' : `Render · ${money(price)}`
}

/** The picture that gets sent: its size, and what it is. */
export function sentSize(width: number, height: number): string {
  return `${String(width)} × ${String(height)} JPEG`
}
export function sentWhat(again: boolean, pieces: number): string {
  return again ? "That render's picture" : `The photo with ${String(pieces)} ${pieces === 1 ? 'piece' : 'pieces'}`
}
export function sentCaption(what: string, size: string, model: string): string {
  return `${what} · ${size}${model === 'nano-banana' ? ' · plus the photo as a reference' : ''}`
}

/** Keep room's result in the viewer ("" without Keep room). */
export function alignNote(m: RenderFacts): string {
  if (!m.keep_room) return ''
  const a = m.aligned
  if (a?.applied) {
    const residual = a.residual_px
    return `Room kept · ${a.inliers === null || a.inliers === undefined ? '?' : String(a.inliers)} matches, ${residual === null || residual === undefined ? '' : `${residual.toFixed(1)} px`}`
  }
  return `Keep room not applied${a?.reason ? `: ${a.reason}` : ''}`
}

/** The toast when Keep room could not be applied. */
export function notAlignedText(reason: string | null | undefined): string {
  return `Keep room wasn't applied: ${(reason ?? '') || 'the render could not be aligned to the photo'}. The render is shown as it came.`
}

/** "2 of 5" in the viewer (nothing for one). */
export function ofText(i: number, n: number): string {
  return n > 1 ? `${String(i + 1)} of ${String(n)}` : ''
}

/** The next index after a step of k, going round. */
export function stepIndex(i: number, k: number, n: number): number {
  return (i + k + n) % n
}

/** The viewer's line under the render when no prompt was given. */
export function defaultPromptText(reference: boolean): string {
  return reference
    ? 'The default, with the photo as a reference: keep the room, make the furniture look photographed in it.'
    : 'The default: keep everything, make it a photograph.'
}
