// The Look (contract §4.8): exposure and warmth for the furniture, and the lighting controls. Defaults, v1's lookFrom,
// setLighting's merge (with "Auto lighting" going off and freezing what was in use), Reset, what is saved, the values in
// use, the hook's getLighting() report, and the floor shadow catcher's numbers. Pure, for TScert (tscert/README.md):
// the Look's clamps, v1's round and the wraps are the kernels' and come in as parameters (Kernels), as does
// trigonometry (the shell passes the kernels' dirOf). The warmth tint is the kernels' too (splatMultiplier).
import { isNum, roundAll } from './num.js'
import type { JsonObject, Kernels, LookKey } from './num.js'

export type Vec3 = readonly [number, number, number]

/** The Look as the engine keeps it: every key, null where it means "the scene's default" (v1's lookFrom output). */
export interface LookState {
  readonly exposure: number
  readonly warmth: number
  readonly light_azimuth_deg: number | null
  readonly light_elevation_deg: number | null
  readonly light_softness: number | null
  readonly light_strength: number
  readonly ambient: number
  readonly contact_shadows: boolean
  readonly auto_light: boolean
  readonly cast_shadows: boolean | null
}

/** A Look number as it may come in, clamped by the kernels; null when it isn't a finite number. */
function lookNum(k: Kernels, key: LookKey, v: unknown): number | null {
  return isNum(v) ? k.clampLook(key, v) : null
}

