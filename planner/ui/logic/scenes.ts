// The Scenes page's words and choices (ui/scenes.ts, contract §4.5): a card's flags and meta line, the upload's
// progress, the delete question, and which dropped files are photos. Pure, TScert-checked.

import { dots, plural } from './text.js'

/** What a scene card shows from the §4.4 scene object (only the fields read here). */
export interface SceneFacts {
  readonly title?: string | null
  readonly w?: number | null
  readonly h?: number | null
  readonly layouts?: number | null
  readonly photo_url?: string | null
  readonly calib_status?: string | null
  readonly calib_error?: string | null
  readonly floor_found?: boolean | null
  readonly camera_source?: string | null
}

/** A calibration that is queued or running. */
export function isCalibrating(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running'
}

/** One flag on a card: its class after sc-flag, its words, and its tooltip. */
export interface SceneFlag {
  readonly cls: string
  readonly text: string
  readonly title: string | null
}
export function sceneFlags(s: SceneFacts, isOpen: boolean): SceneFlag[] {
  const flags: SceneFlag[] = []
  if (isOpen) flags.push({ cls: 'is-open', text: 'Open now', title: null })
  if (s.calib_status === 'failed') flags.push({ cls: 'is-failed', text: 'Calibration failed', title: s.calib_error ?? '' })
  else if (!isCalibrating(s.calib_status) && s.floor_found === false && s.camera_source !== 'manual') flags.push({ cls: 'is-check', text: 'Check the floor', title: null })
  else if (s.camera_source === 'manual') flags.push({ cls: '', text: 'Floor set by hand', title: null })
  return flags
}

/** "Today, 09:36 · 1600 × 1200 · 2 layouts": the date only when the scene has its own title (else it is the title). */
export function sceneMeta(s: SceneFacts, date: string): string {
  return dots([
    s.title ? date : null,
    s.w ? `${String(s.w)} × ${String(s.h)}` : null,
    s.layouts ? plural(s.layouts, 'layout') : 'no layouts',
  ])
}

/** The words over a calibrating scene's photo. */
export function busyText(hasPhoto: boolean): string {
  return hasPhoto ? 'Finding the floor…' : 'Reading the photo…'
}

/** Delete's question: the photo and its layouts go to Recently deleted. */
export function deleteBody(layouts: number): string {
  return `The photo${layouts ? ` and its ${plural(layouts, 'layout')}` : ''} move to Recently deleted, where you can restore ${layouts ? 'them' : 'it'}. Its renders come back with it.`
}

/** An upload's progress (0–1, or null before the first report or when complete) and its words. */
export interface UploadProgress {
  readonly progress: number | null
  readonly text: string
}
export function uploadProgress(loaded: number, total: number): UploadProgress {
  const p = total ? loaded / total : null
  const going = p !== null && p < 1
  return { progress: going ? p : null, text: going ? `Uploading ${String(Math.round(p * 100))} %` : 'Starting…' }
}

/** A dropped file the page takes as a photo: an image type, or a .heic / .heif name. */
export function isPhotoFile(type: string, name: string): boolean {
  return type.startsWith('image/') || /\.(heic|heif)$/i.test(name)
}

/** The page's hint over the grid. */
export function scenesHint(phone: boolean): string {
  return phone ? 'Tap a scene to open it.' : 'Click a scene to open it. Each scene keeps its own layouts and renders.'
}
