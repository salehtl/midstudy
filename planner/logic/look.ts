// The Look (contract §4.8): exposure and warmth for the furniture, and the lighting controls. Ranges and defaults,
// v1's lookFrom, setLighting's merge (with "Auto lighting" going off and freezing what was in use), Reset, what is
// saved, the values in use, the hook's getLighting() report, the warmth tint, and the floor shadow catcher's numbers.
// Pure, for TScert (tscert/README.md): trigonometry comes in as parameters (the shell passes the kernels' dirOf).
import { clampNum, isNum, round, roundAll, wrapAz } from './num.js'
import type { JsonObject } from './num.js'

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

/** v1's LOOK_KEYS: the order every Look object keeps (and the PUT body's). */
export const LOOK_KEYS = [
  'exposure', 'warmth', 'light_azimuth_deg', 'light_elevation_deg', 'light_softness', 'light_strength', 'ambient',
  'contact_shadows', 'auto_light', 'cast_shadows',
] as const

/** v1's LOOK_DEFAULT (exposure and warmth). */
export const LOOK_DEFAULT = { exposure: 1, warmth: 0 } as const

function numOrNull(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(hi, Math.max(lo, v))
}

function azOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(180, Math.max(-180, wrapAz(v)))
}

function boolOr(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/** v1's lookFrom: a scene's `look` (or anything) to the full Look, each key clamped or defaulted. */
export function lookFrom(src: JsonObject | null): LookState {
  if (src === null) return defaultLook()
  return {
    exposure: clampNum(src['exposure'], 0.25, 4, 1),
    warmth: clampNum(src['warmth'], -1, 1, 0),
    light_azimuth_deg: azOrNull(src['light_azimuth_deg']),
    light_elevation_deg: numOrNull(src['light_elevation_deg'], 5, 90),
    light_softness: numOrNull(src['light_softness'], 0, 1),
    light_strength: clampNum(src['light_strength'], 0, 3, 1),
    ambient: clampNum(src['ambient'], 0, 3, 1),
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
export function goesManual(p: JsonObject): boolean {
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
export function patchLook(look: LookState, p: JsonObject, inUse: InUse | null): LookState {
  const manual = goesManual(p)
  let az = look.light_azimuth_deg
  let el = look.light_elevation_deg
  let soft = look.light_softness
  if (manual && look.auto_light && inUse !== null) {
    az = round(wrapAz(inUse.light_azimuth_deg), 3)
    el = round(Math.min(90, Math.max(5, inUse.light_elevation_deg)), 3)
    soft = round(inUse.light_softness, 4)
  }
  const pAz = azOrNull(p['light_azimuth_deg'])
  const pEl = numOrNull(p['light_elevation_deg'], 5, 90)
  const pSoft = numOrNull(p['light_softness'], 0, 1)
  const pAuto = p['auto_light']
  const pContact = p['contact_shadows']
  const pCast = p['cast_shadows']
  return {
    exposure: clampNum(p['exposure'], 0.25, 4, look.exposure),
    warmth: clampNum(p['warmth'], -1, 1, look.warmth),
    light_azimuth_deg: pAz ?? az,
    light_elevation_deg: pEl ?? el,
    light_softness: pSoft ?? soft,
    light_strength: clampNum(p['light_strength'], 0, 3, look.light_strength),
    ambient: clampNum(p['ambient'], 0, 3, look.ambient),
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

export function lightingReport(l: LookState, r: ResolvedLook, inf: InferredKey | null, k: KeyInUse, source: LightingSource, st: LightingStatus): LightingReport {
  return {
    exposure: l.exposure,
    warmth: l.warmth,
    contact_shadows: l.contact_shadows,
    auto_light: l.auto_light,
    light_azimuth_deg: round(r.light_azimuth_deg, 3),
    light_elevation_deg: round(r.light_elevation_deg, 3),
    light_softness: round(r.light_softness, 4),
    light_strength: l.light_strength,
    ambient: l.ambient,
    cast_shadows: r.cast_shadows,
    source,
    inferred: inf === null ? null : {
      azimuth_deg: round(inf.azimuth_deg, 3),
      elevation_deg: round(inf.elevation_deg, 3),
      softness: inf.softness,
      direction: roundAll(inf.direction, 6),
      color: inf.color,
      intensity: inf.intensity,
      cct_k: inf.cct_k,
    },
    key: {
      azimuth_deg: round(k.azimuth_deg, 3),
      elevation_deg: round(k.elevation_deg, 3),
      direction: roundAll(k.direction, 6),
      color: k.color,
      intensity: round(k.intensity, 6),
      softness: round(k.softness, 4),
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

/** v1's warmthTint: a warm (w > 0) or cool tint of luminance 1 (three.js Vector3.multiplyScalar by 1 / luminance). */
export function warmthTint(w: number): Vec3 {
  const x = 1 + 0.14 * w
  const y = 1 + 0.015 * w
  const z = 1 - 0.14 * w
  const k = 1 / (0.2126 * x + 0.7152 * y + 0.0722 * z)
  return [x * k, y * k, z * k]
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
export function keepChannel(amb: number, even: number, keyColor: number, keyIntensity: number, ambient: number, strength: number, upY: number): number {
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
