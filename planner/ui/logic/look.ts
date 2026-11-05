// The Scene panel's words and rules (ui/panels/scene.ts, contract §4.5, §4.8): where the camera came from, where the
// light comes from, the Look sliders' readouts, when Reset has nothing to do, a touch slide's value, and the photo's
// facts line. Pure, TScert-checked.

import { dots } from './text.js'

/** The Warmth readout: "Neutral", "Warm 0.25", "Cool 0.50". */
export function warmthWord(w: number): string {
  return Math.abs(w) < 0.005 ? 'Neutral' : `${w > 0 ? 'Warm' : 'Cool'} ${Math.abs(w).toFixed(2)}`
}

/** Softness in a word. */
function softWord(v: number): string {
  return v < 0.25 ? 'Crisp' : v < 0.6 ? 'Soft' : 'Diffuse'
}

/** The light's softness as the source line says it. */
function softDetail(v: number): string {
  const w = softWord(v)
  return w === 'Crisp' ? 'Crisp shadows' : w === 'Soft' ? 'Soft shadows' : 'Diffuse light, faint shadows'
}

/** The Softness slider's readout: "Soft · 0.35". */
export function softnessText(v: number): string {
  return `${softWord(v)} · ${v.toFixed(2)}`
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-3
}

/** The key light's linear colour (largest component 1) as a CSS colour, for the source line's sun; null without one. */
export function cssColor(rgb: readonly number[] | null | undefined): string | null {
  if (rgb?.length !== 3) return null
  return `rgb(${rgb.map((c) => String(Math.round(255 * Math.min(1, Math.max(0, c)) ** (1 / 2.2)))).join(' ')})`
}

/** Where the camera came from, in a sentence. */
export function cameraFrom(source: string, calibSource: string | null, device: string | null): string {
  if (source === 'manual') return 'Set by hand in Adjust floor'
  if (source === 'auto' && calibSource === 'moge-2') return `Found in the photo by MoGe-2${device ? ` (${device})` : ''}`
  if (source === 'auto' && calibSource === 'truth') return 'Exact (a test scene)'
  if (source === 'auto' && calibSource === 'exif') return "From the lens's focal length (EXIF); height and tilt are guesses"
  return 'A default guess: set the floor by hand'
}

/** The camera card's badge. */
export function cameraBadge(source: string): string {
  return source === 'manual' ? 'Manual' : source === 'auto' ? 'Automatic' : 'Default'
}

/** The lighting as the source line reads it (engine.getLighting()). */
export interface LightFacts {
  readonly source: string
  readonly status?: string | null
  readonly error?: string | null
  readonly cctK?: number | null
  readonly softness?: number | null
}
/** The source line: its glyph (the photo's sun, a spinner, the default sun or a warning), words, detail, and whether
 *  inferring failed (true) or found no light ('none'), which offers to infer it again. */
export interface LightSource {
  readonly glyph: 'photo' | 'busy' | 'default' | 'warning'
  readonly text: string
  readonly detail: string
  readonly failed: boolean | 'none'
}
export function lightSource(l: LightFacts): LightSource {
  if (l.source === 'photo') {
    const cct = l.cctK
    const soft = l.softness
    return {
      glyph: 'photo',
      text: `From the photo${typeof cct === 'number' && Number.isFinite(cct) ? ` · ${String(Math.round(cct / 100) * 100)} K` : ''}`,
      detail: typeof soft === 'number' && Number.isFinite(soft) ? softDetail(soft) : '',
      failed: false,
    }
  }
  if (l.source === 'truth') return { glyph: 'photo', text: 'Exact light (a test scene)', detail: '', failed: false }
  if (l.status === 'missing' || l.status === 'pending' || l.status === 'running') return { glyph: 'busy', text: 'Inferring the light from the photo…', detail: '', failed: false }
  if (l.status === 'none') return { glyph: 'default', text: 'No clear light in this photo · default lights', detail: '', failed: 'none' }
  if (l.status === 'failed') return { glyph: 'warning', text: "Couldn't infer the light", detail: (l.error ?? '') || '', failed: true }
  return { glyph: 'default', text: 'Default lights', detail: '', failed: false }
}

/** Auto lighting's hint. */
export function autoHint(auto: boolean, source: string): string {
  return !auto ? 'Off: your own direction' : source === 'default' ? 'The default light direction' : 'Follows the light in the photo'
}

/** The Look as Reset compares it. */
export interface LookFacts {
  readonly auto_light: boolean
  readonly light_strength: number
  readonly ambient: number
  readonly exposure: number
  readonly warmth: number
  readonly contact_shadows: boolean
  readonly cast_shadows: boolean
  readonly source: string
}
/** Reset has nothing to do: Auto lighting on, strength, ambient and exposure 1, warmth 0, contact shadows on, and the
 *  floor shadow as the scene's default (on with the photo's light). */
export function lookIsDefault(l: LookFacts): boolean {
  return l.auto_light && near(l.light_strength, 1) && near(l.ambient, 1) && near(l.exposure, 1) && near(l.warmth, 0)
    && l.contact_shadows && l.cast_shadows === (l.source !== 'default')
}

/** A slider's value snapped to its step, within its range. */
function snapToStep(v: number, min: number, max: number, step: number): number {
  return Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min))
}

/** A sideways touch slide: the value at the start moved by how far the finger went (no jump to where it landed), on
 *  the slider's steps, to four decimals. */
export function slideValue(v0: number, dx: number, width: number, min: number, max: number, step: number): number {
  return parseFloat(snapToStep(v0 + (dx / width) * (max - min), min, max, step).toFixed(4))
}

/** The photo's facts under the panel. */
export interface PhotoFacts {
  readonly title: string
  readonly w: number | null | undefined
  readonly h: number | null | undefined
  readonly depth: string | null
  readonly calib: string | null
  readonly made: string | null
}
export function photoFacts(p: PhotoFacts): string {
  return dots([p.title, `${String(p.w)} × ${String(p.h)} photo`, p.depth ?? 'no depth', p.calib, p.made])
}

/** "moge-2 on mps, 9 s" (the calibration's source, device and time). */
export function calibFacts(source: string | null | undefined, device: string, elapsedS: number | null | undefined): string {
  return `${String(source)} on ${device}${elapsedS ? `, ${String(Math.round(elapsedS))} s` : ''}`
}

/** After Calibrate again. */
export function recalibratedText(manual: boolean): string {
  return manual ? 'Calibrated again. Your own camera stays: Reset in Adjust floor uses the new one.' : 'Calibrated again.'
}
