// The room view's and the room cards' words and small choices (ui/room.ts, ui/scenes.ts; contract §4.9 Planner): a
// room's title, its card's meta line and status, the one-line note over a photo, Align photos' hint, New room's help
// text (docs/ROOMS.md §7 in a few lines), and the plan's colours for a photo. Pure, TScert-checked.
import { dots, plural } from './text.js'

/** A room's title as typed, else the date it was made, else its name. */
export function roomTitleText(title: string | null | undefined, friendlyCreated: string, name: string): string {
  const t = (title ?? '').trim()
  return t || (friendlyCreated ? `Room, ${friendlyCreated}` : '') || name
}

/** What a room card's status line reads from the room object (§4.9): the members still calibrating, the alignment. */
export interface RoomFacts {
  readonly photos: number
  readonly calibrating: number
  readonly placed: number
  readonly layouts: number
  readonly alignStatus: string
  readonly alignError: string | null
}

/** The card's status: what the room is doing now ("Calibrating 3 photos…", "Aligning…"), else null. */
export function roomBusyText(f: RoomFacts): string | null {
  if (f.calibrating > 0) return `Calibrating ${plural(f.calibrating, 'photo')}…`
  if (f.alignStatus === 'pending' || f.alignStatus === 'running') return 'Aligning…'
  return null
}

/** "7 photos · 5 placed · 2 layouts" (placed only when some aren't). */
export function roomMeta(f: RoomFacts, date: string): string {
  return dots([
    date || null,
    plural(f.photos, 'photo'),
    f.placed < f.photos ? `${String(f.placed)} placed` : null,
    f.layouts ? plural(f.layouts, 'layout') : null,
  ])
}

/** The card's flag when the alignment failed, else null. */
export function roomFlag(f: RoomFacts): string | null {
  if (f.alignStatus === 'failed') return 'Alignment failed'
  if (f.photos > 1 && f.placed < 2 && f.calibrating === 0 && f.alignStatus !== 'pending' && f.alignStatus !== 'running') return 'Place the photos'
  return null
}

/** The one line over the current photo (§4.9): unplaced, or placed with low confidence, else null. */
export function photoNote(placed: boolean, poseSource: string, confidence: number | null, solverUnplaced: boolean): string | null {
  if (!placed) return solverUnplaced ? "The alignment couldn't place this photo: place it on the floor plan" : 'Place this photo on the floor plan'
  if (poseSource === 'solver' && confidence !== null && confidence < 0.5) return 'This photo may be misplaced: check it on the floor plan'
  return null
}

/** Align photos' hint for the photo it works on. */
export function alignHint(placed: boolean, phone: boolean): string {
  if (!placed) return phone ? 'Tap the plan where this photo was taken' : 'Click the plan where this photo was taken, then turn it'
  return phone ? 'Drag a photo to move it, its handle to turn it' : 'Drag a photo to move it; drag the handle to turn it. Walls snap together when it is right.'
}

/** The photo strip's label for photo n (1-based) of a room. */
export function photoLabel(n: number, title: string): string {
  return `Photo ${String(n)}: ${title}`
}

/** New room's help text (docs/ROOMS.md §7, in a few lines). */
export function newRoomHelp(): string[] {
  return [
    'Walk the edge of the room and take a photo every metre or so: 8–12 photos, each across the room, neighbours sharing about half their view.',
    'Chest height, level, landscape; the normal 1× lens; same lights; nobody moving between shots.',
    'Measure one long straight line on the floor (a wall, a rug) to set the scale later.',
  ]
}

/** What New room says while it works: uploading photo i of n, making the room, asking for an alignment. */
export function newRoomStep(step: 'upload' | 'room' | 'align', i: number, n: number): string {
  if (step === 'upload') return `Uploading photo ${String(i)} of ${String(n)}…`
  if (step === 'room') return 'Making the room…'
  return 'Aligning the photos…'
}

/** The toast after Set scale for the room: by how much the room grew or shrank. */
export function roomScaleText(k: number): string {
  const pct = Math.round((k - 1) * 1000) / 10
  if (pct === 0) return 'The room already reads that length'
  return `Room scaled ${pct > 0 ? 'up' : 'down'} ${String(Math.abs(pct))} %: every photo now reads it`
}

/** A photo's colour on the plan: the current one in the accent, the others by number (a quiet palette). */
export function photoHue(index: number): number {
  const hues = [205, 150, 280, 20, 330, 95, 250, 175, 50]
  return hues[index % hues.length] ?? 205
}

/** What a pointer going down on the plan starts, counting it: one drags, the second pinches, any more are only recorded. */
export function planDown(pointers: number, pinching: boolean): 'pinch' | 'ignore' | 'start' {
  if (pinching || pointers > 2) return 'ignore'
  return pointers === 2 ? 'pinch' : 'start'
}

/** What the end of a plan gesture does: a moved photo or handle is saved only while Align photos is on, else put back;
 *  a pan that never moved is a tap; pieces were saved as they moved. */
export function planEnd(kind: 'pan' | 'photo' | 'handle' | 'item' | 'turn', moved: boolean, alignOn: boolean): 'commit' | 'revert' | 'tap' | 'none' {
  if (kind === 'pan') return moved ? 'none' : 'tap'
  if (kind === 'item' || kind === 'turn' || !moved) return 'none'
  return alignOn ? 'commit' : 'revert'
}

/** The photo Align photos works on: the one grabbed while it is still in the room, else the current one. */
export function alignTarget(alignSel: string | null, members: readonly string[], photo: string | null): string | null {
  return alignSel !== null && members.includes(alignSel) ? alignSel : photo
}