function boolOr(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/** v1's lookFrom: a scene's `look` (or anything) to the full Look, each key clamped or defaulted. */
export function lookFrom(src: JsonObject | null, k: Kernels): LookState {
  if (src === null) return defaultLook()
  return {
    exposure: lookNum(k, 'exposure', src['exposure']) ?? 1,
    warmth: lookNum(k, 'warmth', src['warmth']) ?? 0,
    light_azimuth_deg: lookNum(k, 'light_azimuth_deg', src['light_azimuth_deg']),
    light_elevation_deg: lookNum(k, 'light_elevation_deg', src['light_elevation_deg']),
    light_softness: lookNum(k, 'light_softness', src['light_softness']),
    light_strength: lookNum(k, 'light_strength', src['light_strength']) ?? 1,
    ambient: lookNum(k, 'ambient', src['ambient']) ?? 1,
    contact_shadows: boolOr(src['contact_shadows'], true),
    auto_light: boolOr(src['auto_light'], true),
    cast_shadows: boolOrNull(src['cast_shadows']),
  }
}

/** Every default (v1's lookFrom({}), and what resetLighting() sets). */
export function defaultLook(): LookState {
  return {
    exposure: 1, warmth: 0, light_azimuth_deg: null, light_elevation_deg: null, light_softness: null, light_strength: 1,
    ambient: 1, contact_shadows: true, auto_light: true, cast_shadows: null,
  }
}

/** v1's setLighting: a direction or softness given without auto_light turns Auto lighting off (as does auto_light false). */
function goesManual(p: JsonObject): boolean {
  const some = isNum(p['light_azimuth_deg']) || isNum(p['light_elevation_deg']) || isNum(p['light_softness'])
  return (some && typeof p['auto_light'] !== 'boolean') || p['auto_light'] === false
}

/** setLighting needs the values in use first when it is about to freeze them (Auto lighting going off). */
export function needsFreeze(look: LookState, p: JsonObject): boolean {
  return goesManual(p) && look.auto_light
}

/** The direction and softness in use, as freezeAuto keeps them. */
export interface InUse {
  readonly light_azimuth_deg: number
  readonly light_elevation_deg: number
  readonly light_softness: number
}

/** v1's setLighting(p) on `look`: freeze what was in use when Auto lighting goes off (inUse, given exactly when
 * needsFreeze), then the clamped numbers of p, then its booleans (auto_light only ever turned on here). */
export function patchLook(look: LookState, p: JsonObject, inUse: InUse | null, k: Kernels): LookState {
  const manual = goesManual(p)
  let az = look.light_azimuth_deg
  let el = look.light_elevation_deg
  let soft = look.light_softness
  if (manual && look.auto_light && inUse !== null) {
    const elIn = inUse.light_elevation_deg
    az = k.roundTo(k.wrapAz(inUse.light_azimuth_deg), 3)
    el = k.roundTo(k.clampLook('light_elevation_deg', elIn) ?? elIn, 3)
    soft = k.roundTo(inUse.light_softness, 4)
  }
  const pAz = lookNum(k, 'light_azimuth_deg', p['light_azimuth_deg'])
  const pEl = lookNum(k, 'light_elevation_deg', p['light_elevation_deg'])
  const pSoft = lookNum(k, 'light_softness', p['light_softness'])
  const pAuto = p['auto_light']
  const pContact = p['contact_shadows']
  const pCast = p['cast_shadows']
  return {
    exposure: lookNum(k, 'exposure', p['exposure']) ?? look.exposure,
    warmth: lookNum(k, 'warmth', p['warmth']) ?? look.warmth,
    light_azimuth_deg: pAz ?? az,
    light_elevation_deg: pEl ?? el,
    light_softness: pSoft ?? soft,
    light_strength: lookNum(k, 'light_strength', p['light_strength']) ?? look.light_strength,
    ambient: lookNum(k, 'ambient', p['ambient']) ?? look.ambient,
    contact_shadows: typeof pContact === 'boolean' ? pContact : look.contact_shadows,
    auto_light: pAuto === true ? true : manual ? false : look.auto_light,
    cast_shadows: typeof pCast === 'boolean' ? pCast : look.cast_shadows,
  }
}

/** Whether two Looks differ (v1 compared JSON.stringify(look) before and after a change). */
export function lookChanged(a: LookState, b: LookState): boolean {
  return (
    a.exposure !== b.exposure || a.warmth !== b.warmth || a.light_azimuth_deg !== b.light_azimuth_deg ||
    a.light_elevation_deg !== b.light_elevation_deg || a.light_softness !== b.light_softness ||
    a.light_strength !== b.light_strength || a.ambient !== b.ambient || a.contact_shadows !== b.contact_shadows ||
    a.auto_light !== b.auto_light || a.cast_shadows !== b.cast_shadows
  )
}

/** A copy in LOOK_KEYS order. */
export function lookCopy(l: LookState): LookState {
  return {
    exposure: l.exposure, warmth: l.warmth, light_azimuth_deg: l.light_azimuth_deg, light_elevation_deg: l.light_elevation_deg,
    light_softness: l.light_softness, light_strength: l.light_strength, ambient: l.ambient, contact_shadows: l.contact_shadows,
    auto_light: l.auto_light, cast_shadows: l.cast_shadows,
  }
}

/** v1's lookToSave: every key (null removes it on the server): no direction or softness while Auto lighting is on. */
export function lookToSave(l: LookState): LookState {
  if (!l.auto_light) return lookCopy(l)
  return {
    exposure: l.exposure, warmth: l.warmth, light_azimuth_deg: null, light_elevation_deg: null, light_softness: null,
    light_strength: l.light_strength, ambient: l.ambient, contact_shadows: l.contact_shadows, auto_light: l.auto_light,
    cast_shadows: l.cast_shadows,
  }
}

/** The key the scene would use by itself: lighting.json's (in the world frame) or v1's key light, with its angles. */
export interface AutoLight {
  readonly dir: Vec3
  readonly softness: number
  readonly azimuth_deg: number
  readonly elevation_deg: number
}

/** The Look as the lights take it (v1's resolvedLook). */
export interface ResolvedLook {
  readonly light_azimuth_deg: number
  readonly light_elevation_deg: number
  readonly dir: Vec3
  readonly light_softness: number
  readonly light_strength: number
  readonly ambient: number
  readonly cast_shadows: boolean
}

/** v1's resolvedLook: with Auto lighting on, the scene's own direction and softness; off, the stored ones, each
 * falling back to the scene's. `dirOf(azimuth, elevation)` is the kernels' (contract §4.8 angles). */
export function resolveLook(l: LookState, auto: AutoLight, hasLighting: boolean, dirOf: (az: number, el: number) => Vec3): ResolvedLook {
  const manual = !l.auto_light
  const az = manual && l.light_azimuth_deg !== null ? l.light_azimuth_deg : auto.azimuth_deg
  const el = manual && l.light_elevation_deg !== null ? l.light_elevation_deg : auto.elevation_deg
  const turned = manual && (l.light_azimuth_deg !== null || l.light_elevation_deg !== null)
  return {
    light_azimuth_deg: az,
    light_elevation_deg: el,
    dir: turned ? dirOf(az, el) : auto.dir,
    light_softness: manual && l.light_softness !== null ? l.light_softness : auto.softness,
    light_strength: l.light_strength,
    ambient: l.ambient,
    cast_shadows: l.cast_shadows ?? hasLighting,
  }
}

/** v1's getLook(): what the Look panel and the 'look' event show. */
export interface LookView {
  readonly exposure: number
  readonly warmth: number
  readonly contactShadows: boolean
}

export function lookView(l: LookState): LookView {
  return { exposure: l.exposure, warmth: l.warmth, contactShadows: l.contact_shadows }
}

/** lighting.json's key in the world frame (v1's lights.inferred()). */
export interface InferredKey {
  readonly azimuth_deg: number
  readonly elevation_deg: number
  readonly softness: number
  readonly direction: Vec3
  readonly color: Vec3
  readonly intensity: number
  readonly cct_k: number | null
}

/** The key light in use (v1's lights.inUse()). */
export interface KeyInUse {
  readonly azimuth_deg: number
  readonly elevation_deg: number
  readonly direction: Vec3
  readonly color: Vec3
  readonly intensity: number
  readonly softness: number
}

export type LightingSource = 'photo' | 'truth' | 'default'

/** The light's backfill status (contract §4.8): done | missing | pending | running | none | failed. */
export interface LightingStatus {
  readonly status: string
  readonly error: string | null
}

/** The hook's getLighting() (contract §4.8), v1's rounding. */
export interface LightingReport {
  readonly exposure: number
  readonly warmth: number
  readonly contact_shadows: boolean
  readonly auto_light: boolean
  readonly light_azimuth_deg: number
  readonly light_elevation_deg: number
  readonly light_softness: number
  readonly light_strength: number
  readonly ambient: number
  readonly cast_shadows: boolean
  readonly source: LightingSource
  readonly inferred: {
    readonly azimuth_deg: number
    readonly elevation_deg: number
    readonly softness: number
    readonly direction: number[]
    readonly color: Vec3
    readonly intensity: number
    readonly cct_k: number | null
  } | null
  readonly key: {
    readonly azimuth_deg: number
    readonly elevation_deg: number
    readonly direction: number[]
    readonly color: Vec3
    readonly intensity: number
    readonly softness: number
  }
  readonly status: string
  readonly error: string | null
}

export function lightingReport(l: LookState, r: ResolvedLook, inf: InferredKey | null, k: KeyInUse, source: LightingSource, st: LightingStatus, km: Kernels): LightingReport {
  return {
    exposure: l.exposure,
    warmth: l.warmth,
    contact_shadows: l.contact_shadows,
    auto_light: l.auto_light,
    light_azimuth_deg: km.roundTo(r.light_azimuth_deg, 3),
    light_elevation_deg: km.roundTo(r.light_elevation_deg, 3),
    light_softness: km.roundTo(r.light_softness, 4),
    light_strength: l.light_strength,
    ambient: l.ambient,
    cast_shadows: r.cast_shadows,
    source,
    inferred: inf === null ? null : {
      azimuth_deg: km.roundTo(inf.azimuth_deg, 3),
      elevation_deg: km.roundTo(inf.elevation_deg, 3),
      softness: inf.softness,
      direction: roundAll(inf.direction, 6, km),
      color: inf.color,
      intensity: inf.intensity,
      cct_k: inf.cct_k,
    },
    key: {
      azimuth_deg: km.roundTo(k.azimuth_deg, 3),
      elevation_deg: km.roundTo(k.elevation_deg, 3),
      direction: roundAll(k.direction, 6, km),
      color: k.color,
      intensity: km.roundTo(k.intensity, 6),
      softness: km.roundTo(k.softness, 4),
    },
    status: st.status,
    error: st.error,
  }
}

/** lighting.json's source as getLighting() names it: 'default' without one. */
export function lightingSourceOf(has: boolean, source: unknown): LightingSource {
  if (!has) return 'default'
  return source === 'truth' ? 'truth' : 'photo'
}

/** v1's setLightingData status: the scene's lighting_status when it names one, else done with lighting.json, else
 * missing; its error when it has one. */
export function lightingStatusOf(status: unknown, has: boolean, error: unknown): LightingStatus {
  return {
    status: typeof status === 'string' && status !== '' ? status : has ? 'done' : 'missing',
    error: typeof error === 'string' && error !== '' ? error : null,
  }
}

/** One poll of the lighting backfill (contract §4.8): what the status becomes and whether the poll loop ends. A 'missing'
 * after a pending or running one means the job is gone (a server restart forgets it), and the polls have a limit. */
export function lightingStep(prev: string, polled: string, polls: number, maxPolls: number): { status: string; terminal: boolean; error: string | null } {
  if (polled === 'pending' || polled === 'running') {
    return polls >= maxPolls ? { status: 'failed', terminal: true, error: 'gave up waiting' } : { status: polled, terminal: false, error: null }
  }
  if (polled === 'missing' && (prev === 'pending' || prev === 'running')) {
    return { status: 'failed', terminal: true, error: 'the lighting job was lost (the server restarted?)' }
  }
  return { status: polled, terminal: true, error: null }
}

/** The floor catcher's tan of the light's angular radius (contract §4.8: 0.006 + 0.6 · softness²). */
export function penumbraTan(softness: number): number {
  return 0.006 + 0.6 * softness * softness
}

/** What a full shadow keeps of the floor's light under the v1 lights: about half, by ambient and key. */
export function keepV1(ambient: number, strength: number, upY: number): number {
  return Math.min(1, Math.max(0.08, (0.45 * ambient) / (0.45 * ambient + 0.55 * strength * upY + 1e-6)))
}

/** With lighting.json, per channel: what remains of an up-facing floor's light under a piece (band 0 of the
 * ambient, never more than the whole ambient) over its whole light (ambient and key), clamped to [0.08, 1]. */
export function keepPhoto(amb: Vec3, even: Vec3, keyColor: Vec3, keyIntensity: number, ambient: number, strength: number, upY: number): Vec3 {
  return [
    keepChannel(amb[0], even[0], keyColor[0], keyIntensity, ambient, strength, upY),
    keepChannel(amb[1], even[1], keyColor[1], keyIntensity, ambient, strength, upY),
    keepChannel(amb[2], even[2], keyColor[2], keyIntensity, ambient, strength, upY),
  ]
}

/** One channel of keepPhoto. */
function keepChannel(amb: number, even: number, keyColor: number, keyIntensity: number, ambient: number, strength: number, upY: number): number {
  const t = Math.max(1e-4, amb * ambient + keyColor * keyIntensity * strength * upY)
  return Math.min(1, Math.max(0.08, Math.min(even * ambient, amb * ambient) / t))
}

/** The key's shadow camera around the pieces (v1's fitShadow): radius r of their bounding sphere (≥ 0.2), the top of
 * their box, the light's unit direction's y, and the catcher's penumbra tan. */
export interface ShadowFit {
  readonly reach: number
  readonly back: number
  readonly half: number
  readonly near: number
  readonly far: number
  readonly range: number
  readonly width: number
  readonly search: number
  readonly bias: number
}

export function shadowFit(radius: number, maxY: number, dirY: number, tan: number): ShadowFit {
  const r = Math.max(0.2, radius)
  const reach = (maxY + 0.05) / Math.max(0.08, dirY)
  const back = r + 1
  const half = r + 0.15 + tan * Math.min(reach, 8)
  const near = 0.01
  const far = back + r + reach + 0.5
  const range = far - near
  return {
    reach, back, half, near, far, range, width: 2 * half,
    search: Math.min(0.25, (tan * (reach + 0.2)) / (2 * half) + 1.5 / 2048),
    bias: 0.004 / range,
  }
}

/** The room light as the lights read it from lighting.json (planner/lighting.ts LightData's colour part). */
export interface RoomLight {
  readonly sh: readonly Vec3[]
  readonly color: Vec3
  readonly intensity: number
  readonly whiteBalance: Vec3 | null
}

// A phone photo is already white-balanced by the camera, so the room's light is (nearly) neutral in it. The fit's
// colour comes from grey-world over the room's materials, which in a beige/wood room is mostly their colour, not the
// light's: lighting the furniture with it counts the warmth twice (a yellow cast Warmth can't undo). So for any source
// but "truth" the light is divided by white_balance.rgb (luminance 1, so the level stays): the room's light becomes
// neutral, the key keeps its colour relative to the ambient (renormalized to max 1, the factor into its intensity), and
// the shadow catcher's per-channel ratios are unchanged. Splats then get white balance [1, 1, 1]. Golden scenes
// (source "truth": real light colours, no camera white balance) stay as given. (main ae46665)
export function neutralized<L extends RoomLight>(l: L, source: unknown): L {
  const wb = l.whiteBalance
  if (source === 'truth' || !wb?.every((v) => v > 1e-4)) return l
  const div = (c: Vec3): Vec3 => [c[0] / wb[0], c[1] / wb[1], c[2] / wb[2]]
  const kc = div(l.color)
  const m = Math.max(kc[0], kc[1], kc[2], 1e-9)
  return { ...l, sh: l.sh.map(div), color: [kc[0] / m, kc[1] / m, kc[2] / m], intensity: l.intensity * m, whiteBalance: [1, 1, 1] }
}
