// What a key, a wheel step or a pointer gesture means (planner/input.ts applies it). v1's input.js decisions: the
// tap slop per pointer type, the hit pad around the selected piece, when a release is a tap, the wheel's zoom factor
// and the keyboard map (contract §2.3, §4.5). Pure, for TScert: Math.exp comes in as a parameter.

/** How far (CSS px) a pointer may move and still tap: mouse 4, pen 6, touch 10, anything else 6. */
export function tapSlop(pointerType: string): number {
  if (pointerType === 'mouse') return 4
  if (pointerType === 'pen') return 6
  if (pointerType === 'touch') return 10
  return 6
}

/** The pad around the selected piece's box that still grabs it: 6 px with a mouse, 16 with a pen or a finger. */
export function grabPad(pointerType: string): number {
  return pointerType === 'mouse' ? 6 : 16
}

export type GestureKind = 'item' | 'pan' | 'other' | 'pinch'

/** A release taps when it is a pointerup, nothing moved, one finger, quick (a mouse is always quick; else < 700 ms),
 * and the gesture wasn't a pan. */
export function isTap(isUp: boolean, moved: boolean, multi: boolean, pointerType: string, heldMs: number, kind: GestureKind): boolean {
  const quick = pointerType === 'mouse' || heldMs < 700
  return isUp && !moved && !multi && quick && kind !== 'pan'
}

/** A drag pans the photo once it moved, with one pointer, when it is a pan already or the view is zoomed in. */
export function pans(moved: boolean, multi: boolean, kind: GestureKind, zoom: number): boolean {
  return moved && !multi && (kind === 'pan' || (kind === 'other' && zoom > 1.001))
}

/** The wheel's zoom factor (a trackpad pinch is a wheel with ctrlKey): lines are 16 px, pages 400. */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean, exp: (x: number) => number): number {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1
  const dy = deltaY * k
  return exp(-dy * (ctrlKey ? 0.01 : 0.0015))
}

/** The keyboard map (contract §2.3): what a key (lower case) does. */
export type KeyCommand =
  | { readonly kind: 'escape' }
  | { readonly kind: 'remove' }
  | { readonly kind: 'rotate'; readonly deg: number }
  | { readonly kind: 'nudge'; readonly dy: number }
  | { readonly kind: 'fit' }
  | { readonly kind: 'zoom'; readonly factor: number }
  | { readonly kind: 'none' }

export function keyCommand(k: string, shift: boolean): KeyCommand {
  if (k === 'escape') return { kind: 'escape' }
  if (k === 'delete' || k === 'backspace') return { kind: 'remove' }
  if (k === 'r') return { kind: 'rotate', deg: shift ? -15 : 15 }
  if (k === 'pageup' || k === 'pagedown') return { kind: 'nudge', dy: (k === 'pageup' ? 1 : -1) * (shift ? 0.1 : 0.01) }
  if (k === 'f' || k === '0') return { kind: 'fit' }
  if (k === '+' || k === '=') return { kind: 'zoom', factor: 1.25 }
  if (k === '-' || k === '_') return { kind: 'zoom', factor: 0.8 }
  return { kind: 'none' }
}

/** Elements a key goes to rather than the planner (v1's typing()). */
export function isTypingTarget(tagName: string, contentEditable: boolean): boolean {
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || contentEditable
}
