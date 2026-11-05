// midstudy planner engine: the photo, the locked scene camera registered to it, the furniture drawn over it, and the
// API calls. No DOM UI lives here: UI modules (planner/ui/) read state through getters, call actions, and listen to
// `engine.events`. Spec: contract/CONTRACT.md §2 (carried from nook) and §4 (scenes). Units are meters, Y-up, the floor
// is y = 0, the camera stands at (0, height, 0) and looks along −Z (contract §4.1). Items are stored in their item frame.
//
// Drawing (each frame, on demand):
//   1. furniture pass, into a half-float MSAA target: an optional depth pre-pass writes the photo's depth (depth.png,
//      + 3 cm) into the depth buffer with colour writes off, then the pieces, their contact shadows and the floor grid
//      draw on top of it (so the real sofa hides a piece behind it);
//   2. splat pass (only while splat items are placed, §4.5 Splats): Spark draws the splats (camera layer SPLAT_LAYER,
//      nothing else) into a second half-float target that shares the furniture pass's depth texture, so splats test
//      against the photo's depth and the meshes (3 cm tolerance, like meshes) and write none. Their GLB (the stand-in
//      box for idol) is in the scene but invisible: it picks, drags, bounds and casts the contact shadow.
//   3. the screen: the photo, drawn exactly as its bytes are (no tone mapping, exposure or warmth), contain-fit in the
//      uncovered part of the window (letterbox bars), then the furniture pass composited over it with the Look
//      (exposure, warmth), ACES Filmic and sRGB applied to the furniture only, then the splat pass over that: splat
//      colours are photo colours, so only exposure × warmth applies to them, as a plain multiplier (no ACES). Contact
//      shadows live in the furniture pass, so they never darken a splat.
//   Zoom and pan are 2D (camera.setViewOffset over the photo's rectangle); the camera block never changes for them.
//   Renders capture the same passes at the photo's own resolution (no view offset, no UI), splats sorted first.
//
// Coordinates: "photo px" are contract §4.1 pixels on photo.jpg at its full size; "client px" are CSS pixels in the
// window. projectPhoto(), photoToFloor() and floorToPhoto() implement §4.1 exactly; picking uses the same rays.
//
// State getters
//   getScene()          { name, title, w, h, camera, camera_source, calib, floor_found, hasDepth, photo_url, ... } | null
//   getSceneLoad()      { loading, phase: 'calibrating'|'photo'|null, name, scene (the §4.4 object while it calibrates) }
//   getCamera()         the camera block in use (§4.1)
//   getCalibCamera()    calib.json's camera, or null
//   getAdjustFloor(), getOcclusion(), getGridVisible(), getFloorNote() (the "Check the floor" reason, or null)
//   getView()           { zoom, cx, cy, fit } zoom 1–4; cx, cy the photo px at the stage centre
//   getPhotoRect()      { x, y, w, h } the photo's rectangle in client px (beyond the window when zoomed)
//   getStageRect()      { x, y, w, h } the part of the window the photo fits into (client px)
//   isSceneDirty() / isLayoutDirty() / getDirty() { scene, layout }
//   getItems() / getItem(uid) / getItemBounds(uid) / getSelected() / getDrag() / getFootprint(uid) / hitItemAt(uid, x, y, pad)
//   getSelected()       the primary selected piece (the last one picked), or null
//   getSelection()      every selected piece, in the order picked (the primary last); isSelected(uid)
//   itemAt(x, y)        the placed piece under a client point, or null
//   getLook()           { exposure, warmth, contactShadows }
//   getLibrary(), assetUrl(rel), getLayouts(), getLayoutDetails(), getLayoutName(), getRenders(), isRenderMock()
//   getLayoutTitle(), layoutDisplayName(slug)   a layout's name as typed ("Phone A"), else the slug made readable
//   getScenesTrash()    [{name, title, created, deleted}] deleted scenes the server keeps
//   getRuler()          { active, points: [[x,0,z]…], meters|null }
//   getState() / getRenderSettings()   the window.midstudy shapes (contract §2.4, §4.6)
// Actions (async ones return Promises that reject with a reported error)
//   init(), mount(el), setStageInsets({ left, right, top, bottom }) (client px the chrome covers)
//   listScenesInternal(), openScene(name) (also loads the layout last open there on this device), closeScene(),
//   waitForScene(name), createScene(file, meta), deleteScene(name), restoreScene(name), renameScene(name, title),
//   saveScene(), saveThumbnail()
//   setCamera(partial), resetCamera(), setAdjustFloor(on), setOcclusion(on), setGridVisible(on), setPitchFromHorizon(py)
//   zoomAt(clientX, clientY, zoom), zoomBy(factor, clientX?, clientY?), panBy(dxClient, dyClient), fitView()
//   addItemInternal(id, opts), moveItemInternal(uid, opts), removeItemInternal(uid), clearItemsInternal(),
//   select(uid|null, { toggle, add }) (toggle: Shift+click, in or out of the selection; add: keep the others),
//   selectMany(uids), selectAll(), rotateSelected(deg) (several: around their middle, as one group),
//   nudgeSelected([dx, dy, dz]) (m; every selected piece), duplicateSelected() → new uids,
//   setSnap(on), beginItemDrag / beginRotateDrag / dragTo / endItemDrag (a selected piece drags the whole selection),
//   removeItemWithUndo(uid), restoreItem(snapshot), restoreItems(snapshots), setElevation(uid, m),
//   nudgeElevation(uid, dm), dropToFloor(uid), reloadLibrary()
//   tap(clientX, clientY), setRulerActive(on), clearRuler(), setRulerTrueLength(m) (scales the camera height)
//   setLook({exposure, warmth}), setContactShadows(on)
//   saveLayoutInternal(name, { title }), loadLayoutInternal(name), deleteLayoutInternal(name) → the doc (for Undo),
//   restoreLayoutInternal(doc), listLayoutsInternal(), refreshLayouts()
//   captureComposite({ maxPx, quality }), captureMask(), postRender(shot, opts), renderViewInternal(opts),
//   exportImage({ longEdge, type, quality, encode }) → { blob, canvas, width, height } (the view as drawn, no AI, nothing sent),
//   listRendersInternal(), compare(a, b), settleSplats() (sort the splats for the camera now; renderViewInternal does)
//   reportError(msg, err) → Error, toast(text, kind, ms), onFrame(fn), worldToScreen(p) → { x, y, visible } (client px)
//   projectPhoto(p) → [px, py, d], photoToFloor(px, py), floorToPhoto(p), clientToPhoto(x, y), photoToClient(px, py)
// Events (engine.events, CustomEvents; read e.detail)
//   'scene'  { phase: 'loading'|'calibrating'|'opened'|'failed'|'closed'|'saved'|'title'|'deleted', name }
//   'scenes' { scenes }   'camera' { camera, source }   'adjust' { on }   'occlusion' { on }   'grid' { visible }
//   'view' getView()      'dirty' { scene, layout }     'items' { change, uid }   'selection' { uid, uids }   'drag' { mode, uid, phase }
//   'look' getLook()      'library' { items }   'layouts' { names?, details?, name? }   'renders' { renders }
//   'render' { phase: 'start'|'done'|'failed', model, meta? }   'compare' { a, b }   'ruler' getRuler()
//   'error' { text }      'toast' { text, kind, ms }
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createLighting, azElOf, dirOf, V1_KEY_DIR, V1_SOFTNESS } from './lighting.js'

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEG = Math.PI / 180

const params = new URLSearchParams(location.search)
export const LIBRARY_URL = params.get('library') || '/library/library.json'
const libraryBase = new URL(LIBRARY_URL, location.href)

export const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
export const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)))
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const fmtCm = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
export const dimsText = (d) => (d ? `${fmtCm(d.w)} × ${fmtCm(d.d)} × ${fmtCm(d.h)} cm` : '')
export const wrapDeg = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x }
// Fire-and-forget wrapper for UI handlers: failures are already reported, never thrown.
export const quiet = (p) => { Promise.resolve(p).catch(() => {}) }
// §2.9: every POST, PUT, PATCH and DELETE the page makes carries X-Midstudy: 1 (the server refuses it otherwise).
export function withMidstudy(opts = {}) {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(opts?.method || 'GET')) return opts
  return { ...opts, headers: { ...(opts.headers || {}), 'X-Midstudy': '1' } }
}
export const MAX_ELEVATION = 4 // m (§2.10)
const clampElev = (y) => Math.min(MAX_ELEVATION, Math.max(0, y))
const clampNum = (v, lo, hi, dflt) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : dflt)

// --- the camera block (contract §4.1) ------------------------------------------------------------------------------
export const CAMERA_RANGE = { fov_y_deg: [20, 110], height_m: [0.2, 3.0], pitch_deg: [-80, 30], roll_deg: [-20, 20] }
export const DEFAULT_CAMERA = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
export function clampCamera(c, base = DEFAULT_CAMERA) {
  const out = {}
  for (const [k, [lo, hi]] of Object.entries(CAMERA_RANGE)) out[k] = round(clampNum(c?.[k], lo, hi, base[k]), 6)
  return out
}
const sameCamera = (a, b) => !!a && !!b && Object.keys(CAMERA_RANGE).every((k) => Math.abs(a[k] - b[k]) < 1e-6)
export const LOOK_DEFAULT = { exposure: 1, warmth: 0 }
// The Look (contract §4.8): exposure and warmth (furniture only), and the lighting controls. A null value means the
// scene's default: the inferred direction and softness (from lighting.json, or the v1 key light without one) and
// cast_shadows on exactly when the scene has lighting.json.
const LOOK_NUM = { exposure: [0.25, 4, 1], warmth: [-1, 1, 0], light_azimuth_deg: [-180, 180, null], light_elevation_deg: [5, 90, null], light_softness: [0, 1, null], light_strength: [0, 3, 1], ambient: [0, 3, 1] }
const LOOK_BOOL = { contact_shadows: true, auto_light: true, cast_shadows: null }
const LOOK_KEYS = [...Object.keys(LOOK_NUM), ...Object.keys(LOOK_BOOL)]
const wrapAz = (a) => { const w = ((((a + 180) % 360) + 360) % 360) - 180; return w === -180 && a > 0 ? 180 : w }
function lookFrom(l) {
  const src = l && typeof l === 'object' ? l : {}
  const out = {}
  for (const [k, [lo, hi, d]] of Object.entries(LOOK_NUM)) out[k] = isNum(src[k]) ? Math.min(hi, Math.max(lo, k === 'light_azimuth_deg' ? wrapAz(src[k]) : src[k])) : d
  for (const [k, d] of Object.entries(LOOK_BOOL)) out[k] = typeof src[k] === 'boolean' ? src[k] : d
  return out
}
const OCCLUSION_TOLERANCE = 0.03 // m (§4.5)
const MAX_ZOOM = 4
const BAR = new THREE.Color(0x0e0f11) // letterbox bars

// --- events, errors + toasts ------------------------------------------------
const events = new EventTarget()
const emit = (name, detail = {}) => { wake(); events.dispatchEvent(new CustomEvent(name, { detail })) }
// On-demand rendering: draw while something changes (input, any engine event) and for a short tail after. A wake
// always gets at least one frame, however late the browser's next frame comes (a slow GPU, or software rendering
// where one frame can take longer than the tail): otherwise a change made just before a slow frame (Set scale, a
// toast, a layout loading) stayed undrawn until the pointer moved.
let awakeUntil = 0
let framePending = false
function wake(ms = 400) { awakeUntil = Math.max(awakeUntil, performance.now() + ms); framePending = true }
for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'keyup', 'resize', 'touchmove']) window.addEventListener(t, () => wake(), { passive: true, capture: true })
const errors = []
function toast(text, kind = 'info', ms = 6000) { emit('toast', { text, kind, ms }) }
function reportError(msg, err) {
  const detail = err ? (err.message || String(err)) : ''
  const text = detail && !msg.includes(detail) ? `${msg}: ${detail}` : msg
  errors.push(text)
  emit('error', { text })
  console.warn('[midstudy]', text)
  return new Error(text)
}
window.addEventListener('error', (e) => { if (e.error || e.message) reportError(`Unexpected error: ${e.message}`) })
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault()
  reportError('Unexpected error', e.reason)
})
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const LAST_SCENE_KEY = 'midstudy.lastScene'

// --- renderer -------------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.autoClear = false
renderer.toneMapping = THREE.NoToneMapping
const canvas = renderer.domElement
const drawSize = new THREE.Vector2()

// Full-screen triangle for the screen-space passes.
const triGeo = new THREE.BufferGeometry()
triGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
const fsVert = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }'
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
function fsMesh(material, renderOrder = 0) {
  const m = new THREE.Mesh(triGeo, material)
  m.frustumCulled = false
  m.renderOrder = renderOrder
  m.raycast = () => {}
  return m
}
// The photo's rectangle in the target's pixels (top-left origin) → uv with v down; outside the photo: false.
const PHOTO_UV = `
uniform vec4 uRect;
uniform vec2 uTarget;
vec2 photoUv() {
  vec2 p = vec2(gl_FragCoord.x, uTarget.y - gl_FragCoord.y);
  return (p - uRect.xy) / uRect.zw;
}
bool inPhoto(vec2 uv) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
`

// 1. the photo, as its bytes are (NoColorSpace texture, no tone mapping, no colour conversion)
const photoMat = new THREE.ShaderMaterial({
  uniforms: { tPhoto: { value: null }, uHas: { value: 0 }, uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uTarget: { value: new THREE.Vector2(1, 1) }, uBar: { value: new THREE.Vector3(BAR.r, BAR.g, BAR.b) } },
  vertexShader: fsVert,
  fragmentShader: `${PHOTO_UV}
uniform sampler2D tPhoto;
uniform float uHas;
uniform vec3 uBar;
void main() {
  vec2 uv = photoUv();
  if (uHas < 0.5 || !inPhoto(uv)) { gl_FragColor = vec4(uBar, 1.0); return; }
  gl_FragColor = vec4(texture2D(tPhoto, uv).rgb, 1.0);
}`,
  depthTest: false, depthWrite: false, toneMapped: false,
})
const photoScene = new THREE.Scene()
photoScene.add(fsMesh(photoMat))

// 2. the furniture, composited over the photo: un-premultiply, warmth tint, exposure + ACES Filmic, sRGB.
// Its depth (the photo's depth pass, then the meshes) is resolved into a texture that the splat target shares.
const furnDepth = new THREE.DepthTexture(1, 1)
const furnRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, depthTexture: furnDepth })
const splatRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, depthTexture: furnDepth })
const compMat = new THREE.ShaderMaterial({
  uniforms: { tFurn: { value: furnRT.texture }, uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uTarget: { value: new THREE.Vector2(1, 1) }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uExposure: { value: 1 } },
  vertexShader: fsVert,
  fragmentShader: `${PHOTO_UV}
uniform sampler2D tFurn;
uniform vec3 uTint;
uniform float uExposure;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) { // three.js ACESFilmicToneMapping, same constants
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 srgb(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
void main() {
  if (!inPhoto(photoUv())) discard; // the furniture is part of the photo's frame, never the letterbox bars
  vec4 c = texture2D(tFurn, gl_FragCoord.xy / uTarget);
  if (c.a <= 0.002) discard;
  vec3 rgb = srgb(aces(max(c.rgb / c.a, 0.0) * uTint));
  gl_FragColor = vec4(rgb, min(c.a, 1.0));
}`,
  transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
})
const compScene = new THREE.Scene()
compScene.add(fsMesh(compMat))
// 3. the splats, composited over that: Spark wrote them linear and premultiplied (a render target's colour space is
// linear), so un-premultiply, then the plain Look multiplier (exposure × warmth tint), then sRGB: at the default Look a
// splat shows its own colour, the photo's. uRect and uTarget are compMat's own uniforms (always the same values).
const splatCompMat = new THREE.ShaderMaterial({
  uniforms: { tSplat: { value: splatRT.texture }, uRect: compMat.uniforms.uRect, uTarget: compMat.uniforms.uTarget, uGain: { value: new THREE.Vector3(1, 1, 1) } },
  vertexShader: fsVert,
  fragmentShader: `${PHOTO_UV}
uniform sampler2D tSplat;
uniform vec3 uGain;
vec3 srgb(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
void main() {
  if (!inPhoto(photoUv())) discard;
  vec4 c = texture2D(tSplat, gl_FragCoord.xy / uTarget);
  if (c.a <= 0.002) discard;
  vec3 rgb = srgb(clamp(c.rgb / c.a * uGain, 0.0, 1.0));
  gl_FragColor = vec4(rgb, min(c.a, 1.0));
}`,
  transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
})
const splatCompScene = new THREE.Scene()
splatCompScene.add(fsMesh(splatCompMat))

// The furniture scene: lights, the depth pre-pass, the grid, the pieces.
const scene = new THREE.Scene()
// The lights (planner/lighting.js, contract §4.8): lighting.json's probe, key and floor shadow, or the v1 lights.
const lights = createLighting({ renderer, scene, photoUv: PHOTO_UV, photoUniforms: { tPhoto: photoMat.uniforms.tPhoto, uRect: compMat.uniforms.uRect, uTarget: compMat.uniforms.uTarget } })

// The depth pre-pass (§4.5): the photo's depth (+ tolerance) into the depth buffer, colour writes off. Depth 0 never occludes.
const depthMat = new THREE.ShaderMaterial({
  uniforms: { tDepth: { value: null }, uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uTarget: { value: new THREE.Vector2(1, 1) }, uTol: { value: OCCLUSION_TOLERANCE }, uProj: { value: new THREE.Matrix4() }, uScale: { value: 1 } },
  vertexShader: fsVert,
  fragmentShader: `${PHOTO_UV}
uniform sampler2D tDepth;
uniform float uTol;
uniform float uScale;
uniform mat4 uProj;
void main() {
  vec2 uv = photoUv();
  if (!inPhoto(uv)) discard;
  float d = texture2D(tDepth, uv).r * uScale;
  if (d <= 0.0) discard;
  vec4 clip = uProj * vec4(0.0, 0.0, -(d + uTol), 1.0);
  gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(0.0);
}`,
  colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth, toneMapped: false,
})
const depthPass = fsMesh(depthMat, -1000)
depthPass.name = 'depth-prepass'
depthPass.visible = false
scene.add(depthPass)

// The floor grid (§4.5): 50 cm lines on y = 0 out to 8 m, fading with distance; 1 m lines a little stronger.
const gridMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color(0xf3d27a) }, uOpacity: { value: 1 } },
  vertexShader: 'varying vec3 vWorld;\nvoid main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: `
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uOpacity;
float lines(vec2 p) { vec2 w = max(fwidth(p), vec2(1e-5)); vec2 a = abs(fract(p - 0.5) - 0.5) / w; return 1.0 - min(min(a.x, a.y), 1.0); }
void main() {
  float minor = lines(vWorld.xz / 0.5);
  float major = lines(vWorld.xz);
  float dist = length(vWorld.xz);
  float fade = 1.0 - smoothstep(5.0, 8.0, dist);
  float a = max(minor * 0.5, major * 0.85) * fade * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a, a);
}`,
  transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
})
const grid = new THREE.Mesh(new THREE.PlaneGeometry(16.5, 16.5).rotateX(-Math.PI / 2), gridMat)
grid.position.y = 0.001
grid.renderOrder = 5
grid.raycast = () => {}
grid.name = 'floor-grid'
grid.visible = false
scene.add(grid)

// --- the scene camera (contract §4.1) --------------------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 200)
camera.rotation.order = 'YXZ'
let cam = { ...DEFAULT_CAMERA }
const R = new THREE.Matrix3() // camera-to-world rotation, Ry(0)·Rx(pitch)·Rz(roll)
function applyCamera() {
  camera.fov = cam.fov_y_deg
  camera.position.set(0, cam.height_m, 0)
  camera.rotation.set(cam.pitch_deg * DEG, 0, cam.roll_deg * DEG, 'YXZ')
  camera.updateMatrixWorld(true)
  R.setFromMatrix4(camera.matrixWorld)
  lights.setCamera(R, cam.fov_y_deg)
  lights.setLook(resolvedLook()) // the inferred key turns with the camera (§4.8: lighting.json is in its frame)
  updateView()
}

// --- the photo and the view (letterbox, zoom, pan) -----------------------------------------------------------------
const photo = { w: 1600, h: 1200, has: false, image: null, texture: null, depth: null, depthTexture: null }
const stageInsets = { left: 0, right: 0, top: 0, bottom: 0 }
const view = { zoom: 1, cx: 800, cy: 600 }
function canvasRect() { return canvas.getBoundingClientRect() }
function stageRect() {
  const r = canvasRect()
  const x = stageInsets.left, y = stageInsets.top
  return { x: r.left + x, y: r.top + y, w: Math.max(40, r.width - x - stageInsets.right), h: Math.max(40, r.height - y - stageInsets.bottom) }
}
const fitScale = (st = stageRect()) => Math.min(st.w / photo.w, st.h / photo.h)
// Photo → client: client = o + s · photo px
function viewParams() {
  const st = stageRect()
  const s = fitScale(st) * view.zoom
  return { s, ox: st.x + st.w / 2 - s * view.cx, oy: st.y + st.h / 2 - s * view.cy, st }
}
function clampCenter() {
  const st = stageRect()
  const s = fitScale(st) * view.zoom
  const lim = (c, len, stageLen) => (s * len <= stageLen + 0.5 ? len / 2 : Math.min(len - stageLen / (2 * s), Math.max(stageLen / (2 * s), c)))
  view.cx = lim(view.cx, photo.w, st.w)
  view.cy = lim(view.cy, photo.h, st.h)
}
function updateView() {
  renderer.getDrawingBufferSize(drawSize)
  const r = canvasRect()
  const k = r.width > 0 ? drawSize.x / r.width : renderer.getPixelRatio()
  clampCenter()
  const { s, ox, oy } = viewParams()
  camera.aspect = photo.w / photo.h
  // The canvas is a window onto the photo's rectangle (s·W × s·H, its top-left at o): a sub-view of the full frame.
  camera.setViewOffset(s * photo.w, s * photo.h, r.left - ox, r.top - oy, r.width || 1, r.height || 1)
  camera.updateProjectionMatrix()
  const rect = [(ox - r.left) * k, (oy - r.top) * k, s * photo.w * k, s * photo.h * k]
  photoMat.uniforms.uRect.value.set(...rect)
  depthMat.uniforms.uRect.value.set(...rect)
  compMat.uniforms.uRect.value.set(...rect)
  photoMat.uniforms.uTarget.value.copy(drawSize)
  depthMat.uniforms.uTarget.value.copy(drawSize)
  compMat.uniforms.uTarget.value.copy(drawSize)
  depthMat.uniforms.uProj.value.copy(camera.projectionMatrix)
  wake()
}
// depth.png is metric in the calibration's frame, where the camera stood calib.json's height_m above the floor it found.
// When Adjust floor changes the height, the furniture's world is that frame scaled by height / calib height, so the
// photo's depth is scaled the same way (otherwise a piece just in front of the sofa would hide behind it). Without a
// measured floor (floor.found false, or a fallback) the calibration's height is a guess and the depth stays as it is.
function depthScale() {
  const c = sceneData?.calib
  const h0 = c?.floor?.found && (c.source === 'moge-2' || c.source === 'truth') ? Number(c.camera?.height_m) : NaN
  return h0 > 0 ? cam.height_m / h0 : 1
}
function emitView() { emit('view', getView()) }
function getView() { return { zoom: round(view.zoom, 4), cx: round(view.cx, 2), cy: round(view.cy, 2), fit: view.zoom <= 1.0001 } }
function setStageInsets(ins = {}) {
  const px = (v) => (isNum(v) && v > 0 ? v : 0)
  Object.assign(stageInsets, { left: px(ins.left), right: px(ins.right), top: px(ins.top), bottom: px(ins.bottom) })
  updateView()
  emitView()
}
function fitView() {
  view.zoom = 1
  view.cx = photo.w / 2
  view.cy = photo.h / 2
  updateView()
  emitView()
}
// Zoom to `zoom` (1–4) keeping the photo point under (clientX, clientY) where it is.
function zoomAt(clientX, clientY, zoom) {
  const z = Math.min(MAX_ZOOM, Math.max(1, zoom))
  const before = clientToPhoto(clientX, clientY)
  view.zoom = z
  const { s, st } = viewParams()
  // keep `before` under the pointer: o' = pointer − s'·p, centre = (stage centre − o') / s'
  view.cx = (st.x + st.w / 2 - (clientX - s * before[0])) / s
  view.cy = (st.y + st.h / 2 - (clientY - s * before[1])) / s
  updateView()
  emitView()
}
function zoomBy(factor, clientX, clientY) {
  const st = stageRect()
  zoomAt(isNum(clientX) ? clientX : st.x + st.w / 2, isNum(clientY) ? clientY : st.y + st.h / 2, view.zoom * factor)
}
function panBy(dx, dy) {
  const { s } = viewParams()
  view.cx -= dx / s
  view.cy -= dy / s
  updateView()
  emitView()
}
function clientToPhoto(x, y) {
  const { s, ox, oy } = viewParams()
  return [(x - ox) / s, (y - oy) / s]
}
function photoToClient(px, py) {
  const { s, ox, oy } = viewParams()
  return [ox + s * px, oy + s * py]
}
function getPhotoRect() {
  const { s, ox, oy } = viewParams()
  return { x: ox, y: oy, w: s * photo.w, h: s * photo.h }
}
// The visible part of the photo (client px): the photo rectangle cut to the stage.
function visiblePhotoRect() {
  const p = getPhotoRect(), st = stageRect()
  const x0 = Math.max(p.x, st.x), y0 = Math.max(p.y, st.y), x1 = Math.min(p.x + p.w, st.x + st.w), y1 = Math.min(p.y + p.h, st.y + st.h)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  resizeTargets()
  updateView()
  emitView()
})
function resizeTargets() {
  renderer.getDrawingBufferSize(drawSize)
  sizeTargets(Math.max(1, drawSize.x), Math.max(1, drawSize.y))
}
// The furniture and splat targets share one depth texture, so they always change size together.
function sizeTargets(w, h) {
  if (splatRT.width !== w || splatRT.height !== h) splatDrawn = null // a new size drops the target's contents
  furnRT.setSize(w, h)
  splatRT.setSize(w, h)
}
// The splat pass is the expensive one (hundreds of thousands of splats; seconds per frame in software rendering), and
// most frames change nothing it draws (the UI wakes the loop, a toast, the grid). So it's redrawn only when its key
// changes: the camera and view, the target size, the occlusion depth, every placed piece's transform (meshes hide
// splats), and splatEpoch, which Spark's onDirty (a load, generate or sort landed) and every rebuilt piece bump.
let splatEpoch = 0
let splatDrawn = null
function splatKey() {
  const k = [splatEpoch, splatRT.width, splatRT.height, depthPass.visible ? 1 : 0, depthMat.uniforms.uScale.value, photo.depthTexture?.id ?? -1, ...camera.projectionMatrix.elements, ...camera.matrixWorld.elements]
  for (const r of items.values()) k.push(r.uid, ...r.group.matrixWorld.elements)
  return k.join(',')
}
resizeTargets()

function mount(el) {
  el.appendChild(canvas)
  updateView()
}

// --- projection (contract §4.1, exactly) ------------------------------------------------------------------------------
const focalPx = () => (photo.h / 2) / Math.tan((cam.fov_y_deg * DEG) / 2)
const tmpV = new THREE.Vector3()
// World point → [px, py, d] in photo px; d = depth along the view axis (> 0 in front).
function projectPhoto(p) {
  tmpV.set(p[0] ?? p.x, (p[1] ?? p.y) - cam.height_m, p[2] ?? p.z)
  const e = R.elements // column-major; Rᵀ·v
  const xc = e[0] * tmpV.x + e[1] * tmpV.y + e[2] * tmpV.z
  const yc = e[3] * tmpV.x + e[4] * tmpV.y + e[5] * tmpV.z
  const zc = e[6] * tmpV.x + e[7] * tmpV.y + e[8] * tmpV.z
  const d = -zc
  const f = focalPx()
  return [photo.w / 2 + (f * xc) / d, photo.h / 2 - (f * yc) / d, d]
}
// The world ray through a photo pixel: { origin, dir } (dir normalized).
function photoRay(px, py) {
  const f = focalPx()
  const dir = new THREE.Vector3((px - photo.w / 2) / f, -(py - photo.h / 2) / f, -1).applyMatrix3(R).normalize()
  return { origin: new THREE.Vector3(0, cam.height_m, 0), dir }
}
function photoToFloor(px, py) {
  if (!isNum(px) || !isNum(py)) return null
  const { origin, dir } = photoRay(px, py)
  if (dir.y >= -1e-9) return null
  const t = -origin.y / dir.y
  return [origin.x + t * dir.x, 0, origin.z + t * dir.z]
}
function floorToPhoto(p) {
  const [px, py] = projectPhoto(p)
  return [px, py]
}
// Client px of a world point; visible is false behind the camera.
function worldToScreen(p) {
  const [px, py, d] = projectPhoto(Array.isArray(p) ? p : [p.x, p.y, p.z])
  const [x, y] = photoToClient(px, py)
  return { x, y, visible: d > 1e-4 }
}
// The horizon (where the floor plane vanishes) at photo column px: the row py, or null when it's vertical.
function horizonAt(px) {
  // sin(roll)·x_c + cos(roll)·y_c = −tan(pitch), x_c = (px − W/2)/f, y_c = −(py − H/2)/f
  const f = focalPx(), sr = Math.sin(cam.roll_deg * DEG), cr = Math.cos(cam.roll_deg * DEG), tp = Math.tan(cam.pitch_deg * DEG)
  if (Math.abs(cr) < 1e-6) return null
  const yc = (-tp - sr * ((px - photo.w / 2) / f)) / cr
  return photo.h / 2 - yc * f
}
// Dragging the horizon line: its middle (at the photo's centre column) to row py sets the pitch.
function setPitchFromHorizon(py) {
  if (!isNum(py)) return
  const f = focalPx(), cr = Math.cos(cam.roll_deg * DEG)
  const yc = -(py - photo.h / 2) / f
  setCamera({ pitch_deg: -Math.atan(cr * yc) / DEG })
}

// --- raycasting -------------------------------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster()
function setRay(clientX, clientY) {
  scene.updateMatrixWorld()
  const [px, py] = clientToPhoto(clientX, clientY)
  const { origin, dir } = photoRay(px, py)
  raycaster.ray.set(origin, dir)
  raycaster.camera = camera
}
function uidOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData?.uid) return o.userData.uid
  return null
}
function hitItems() {
  const hits = raycaster.intersectObjects([...items.values()].map((r) => r.group), true)
  for (const h of hits) { const uid = uidOf(h.object); if (uid && h.object.name !== 'contact-shadow') return { uid, point: h.point.clone(), distance: h.distance } }
  return null
}
function planePointAt(plane, clientX, clientY) {
  setRay(clientX, clientY)
  const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  return p && p.distanceTo(raycaster.ray.origin) < 60 ? p : null
}
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const floorPointAt = (x, y) => planePointAt(floorPlane, x, y)

// --- contact shadows (contract §2.6.3, as nook) -------------------------------------------------------------------------
const shadowTex = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, 'rgba(0,0,0,0.95)')
  grd.addColorStop(0.45, 'rgba(0,0,0,0.85)')
  grd.addColorStop(0.65, 'rgba(0,0,0,0.55)')
  grd.addColorStop(0.82, 'rgba(0,0,0,0.2)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
})()
const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, depthWrite: false, opacity: 0.75 })
const SHADOW_Y = 0.004
function makeContactShadow(rec) {
  const box = rec.localBox
  const size = box.getSize(new THREE.Vector3())
  const c = box.getCenter(new THREE.Vector3())
  const shadow = new THREE.Mesh(shadowGeo, shadowMat)
  shadow.name = 'contact-shadow'
  shadow.position.set(c.x, SHADOW_Y, c.z)
  shadow.scale.set(size.x * 1.45 + 0.06, 1, size.z * 1.45 + 0.06)
  shadow.renderOrder = 2
  shadow.raycast = () => {}
  return shadow
}
function setContactShadows(on) {
  setLighting({ contact_shadows: !!on })
}
// The blob stays on the floor (a child of the item, shifted down by the elevation); a raised item (its bottom more
// than 2 cm up, §2.10) has none.
function syncShadow(rec) {
  const y = rec.group.position.y
  if (rec.shadow) { rec.shadow.visible = look.contact_shadows && y <= 0.02; rec.shadow.position.y = SHADOW_Y - y }
}

// --- library + items --------------------------------------------------------------------------------------------------
let library = []
let libraryLoading = Promise.resolve() // the library read in flight (a layout waits for it, or its pieces look missing)
const items = new Map() // uid -> { uid, id, lib, group, child, localBox, rotationDeg, shadow, missing }
let itemsGen = 0
let uidCounter = 0
const THREE_LIBS = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/'
const gltfLoader = new GLTFLoader()
  .setDRACOLoader(new DRACOLoader().setDecoderPath(`${THREE_LIBS}draco/gltf/`))
  .setKTX2Loader(new KTX2Loader().setTranscoderPath(`${THREE_LIBS}basis/`).detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder)
const glbCache = new Map() // url -> Promise<{ scene, box }>
const assetUrl = (rel) => new URL(rel, libraryBase).href

async function fetchBytes(url) {
  let res
  try { res = await fetch(url) } catch (e) { const err = new Error(`could not fetch ${url} (${e.message})`); err.offline = true; throw err }
  if (!res.ok) { const err = new Error(`${url} returned HTTP ${res.status}`); err.status = res.status; throw err }
  return new Uint8Array(await res.arrayBuffer())
}

function loadLibrary() {
  libraryLoading = readLibrary()
  return libraryLoading
}
async function readLibrary() {
  let list = []
  try {
    const res = await fetch(LIBRARY_URL)
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data || !Array.isArray(data.items)) throw new Error('missing "items" array')
      list = data.items.filter((i) => i && typeof i.id === 'string')
    }
  } catch (e) {
    reportError(`Could not read library ${LIBRARY_URL}`, e)
  }
  library = list
  syncPlaced()
  emit('library', { items: library.slice() })
  quiet(makeMissingThumbs())
}

// After a library change (Shows as, a rescale, a re-add: data.js reloads the library), placed copies whose entry
// changed what they draw are rebuilt in place: same uid, group (position, rotation, elevation) and selection. A copy
// whose entry is gone keeps drawing what it has; renames just take the new entry.
function syncPlaced() {
  for (const rec of items.values()) {
    if (rec.missing) continue
    const lib = library.find((l) => l.id === rec.id)
    if (!lib) continue
    const sig = libSig(lib)
    if (sig === rec.sig) { rec.lib = lib; continue }
    const was = JSON.parse(rec.sig)
    const now = JSON.parse(sig)
    if (JSON.stringify(was.slice(1)) !== JSON.stringify(now.slice(1))) {
      // the files may have been rewritten at the same paths (a rescale or a re-add): read them again
      for (const rel of [rec.lib.assets?.glb, rec.lib.assets?.spz, rec.lib.assets?.splat, lib.assets?.glb, lib.assets?.spz, lib.assets?.splat]) {
        if (rel) { glbCache.delete(assetUrl(rel)); splatBytes.delete(assetUrl(rel)) }
      }
    }
    rec.sig = sig
    quiet(rebuildItem(rec, lib))
  }
}
async function rebuildItem(rec, lib) {
  const token = ++rec.build
  let built
  try { built = await buildChild(lib) } catch (e) { throw reportError(`Could not reload "${lib.name || rec.id}"`, e) }
  if (token !== rec.build || items.get(rec.uid) !== rec) { disposeBuilt(built); return }
  detachBuilt(rec)
  rec.lib = lib
  attachBuilt(rec, built)
  rec.group.updateMatrixWorld(true)
  emit('items', { change: 'render', uid: rec.uid })
}

// --- thumbnails for pieces added from a 3D file ----------------------------------------------------------------------
// A GLB or OBJ add has no photo, so midstudy-add writes no thumb.jpg and the library showed initials. The planner
// renders one (front three-quarter view, the room's lighting, 256 px), and PUT /api/library/items/<id>/thumb stores it
// next to the model, so every device gets it. One at a time, once per item per page load; only for the server's own
// library (a ?library= elsewhere is read-only). Its own small WebGL renderer, so the photo view is never disturbed.
const OWN_LIBRARY = (() => { const u = new URL(LIBRARY_URL, location.href); return u.origin === location.origin && u.pathname === '/library/library.json' })()
const thumbTried = new Set()
let thumbsRunning = false
async function makeMissingThumbs() {
  if (!OWN_LIBRARY || thumbsRunning) return
  thumbsRunning = true
  try {
    for (;;) {
      // never from a GLB that isn't what's drawn: a splat item's (an idol item's is a stand-in box, §1); their adds
      // made a thumbnail from the photo anyway
      const lib = library.find((l) => l.assets?.glb && !l.assets?.thumb && !l.missing && !isStandIn(l) && pickRender(l) !== 'splat' && !thumbTried.has(l.id))
      if (!lib) break
      thumbTried.add(lib.id)
      let image
      try { image = await modelThumbnail(lib) } catch (e) { console.warn('[midstudy] no thumbnail for', lib.id, e); continue }
      try {
        const item = await apiJson(`/api/library/items/${encodeURIComponent(lib.id)}/thumb`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) })
        const cur = library.find((l) => l.id === lib.id)
        if (cur && item?.assets?.thumb) { cur.assets = { ...cur.assets, thumb: item.assets.thumb }; emit('library', { items: library.slice() }) }
      } catch (e) { console.warn('[midstudy] could not store the thumbnail of', lib.id, e) }
    }
  } finally { thumbsRunning = false }
}
async function modelThumbnail(lib, size = 256) {
  const t = await loadGlbTemplate(assetUrl(lib.assets.glb))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  try {
    r.setPixelRatio(1)
    r.setSize(size, size, false)
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.outputColorSpace = THREE.SRGBColorSpace
    const sc = new THREE.Scene()
    sc.background = new THREE.Color(0xe7e4df)
    const pm = new THREE.PMREMGenerator(r)
    sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(2, 4, 3)
    sc.add(key, t.scene.clone(true))
    // the item frame: footprint centre at the origin, on the floor, front +Z; seen from front-right, a little above
    const b = t.box, c = b.getCenter(new THREE.Vector3()), radius = Math.max(1e-3, b.getSize(new THREE.Vector3()).length() / 2)
    const cam = new THREE.PerspectiveCamera(30, 1, radius / 100, radius * 100)
    const dir = new THREE.Vector3(0.55, 0.42, 1).normalize()
    cam.position.copy(c).addScaledVector(dir, (radius / Math.sin((30 * DEG) / 2)) * 1.02)
    cam.lookAt(c)
    r.render(sc, cam)
    const url = canvas.toDataURL('image/jpeg', 0.88)
    pm.dispose()
    sc.environment?.dispose()
    return url
  } finally {
    r.dispose()
    r.forceContextLoss()
  }
}

function loadGlbTemplate(url) {
  if (!glbCache.has(url)) {
    const p = (async () => {
      const bytes = await fetchBytes(url)
      const base = url.slice(0, url.lastIndexOf('/') + 1)
      const gltf = await new Promise((resolve, reject) => gltfLoader.parse(bytes.buffer, base, resolve, reject))
      const root = gltf.scene || gltf.scenes?.[0]
      if (!root) throw new Error('GLB has no scene')
      root.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(root, true)
      if (box.isEmpty()) throw new Error('GLB has no geometry')
      return { scene: root, box }
    })()
    glbCache.set(url, p)
    p.catch(() => glbCache.delete(url))
  }
  return glbCache.get(url)
}

// --- splats (contract §4.5 Splats): Spark 2.4.0 from the importmap, imported on the first splat item ---------------------
// A splat item is its GLB (or a box at its dims), invisible, plus a SplatMesh: both children of the item's group, so
// position, rotation and elevation move them together. The SplatMesh and the SparkRenderer live on SPLAT_LAYER only:
// the furniture pass and the keep-room mask never draw them, and the raycaster (layer 0) picks the GLB, not the splat.
// Spark settings: sortRadial false orders by depth along the view (as nook did); everything else is Spark's default
// (nook kept the defaults on phones), with LoD off (furniture splats have no LoD tree). onDirty wakes the on-demand
// render loop when a load or a sort lands, so a splat appears without the pointer moving.
const SPLAT_LAYER = 1
let sparkModule = null // Promise<module>
let spark = null       // the SparkRenderer
function loadSpark() {
  if (!sparkModule) {
    sparkModule = import('@sparkjsdev/spark').then((m) => {
      if (!spark) {
        spark = new m.SparkRenderer({ renderer, onDirty: () => { splatEpoch++; wake(50) }, sortRadial: false, enableLod: false })
        spark.name = 'spark'
        spark.layers.set(SPLAT_LAYER)
        spark.raycast = () => {}
        scene.add(spark)
      }
      return m
    })
  }
  return sparkModule
}
const splatBytes = new Map() // url -> Promise<Uint8Array> (Spark copies them before parsing, so they can be reused)
function loadSplatBytes(url) {
  if (!splatBytes.has(url)) {
    const p = fetchBytes(url)
    splatBytes.set(url, p)
    p.catch(() => splatBytes.delete(url))
  }
  return splatBytes.get(url)
}
const splatAsset = (lib) => lib?.assets?.spz || lib?.assets?.splat || null // the SPZ first: what phones can load
// An idol item's GLB is a stand-in box at its dims (§1): never drawn, never a thumbnail.
const isStandIn = (lib) => lib?.source?.engine === 'idol'
// What a library entry draws as: its splat when default_render is "splat" and it has one, else its GLB.
const pickRender = (lib) => (!lib?.missing && lib?.default_render === 'splat' && splatAsset(lib) ? 'splat' : 'glb')
async function loadSplatMesh(lib) {
  const { SplatMesh } = await loadSpark()
  const url = assetUrl(splatAsset(lib))
  const bytes = await loadSplatBytes(url)
  const mesh = new SplatMesh({ fileBytes: bytes, fileName: url.split(/[?#]/)[0] })
  try {
    await mesh.initialized
    if (!(mesh.numSplats > 0)) throw new Error('the splat has no points')
  } catch (e) {
    try { mesh.dispose() } catch { /* ignore */ }
    throw e
  }
  mesh.name = 'splat'
  mesh.layers.set(SPLAT_LAYER)
  mesh.raycast = () => {}
  return mesh
}
// Splat items in the scene (their splat drawn): the splat pass runs only while there are some.
const splatItemCount = () => { let n = 0; for (const r of items.values()) if (r.splat) n++; return n }
// Sorts the splats for the camera as it is now and waits for the sort (a capture reads the frame right after).
// The view offset (zoom, pan) doesn't change the order: it depends on the camera's position and direction only.
// Settled means a sort that started after the last generate has landed, for the splat set now in the scene: Spark shows
// a new set (`display`) only once its own sort is done. update() always regenerates for the camera and marks the set for
// sorting, but a sort can't start while the set is still changing (a piece just added): it stays dirty and the next
// update() takes it from there. So: update, wait for that sort, and repeat until one settles.
async function settleSplats(timeoutMs = 30000) {
  if (!spark || !splatItemCount()) return
  const t0 = performance.now()
  const left = () => performance.now() - t0 < timeoutMs
  const settled = () => !spark.sorting && !spark.sortDirty && spark.sortTimeoutId === undefined && spark.display === spark.current
  for (;;) {
    while (spark.sorting && left()) await sleep(10)
    let p
    camera.layers.set(SPLAT_LAYER) // Spark picks up the SplatMeshes the camera's layers see
    try { p = spark.update({ scene, camera }) } finally { camera.layers.set(0) }
    await p
    const t1 = performance.now()
    while (!settled() && left() && (spark.sorting || performance.now() - t1 < 300)) await sleep(20)
    if (settled() || !left()) break
  }
  if (!settled()) reportError('The splats were still sorting when the render was captured; try rendering again')
}

// A piece the library doesn't have any more (§2.8), or one without a GLB (v1 draws GLB only): a dashed box at its dims.
const MISSING_DIMS = { w: 50, d: 50, h: 50 }
const missingFill = new THREE.MeshBasicMaterial({ color: 0xe8735a, transparent: true, opacity: 0.14, depthWrite: false })
const missingEdge = new THREE.LineDashedMaterial({ color: 0xe8735a, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.95 })
function missingChild(dims) {
  const w = dims.w / 100, d = dims.d / 100, hgt = dims.h / 100
  const geo = new THREE.BoxGeometry(w, hgt, d).translate(0, hgt / 2, 0)
  const g = new THREE.Group()
  g.name = 'missing-item'
  const fillMesh = new THREE.Mesh(geo, missingFill)
  fillMesh.renderOrder = 3
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), missingEdge)
  edges.computeLineDistances()
  edges.raycast = () => {}
  g.add(fillMesh, edges)
  return { obj: g, box: new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, hgt, d / 2)) }
}
const validDims = (d) => d && typeof d === 'object' && ['w', 'd', 'h'].every((k) => isNum(d[k]) && d[k] > 0)

// A splat item without a GLB: a plain box at its dims stands in for it (never drawn, like the idol stand-in).
const boxMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
function boxChild(dims) {
  const w = dims.w / 100, d = dims.d / 100, hgt = dims.h / 100
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d).translate(0, hgt / 2, 0), boxMat)
  m.name = 'splat-box'
  return { obj: m, box: new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, hgt, d / 2)) }
}
async function glbChild(lib) {
  const t = await loadGlbTemplate(assetUrl(lib.assets.glb))
  return { obj: t.scene.clone(true), box: t.box.clone() }
}
// → { obj, box, splat, render }: obj is what picks, drags, bounds and shadows (the GLB, a box, or the missing box); with
// render 'splat', obj is invisible and `splat` (a SplatMesh) is what's drawn. A splat that won't load falls back to
// the GLB (for idol, its stand-in box), with a non-blocking error.
async function buildChild(lib) {
  const dims = validDims(lib.dims_cm) ? lib.dims_cm : MISSING_DIMS
  if (lib.missing) return { ...missingChild(dims), splat: null, render: 'glb' }
  if (pickRender(lib) === 'splat') {
    const [base, splat] = await Promise.allSettled([lib.assets?.glb ? glbChild(lib) : boxChild(dims), loadSplatMesh(lib)])
    if (base.status === 'rejected') {
      if (splat.status === 'fulfilled') { try { splat.value.dispose() } catch { /* ignore */ } }
      throw base.reason
    }
    if (splat.status === 'fulfilled') {
      base.value.obj.visible = false
      return { ...base.value, splat: splat.value, render: 'splat' }
    }
    reportError(`Could not load the splat of "${lib.name || lib.id}"; showing ${isStandIn(lib) ? 'its box' : 'its mesh'} instead`, splat.reason)
    if (!lib.assets?.glb) { disposeChild(base.value.obj); return { ...missingChild(dims), splat: null, render: 'glb' } }
    return { ...base.value, splat: null, render: 'glb' }
  }
  if (!lib.assets?.glb) return { ...missingChild(dims), splat: null, render: 'glb' }
  return { ...(await glbChild(lib)), splat: null, render: 'glb' }
}
// GLB clones share geometry and materials with the cached template; the boxes and the splat are the item's own.
function disposeChild(obj) {
  if (obj?.name === 'missing-item' || obj?.name === 'splat-box') obj.traverse((c) => c.geometry?.dispose())
}
function disposeBuilt(b) {
  disposeChild(b?.obj)
  if (b?.splat) { try { b.splat.dispose() } catch { /* ignore */ } }
}
// Puts a built child (buildChild) into the item's group, with its contact shadow; detachBuilt takes it out again.
function attachBuilt(rec, b) {
  rec.child = b.obj
  rec.localBox = b.box
  rec.splat = b.splat || null
  rec.render = b.render
  rec.noGlb = !rec.missing && !rec.lib.assets?.glb && rec.render !== 'splat'
  rec.group.add(b.obj)
  lights.prepare(b.obj)
  if (rec.splat) {
    rec.group.add(rec.splat)
    rec.caster = lights.caster(b.obj) // the hidden GLB or box casts the splat's floor shadow (§4.8)
    rec.group.add(rec.caster)
  }
  rec.shadow = makeContactShadow(rec)
  rec.group.add(rec.shadow)
  syncShadow(rec)
  splatEpoch++
}
function detachBuilt(rec) {
  splatEpoch++
  for (const o of [rec.child, rec.splat, rec.shadow, rec.caster]) if (o) rec.group.remove(o)
  if (rec.child) lights.forget(rec.child)
  rec.caster = null
  disposeBuilt({ obj: rec.child, splat: rec.splat })
  rec.child = null
  rec.splat = null
  rec.shadow = null
}
// What a placed copy depends on in its library entry: when this changes (Shows as, a rescale, a re-add), the copy is
// rebuilt in place (reloadLibrary).
const libSig = (lib) => JSON.stringify([lib?.default_render ?? null, lib?.assets ?? null, lib?.dims_cm ?? null, lib?.source?.created ?? null, lib?.fit ?? null])

// Where a new piece lands (§4.5): the ray through the middle of the visible photo, else through the middle of its lower
// third, when that floor point is 1–6 m from the camera; else 2.5 m straight ahead. Then the nearest free spot.
function landingSpot() {
  const v = visiblePhotoRect()
  let base = null
  for (const fy of [0.5, 5 / 6]) {
    const [px, py] = clientToPhoto(v.x + v.w / 2, v.y + v.h * fy)
    const p = photoToFloor(px, py)
    if (!p) continue
    const dist = Math.hypot(p[0], cam.height_m, p[2])
    if (dist >= 1 && dist <= 6) { base = p; break }
  }
  if (!base) base = [0, 0, -2.5]
  const taken = [...items.values()].map((r) => new THREE.Vector2(r.group.position.x, r.group.position.z))
  const step = 0.6
  for (let ring = 0; ring < 6; ring++) {
    for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const a = (k / Math.max(1, ring * 8)) * Math.PI * 2
      const p = new THREE.Vector2(base[0] + Math.cos(a) * ring * step, base[2] + Math.sin(a) * ring * step)
      if (p.y < -0.6 && taken.every((q) => q.distanceTo(p) > 0.45)) return [round(p.x, 6), 0, round(p.y, 6)]
    }
  }
  return [round(base[0], 6), 0, round(base[2], 6)]
}

function newUid(id) {
  uidCounter += 1
  return `${id}-${Date.now().toString(36)}${uidCounter.toString(36)}`
}

// opts: { position: [x, elevation, z], rotation_y_deg, uid, missing: dims_cm (a layout's piece the library doesn't
// have: a placeholder box at those dims, §2.8) }
async function addItemInternal(id, opts = {}) {
  opts = opts || {}
  let lib = library.find((i) => i.id === id)
  if (!lib && opts.missing && typeof id === 'string' && id) {
    lib = { id, name: id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), dims_cm: validDims(opts.missing) ? { ...opts.missing } : { ...MISSING_DIMS }, assets: {}, missing: true }
  }
  if (!lib) throw reportError(`Unknown library item "${id}"`)
  if (!sceneName) throw reportError('Open a scene first, then add furniture')
  const given = Array.isArray(opts.position) && opts.position.length >= 3 && isNum(opts.position[0]) && isNum(opts.position[2])
  const pos = given ? opts.position : landingSpot()
  const rot = isNum(opts.rotation_y_deg) ? opts.rotation_y_deg : 0
  const uid = typeof opts.uid === 'string' && opts.uid && !items.has(opts.uid) ? opts.uid : newUid(id)
  const gen = itemsGen
  const group = new THREE.Group()
  group.rotation.order = 'YXZ'
  group.position.set(pos[0], given && isNum(pos[1]) ? clampElev(pos[1]) : 0, pos[2])
  group.rotation.set(0, rot * DEG, 0)
  group.userData.uid = uid
  group.name = `item:${uid}`
  const rec = { uid, id, lib, sig: libSig(lib), group, child: null, splat: null, render: 'glb', localBox: null, rotationDeg: rot, shadow: null, missing: !!lib.missing, noGlb: false, build: 0 }
  try {
    attachBuilt(rec, await buildChild(lib)) // a splat item: its GLB and its splat have both loaded
  } catch (e) {
    throw reportError(`Could not load "${lib.name || id}"`, e)
  }
  if (gen !== itemsGen) {
    detachBuilt(rec)
    throw new Error(`adding "${id}" was cancelled because the items were cleared`)
  }
  scene.add(group)
  items.set(uid, rec)
  emit('items', { change: 'add', uid })
  return uid
}

// position[1] is the elevation (§2.10): the item's bottom above the floor, clamped to 0..4 m.
function moveItemInternal(uid, opts = {}) {
  const rec = items.get(uid)
  if (!rec) { reportError(`moveItem: no placed item "${uid}"`); return }
  opts = opts || {}
  if (Array.isArray(opts.position)) {
    if (isNum(opts.position[0])) rec.group.position.x = opts.position[0]
    if (isNum(opts.position[1])) rec.group.position.y = clampElev(opts.position[1])
    if (isNum(opts.position[2])) rec.group.position.z = opts.position[2]
  }
  if (isNum(opts.rotation_y_deg)) {
    rec.rotationDeg = opts.rotation_y_deg
    rec.group.rotation.set(0, opts.rotation_y_deg * DEG, 0)
  }
  rec.group.updateMatrixWorld(true)
  syncShadow(rec)
  emit('items', { change: 'move', uid })
}

function getElevation(uid) { const rec = items.get(uid); return rec ? rec.group.position.y : null }
function setElevation(uid, y) {
  const rec = items.get(uid)
  if (!rec || !isNum(y)) return
  moveItemInternal(uid, { position: [rec.group.position.x, round(clampElev(y), 6), rec.group.position.z] })
}
function nudgeElevation(uid, dy) { const y = getElevation(uid); if (y != null) setElevation(uid, Math.round((y + dy) * 1000) / 1000) }
function dropToFloor(uid) {
  const rec = items.get(uid)
  if (rec) moveItemInternal(uid, { position: [rec.group.position.x, 0, rec.group.position.z] })
}
// Several selected pieces turn as one group, around the middle of their positions (each turns by the same angle).
function rotateSelected(deg) {
  const recs = selRecs()
  if (!recs.length || !isNum(deg)) return
  const c = recs.length > 1 ? centreOf(recs) : null
  for (const rec of recs) {
    const p = rec.group.position
    const [x, z] = c ? turnAbout(c, p.x, p.z, deg) : [p.x, p.z]
    moveItemInternal(rec.uid, { position: [round(x, 6), p.y, round(z, 6)], rotation_y_deg: round(wrapDeg(rec.rotationDeg + deg), 6) })
  }
}
// Move every selected piece by [dx, dy, dz] m (dy: its elevation, clamped 0–4 m).
function nudgeSelected(d) {
  if (!Array.isArray(d)) return
  const [dx, dy, dz] = d.map((v) => (isNum(v) ? v : 0))
  for (const rec of selRecs()) {
    const p = rec.group.position
    moveItemInternal(rec.uid, { position: [round(p.x + dx, 6), Math.round(clampElev(p.y + dy) * 1000) / 1000, round(p.z + dz, 6)] })
  }
}
// A copy of each selected piece, 30 cm to the right (+X), same turn and height; the copies become the selection.
async function duplicateSelected({ offset = [0.3, 0, 0] } = {}) {
  const recs = selRecs()
  if (!recs.length) return []
  const uids = await Promise.all(recs.map((r) => {
    const p = r.group.position
    return addItemInternal(r.id, { position: [p.x + offset[0], p.y + offset[1], p.z + offset[2]], rotation_y_deg: r.rotationDeg, missing: r.missing ? { ...r.lib.dims_cm } : undefined })
  }))
  selectMany(uids)
  return uids
}
function removeItemInternal(uid) {
  const rec = items.get(uid)
  if (!rec) return
  if (selection.has(uid)) {
    selection.delete(uid)
    if (selected === uid) selected = [...selection].at(-1) ?? null
    if (drag.mode && drag.uid === uid) endItemDrag()
    emit('selection', selectionDetail())
  }
  scene.remove(rec.group)
  rec.build++ // a rebuild in flight (reloadLibrary) drops its result
  detachBuilt(rec)
  items.delete(uid)
  emit('items', { change: 'remove', uid })
}
function clearItemsInternal() {
  itemsGen += 1
  select(null)
  for (const uid of [...items.keys()]) removeItemInternal(uid)
}
function worldBounds(rec) {
  rec.group.updateMatrixWorld(true)
  return rec.localBox.clone().applyMatrix4(rec.group.matrixWorld)
}
function itemInfo(r) {
  return {
    uid: r.uid, id: r.id, name: r.lib.name || r.id, lib: r.lib, render: r.render,
    position: [r.group.position.x, r.group.position.y, r.group.position.z], rotation_y_deg: r.rotationDeg,
    missing: !!r.missing, noGlb: !!r.noGlb,
  }
}
// The 8 corners of the item's box in world space (its own frame, turned with it).
function boxCorners(rec) {
  rec.group.updateMatrixWorld(true)
  const { min, max } = rec.localBox
  const out = []
  for (const y of [min.y, max.y]) for (const [x, z] of [[min.x, min.z], [max.x, min.z], [max.x, max.z], [min.x, max.z]]) out.push(new THREE.Vector3(x, y, z).applyMatrix4(rec.group.matrixWorld))
  return out
}
// §4.6 getScreenRect: the item's projected bounds in photo px (its box's 8 corners; corners behind the camera ignored).
function getScreenRect(uid) {
  const rec = items.get(uid)
  if (!rec?.localBox) return null
  const pts = boxCorners(rec).map((p) => projectPhoto(p)).filter((p) => p[2] > 1e-4)
  if (!pts.length) return null
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

// --- selection: drag the item itself on the floor, a grip on its footprint rotates it (contract §2.3) -----------------
// The selection: a set of placed pieces; `selected` is its primary (the one picked last), which the label, the grip and
// the height controls follow. One piece selected is the common case and behaves exactly as before.
let selected = null
const selection = new Set()
let snap = false // Shift on desktop: lift drags, 15° grip
// group: [{ uid, pos: Vector3, rot }] the selection as it was when the drag began; centre: what a group turns around
const drag = { mode: null, uid: null, off: new THREE.Vector3(), a0: 0, rot0: 0, plane: new THREE.Plane(), group: [], centre: null }
const selectionDetail = () => ({ uid: selected, uids: [...selection] })
const selRecs = () => [...selection].map((u) => items.get(u)).filter(Boolean)
const centreOf = (recs) => recs.reduce((a, r) => ({ x: a.x + r.group.position.x / recs.length, z: a.z + r.group.position.z / recs.length }), { x: 0, z: 0 })
// (x, z) turned by `deg` about the centre c, counterclockwise seen from above (as rotation_y_deg)
function turnAbout(c, x, z, deg) {
  const t = deg * DEG, cs = Math.cos(t), sn = Math.sin(t), dx = x - c.x, dz = z - c.z
  return [c.x + dx * cs + dz * sn, c.z - dx * sn + dz * cs]
}
function select(uid, { toggle = false, add = false } = {}) {
  const ok = !!uid && items.has(uid)
  if (toggle || add) {
    if (!ok) return
    if (toggle && selection.has(uid)) {
      selection.delete(uid)
      if (selected === uid) selected = [...selection].at(-1) ?? null
    } else {
      selection.delete(uid) // re-added last: it becomes the primary
      selection.add(uid)
      selected = uid
    }
  } else {
    selection.clear()
    if (ok) selection.add(uid)
    selected = ok ? uid : null
  }
  if (drag.mode && !selection.has(drag.uid)) endItemDrag()
  emit('selection', selectionDetail())
}
function selectMany(uids) {
  selection.clear()
  for (const u of uids || []) if (items.has(u)) { selection.delete(u); selection.add(u) }
  selected = [...selection].at(-1) ?? null
  if (drag.mode && !selection.has(drag.uid)) endItemDrag()
  emit('selection', selectionDetail())
}
function selectAll() { selectMany([...items.keys()]) }
function setSnap(on) { snap = !!on }
// Footprint corners [front-left, front-right, back-right, back-left] on the floor (front faces +Z), centre, box, height.
function getFootprint(uid) {
  const rec = items.get(uid)
  if (!rec?.localBox) return null
  rec.group.updateMatrixWorld(true)
  const { min, max } = rec.localBox
  const m = rec.group.matrixWorld
  const pt = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m)
  const floor = [[min.x, max.z], [max.x, max.z], [max.x, min.z], [min.x, min.z]].map(([x, z]) => pt(x, 0, z))
  const box = boxCorners(rec)
  const center = floor.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(0.25)
  return { corners: floor.map((v) => v.toArray()), center: center.toArray(), box: box.map((v) => v.toArray()), height: max.y }
}
function hitItemAt(uid, clientX, clientY, pad = 16) {
  const f = getFootprint(uid)
  if (!f) return false
  const pts = f.box.map((p) => worldToScreen(p))
  if (pts.some((p) => !p.visible)) { setRay(clientX, clientY); return hitItems()?.uid === uid }
  const hull = convexHull(pts)
  return pointInHull(hull, clientX, clientY) || distToHull(hull, clientX, clientY) <= pad
}
function convexHull(ps) {
  const p = ps.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = [], hi = []
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q) }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q) }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}
function pointInHull(h, x, y) {
  if (h.length < 3) return false
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length]
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false
  }
  return true
}
function distToHull(h, x, y) {
  let best = Infinity
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length]
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return best
}
// The point of a placed piece under a client point: where the ray first meets its mesh, else its box, else null.
function grabPointOn(rec, clientX, clientY) {
  setRay(clientX, clientY)
  const hit = raycaster.intersectObject(rec.group, true).find((h) => h.object.name !== 'contact-shadow')
  if (hit) return hit.point.clone()
  return raycaster.ray.intersectBox(worldBounds(rec), new THREE.Vector3())
}
// The height of the horizontal plane a move-drag slides on: the grabbed point's own height, so that point stays under
// the pointer (a plane at the floor would amplify the motion with depth when the seat or the back is grabbed). Kept
// at least 15 cm from the eye height (where that plane is seen edge-on) and within the piece.
function dragHeight(rec, clientX, clientY) {
  const b = worldBounds(rec)
  const p = grabPointOn(rec, clientX, clientY)
  let y = p ? p.y : (b.min.y + b.max.y) / 2 // grabbed beside the piece (the touch pad): its middle
  y = Math.max(b.min.y, Math.min(b.max.y, y))
  const eye = cam.height_m
  if (Math.abs(y - eye) < 0.15) y = eye - 0.15 >= b.min.y ? eye - 0.15 : Math.min(b.max.y, eye + 0.15)
  return y
}
// Drag to move: the grabbed point of the piece stays under the finger: the piece slides on the horizontal plane
// through that point (its elevation doesn't change), so farther away it shrinks with perspective, closer it grows.
// With `lift` (Shift) it moves up and down only.
function beginItemDrag(uid, clientX, clientY, { lift = snap } = {}) {
  const rec = items.get(uid)
  if (!rec) return false
  let mode = 'move'
  const plane = new THREE.Plane()
  if (lift) {
    mode = 'lift'
    const n = new THREE.Vector3(-rec.group.position.x, 0, -rec.group.position.z) // faces the camera (at x = z = 0)
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1)
    plane.setFromNormalAndCoplanarPoint(n.normalize(), rec.group.position)
  } else plane.set(new THREE.Vector3(0, 1, 0), -dragHeight(rec, clientX, clientY))
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (!selection.has(uid)) select(uid)
  else if (selected !== uid) select(uid, { add: true }) // grabbing one piece of a group: the group moves, it leads
  Object.assign(drag, { mode, uid, off: rec.group.position.clone().sub(p), group: groupStart(), centre: null })
  drag.plane.copy(plane)
  emit('drag', { mode, uid, phase: 'start' })
  return true
}
const groupStart = () => selRecs().map((r) => ({ uid: r.uid, pos: r.group.position.clone(), rot: r.rotationDeg }))
function beginRotateDrag(uid, clientX, clientY) {
  const rec = items.get(uid)
  if (!rec) return false
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -rec.group.position.y)
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (!selection.has(uid)) select(uid)
  const group = groupStart()
  const c = group.length > 1 ? centreOf(selRecs()) : { x: rec.group.position.x, z: rec.group.position.z }
  Object.assign(drag, { mode: 'rotate', uid, a0: Math.atan2(p.x - c.x, p.z - c.z), rot0: rec.rotationDeg, group, centre: c })
  drag.plane.copy(plane)
  emit('drag', { mode: 'rotate', uid, phase: 'start' })
  return true
}
function dragTo(clientX, clientY, { snapTo = false } = {}) {
  const rec = drag.mode && items.get(drag.uid)
  if (!rec) return
  const p = planePointAt(drag.plane, clientX, clientY)
  if (!p) return
  const lead = drag.group.find((s) => s.uid === drag.uid)
  const others = drag.group.filter((s) => s !== lead && items.has(s.uid))
  if (!lead) return
  if (drag.mode === 'move') {
    const x = round(p.x + drag.off.x, 6), z = round(p.z + drag.off.z, 6)
    const dx = x - lead.pos.x, dz = z - lead.pos.z
    moveItemInternal(drag.uid, { position: [x, rec.group.position.y, z] })
    for (const s of others) moveItemInternal(s.uid, { position: [round(s.pos.x + dx, 6), s.pos.y, round(s.pos.z + dz, 6)] })
  } else if (drag.mode === 'lift') {
    let y = clampElev(p.y + drag.off.y)
    if (snap) y = Math.round(y / 0.01) * 0.01
    const dy = y - lead.pos.y
    moveItemInternal(drag.uid, { position: [lead.pos.x, round(y, 6), lead.pos.z] })
    for (const s of others) moveItemInternal(s.uid, { position: [s.pos.x, round(clampElev(s.pos.y + dy), 6), s.pos.z] })
  } else {
    const c = drag.centre
    let deg = drag.rot0 + (Math.atan2(p.x - c.x, p.z - c.z) - drag.a0) / DEG
    if (snapTo || snap) deg = Math.round(deg / 15) * 15
    const d = deg - drag.rot0
    for (const s of [lead, ...others]) {
      const [x, z] = others.length ? turnAbout(c, s.pos.x, s.pos.z, d) : [s.pos.x, s.pos.z]
      moveItemInternal(s.uid, { position: [round(x, 6), s.pos.y, round(z, 6)], rotation_y_deg: round(wrapDeg(s.rot + d), 6) })
    }
  }
}
function endItemDrag() {
  if (!drag.mode) return
  const d = { mode: drag.mode, uid: drag.uid }
  drag.mode = null
  drag.uid = null
  drag.group = []
  drag.centre = null
  emit('drag', { ...d, phase: 'end' })
}
function removeItemWithUndo(uid) {
  const rec = items.get(uid)
  if (!rec) return null
  const snapItem = { uid, id: rec.id, name: rec.lib.name || rec.id, position: rec.group.position.toArray(), rotation_y_deg: rec.rotationDeg, missing: rec.missing ? { ...rec.lib.dims_cm } : undefined }
  removeItemInternal(uid)
  return snapItem
}
async function restoreItem(s) {
  const uid = await addItemInternal(s.id, { uid: s.uid, position: s.position, rotation_y_deg: s.rotation_y_deg, missing: s.missing })
  select(uid)
  return uid
}
// Undo of removing several pieces: all of them back, selected together.
async function restoreItems(snaps) {
  const uids = await Promise.all((snaps || []).map((s) => addItemInternal(s.id, { uid: s.uid, position: s.position, rotation_y_deg: s.rotation_y_deg, missing: s.missing })))
  selectMany(uids)
  return uids
}

// --- the ruler (Adjust floor): two taps on the floor, the distance between them -------------------------------------
const ruler = { active: false, points: [] }
function getRuler() {
  const [a, b] = ruler.points
  return { active: ruler.active, points: ruler.points.map((p) => p.slice()), meters: a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : null }
}
function setRulerActive(on) {
  ruler.active = !!on
  if (!on) ruler.points = []
  else select(null)
  emit('ruler', getRuler())
}
function clearRuler() { ruler.points = []; emit('ruler', getRuler()) }
// The ruler measured a known length (a rug, a tile, a sofa's width): scale the camera height so it reads `meters`.
// Every floor point under a pixel scales with the height (the angles don't change), so this fixes the scene's scale,
// and with it the size every piece is drawn at, from one length the user knows (MoGe's metric scale is often off by
// 5–15 %). The ruler's points move with the floor and keep their place in the photo.
function setRulerTrueLength(meters) {
  const r = getRuler()
  if (!isNum(meters) || meters <= 0 || !r.meters || r.meters < 1e-3) return false
  const k = meters / r.meters
  const [lo, hi] = CAMERA_RANGE.height_m
  const h = Math.min(hi, Math.max(lo, cam.height_m * k))
  const kk = h / cam.height_m
  ruler.points = ruler.points.map((p) => [p[0] * kk, 0, p[2] * kk])
  setCamera({ height_m: h })
  emit('ruler', getRuler())
  return Math.abs(kk - k) < 1e-9
}
// Move ruler point i to the floor under a client point (after a camera change the points stay in the photo's place).
function setRulerPointAt(i, clientX, clientY) {
  const p = photoToFloor(...clientToPhoto(clientX, clientY))
  if (!p || !ruler.points[i]) return false
  ruler.points[i] = p
  emit('ruler', getRuler())
  return true
}

// The placed piece under a client point (its mesh, not its shadow), or null.
function itemAt(clientX, clientY) {
  if (!sceneName) return null
  setRay(clientX, clientY)
  return hitItems()?.uid ?? null
}
// A click/tap at a client point: a ruler point, or (de)selecting an item.
function tap(clientX, clientY) {
  if (!sceneName) return
  if (ruler.active) {
    const p = photoToFloor(...clientToPhoto(clientX, clientY))
    if (!p) { toast('That point is above the horizon: tap the floor.', 'info', 3000); return }
    if (ruler.points.length >= 2) ruler.points = []
    ruler.points.push(p)
    emit('ruler', getRuler())
    return
  }
  setRay(clientX, clientY)
  const hit = hitItems()
  select(hit ? hit.uid : null)
}

// --- scenes (contract §4.4) ------------------------------------------------------------------------------------------
async function apiJson(url, opts) {
  let res
  try { res = await fetch(url, withMidstudy(opts)) } catch (e) { const err = new Error(`could not reach ${url} (${e.message})`); err.offline = true; throw err }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) { const err = new Error(data?.error || `${url} returned HTTP ${res.status}`); err.status = res.status; err.body = data; throw err }
  return data
}
const sceneUrl = (name) => `/api/scenes/${encodeURIComponent(name)}`
let sceneName = null
let sceneData = null       // GET /api/scenes/<name> as opened
let savedScene = null      // { title, camera, camera_source, look } as last read or saved
let cameraSource = 'default'
let look = lookFrom({})
let lightingData = null    // lighting.json (GET /api/scenes/<name> `lighting`), or null: the v1 lights
let lightingStatus = { status: 'missing', error: null } // §4.8 backfill: done | missing | pending | running | none | failed
let lightingToken = 0
let adjustFloor = false
let occlusion = true
let floorNote = null
let scenesList = []
let scenesTrash = []  // [{name, title, deleted}] deleted scenes the server keeps (scenes/.trash)
let sceneToken = 0
const sceneLoad = { loading: false, phase: null, name: null, scene: null }
const dirty = { scene: false, layout: false }
let quietItems = 0
function setDirty(next) {
  if (next.scene === dirty.scene && next.layout === dirty.layout) return
  Object.assign(dirty, next)
  emit('dirty', { ...dirty })
}
const sceneSig = () => JSON.stringify([cam]) // the Look saves itself (saveLookSoon), so only the camera waits for Save scene
let sceneBaseline = ''
const touchScene = () => setDirty({ ...dirty, scene: !!sceneName && sceneSig() !== sceneBaseline })
// The layout is dirty when the placed pieces differ from the ones last saved or loaded (not merely when something
// happened: Remove then Undo puts back the same layout). Pieces compare by library id, position (to 0.1 mm) and turn.
const layoutSig = () => JSON.stringify([...items.values()].map((r) => [r.id, ...[r.group.position.x, r.group.position.y, r.group.position.z].map((v) => Math.round(v * 1e4)), Math.round(wrapDeg(r.rotationDeg) * 100)]).sort())
let layoutBaseline = '[]'
const markLayoutClean = () => { layoutBaseline = layoutSig(); setDirty({ ...dirty, layout: false }) }
events.addEventListener('items', () => { if (!quietItems) setDirty({ ...dirty, layout: layoutSig() !== layoutBaseline }) })
async function quietly(fn) { quietItems++; try { return await fn() } finally { quietItems-- } }

async function listScenesInternal() {
  let data
  try { data = await apiJson('/api/scenes') } catch (e) { throw reportError('Could not list the scenes', e) }
  scenesList = Array.isArray(data?.scenes) ? data.scenes : []
  scenesTrash = Array.isArray(data?.trash) ? data.trash : []
  emit('scenes', { scenes: scenesList.slice() })
  return scenesList.slice()
}
async function getSceneInternal(name) {
  return apiJson(sceneUrl(name))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Resolves with the scene when its calibration is done or failed (§4.6).
async function waitForScene(name, { every = 500, onTick = null } = {}) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Scene names are slugs like "scene-20261104-201500" (got "${name}")`)
  const t0 = performance.now()
  for (;;) {
    let s
    try { s = await getSceneInternal(name) } catch (e) {
      if (e.status === 404) throw reportError(`There's no scene "${name}"`, e)
      if (performance.now() - t0 > 15 * 60e3) throw reportError(`Gave up waiting for "${name}"`, e)
      await sleep(2000)
      continue
    }
    onTick?.(s)
    if (s.calib_status === 'done' || s.calib_status === 'failed') return s
    await sleep(every)
  }
}

const b64json = (o) => { const bytes = new TextEncoder().encode(JSON.stringify(o)); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
// POST /api/scenes with the photo; resolves when the upload is accepted (202) with { job, scene }.
async function createScene(file, meta = {}) {
  if (!(file instanceof Blob)) throw reportError('createScene needs a File')
  const title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : null
  const name = (file.name || 'photo.jpg').replace(/[^\x20-\x7e]/g, '_')
  let res
  try {
    res = await apiJson('/api/scenes', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'X-Midstudy-Filename': name, ...(title ? { 'X-Midstudy-Meta': b64json({ title }) } : {}) } })
  } catch (e) {
    throw reportError(e.status === 413 ? 'That photo is too big (25 MB at most)' : e.status === 400 ? 'Not a scene' : 'Could not upload the photo', e)
  }
  quiet(listScenesInternal())
  return res
}

async function loadImage(url) {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try { await img.decode() } catch { throw new Error(`could not load ${url.split('?')[0]}`) }
  return img
}

// depth.png: 16-bit grayscale PNG, mm along the view axis (§4.2). Browsers decode PNGs to 8 bits, so it's decoded here.
async function loadDepth(url) {
  const bytes = await fetchBytes(url)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!sig.every((v, i) => bytes[i] === v)) throw new Error('depth.png is not a PNG')
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  for (let o = 8; o + 8 <= bytes.length;) {
    const n = dv.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7])
    const data = bytes.subarray(o + 8, o + 8 + n)
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + n
  }
  if (!w || !h || colorType !== 0 || interlace || (bitDepth !== 16 && bitDepth !== 8)) throw new Error(`depth.png must be a 16-bit grayscale PNG (got colour type ${colorType}, ${bitDepth} bits)`)
  const zipped = new Blob(idat)
  const raw = new Uint8Array(await new Response(zipped.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
  const bpp = bitDepth / 8
  const stride = w * bpp
  const out = new Float32Array(w * h)
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1)
    const ft = raw[off]
    for (let i = 0; i < stride; i++) {
      const x = raw[off + 1 + i]
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      let v
      if (ft === 0) v = x
      else if (ft === 1) v = x + a
      else if (ft === 2) v = x + b
      else if (ft === 3) v = x + ((a + b) >> 1)
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) }
      cur[i] = v & 255
    }
    for (let x = 0; x < w; x++) out[y * w + x] = (bpp === 2 ? (cur[2 * x] << 8) | cur[2 * x + 1] : cur[x]) / 1000
    const t = prev; prev = cur; cur = t
  }
  return { w, h, data: out }
}

function setPhoto(img, depth) {
  photo.texture?.dispose()
  photo.depthTexture?.dispose()
  photo.image = img
  photo.w = img.naturalWidth
  photo.h = img.naturalHeight
  const t = new THREE.Texture(img)
  t.flipY = false
  t.colorSpace = THREE.NoColorSpace
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.needsUpdate = true
  photo.texture = t
  photo.has = true
  photoMat.uniforms.tPhoto.value = t
  photoMat.uniforms.uHas.value = 1
  photo.depth = depth
  if (depth) {
    const dt = new THREE.DataTexture(depth.data, depth.w, depth.h, THREE.RedFormat, THREE.FloatType)
    dt.flipY = false
    dt.minFilter = dt.magFilter = THREE.NearestFilter
    dt.generateMipmaps = false
    dt.needsUpdate = true
    photo.depthTexture = dt
    depthMat.uniforms.tDepth.value = dt
  } else {
    photo.depthTexture = null
    depthMat.uniforms.tDepth.value = null
  }
  syncOcclusion()
}
function clearPhoto() {
  photo.texture?.dispose()
  photo.depthTexture?.dispose()
  Object.assign(photo, { has: false, image: null, texture: null, depth: null, depthTexture: null })
  photoMat.uniforms.tPhoto.value = null
  photoMat.uniforms.uHas.value = 0
  depthMat.uniforms.tDepth.value = null
  syncOcclusion()
}
const syncOcclusion = () => { depthPass.visible = occlusion && !!photo.depthTexture }

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))
function floorNoteFor(data) {
  const c = data?.calib
  if (!c) return data?.calib_status === 'failed' ? `Calibration failed${data.calib_error ? ` (${data.calib_error})` : ''}: set the floor by hand.` : 'No calibration yet: set the floor by hand.'
  if (c.floor && c.floor.found === false) return "Check the floor: the photo's floor wasn't found."
  if (c.source !== 'moge-2' && c.source !== 'truth') return `Check the floor: the camera is a guess (${c.source === 'exif' ? 'from the lens' : 'a default'}).`
  return null
}

// Opens a scene by name: its photo, depth and camera, and its layouts and renders. Placed items are cleared. A scene
// that's still calibrating opens when it's done.
async function openScene(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Scene names are slugs like "scene-20261104-201500" (got "${name}")`)
  flushLook()
  const token = ++sceneToken
  Object.assign(sceneLoad, { loading: true, phase: 'photo', name, scene: null })
  emit('scene', { phase: 'loading', name })
  let data
  try {
    data = await getSceneInternal(name)
    if (data.calib_status === 'pending' || data.calib_status === 'running') {
      Object.assign(sceneLoad, { phase: 'calibrating', scene: data })
      emit('scene', { phase: 'calibrating', name })
      await waitForScene(name, { onTick: (s) => { if (token === sceneToken) { sceneLoad.scene = s; emit('scene', { phase: 'calibrating', name }) } } })
      if (token !== sceneToken) return
      data = await getSceneInternal(name)
    }
    if (token !== sceneToken) return
    if (!data.photo_url) throw new Error(data.calib_error || 'the scene has no photo')
    Object.assign(sceneLoad, { phase: 'photo', scene: data })
    const [img, depth] = await Promise.all([
      loadImage(data.photo_url),
      data.depth_url ? loadDepth(data.depth_url).catch((e) => { reportError('Could not read depth.png; occlusion is off', e); return null }) : null,
    ])
    if (token !== sceneToken) return
    await quietly(() => clearItemsInternal())
    clearRuler()
    ruler.active = false
    setPhoto(img, depth)
    sceneName = name
    sceneData = data
    cam = clampCamera(data.camera)
    cameraSource = data.camera_source || 'default'
    look = lookFrom(data.look)
    lightingToken++
    setLightingData(data)
    savedScene = { title: data.title ?? null, camera: { ...cam }, camera_source: cameraSource, look: { ...look } }
    sceneBaseline = sceneSig()
    occlusion = !!depth
    syncOcclusion()
    floorNote = floorNoteFor(data)
    adjustFloor = !!floorNote
    grid.visible = true
    view.zoom = 1
    view.cx = photo.w / 2
    view.cy = photo.h / 2
    applyCamera()
    applyLook()
    setLayoutName('')
    layoutNames = []
    layoutDetails = []
    renders = []
    layoutBaseline = '[]'
    setDirty({ scene: false, layout: false })
    store.set(LAST_SCENE_KEY, name)
    syncUrl(name)
    Object.assign(sceneLoad, { loading: false, phase: null, name: null, scene: null })
    emit('camera', { camera: { ...cam }, source: cameraSource })
    emit('adjust', { on: adjustFloor, note: floorNote })
    emit('occlusion', { on: occlusion })
    emit('grid', { visible: true })
    emitView()
    emit('scene', { phase: 'opened', name })
    if (lightingStatus.status === 'missing' && data.calib_status === 'done') quiet(inferLighting())
    // The scene comes back with its layout (layoutToOpen: what this device had open, or the one saved last on any
    // device), so the furniture isn't lost on a reload or on the other device; then the renders list. The library
    // must be read first, or the pieces would load as missing.
    await Promise.all([refreshLayouts(), libraryLoading.catch(() => {})])
    if (token !== sceneToken) return
    const pick = layoutToOpen(name, layoutDetails)
    if (pick) {
      try { await loadLayoutInternal(pick) } catch { /* reported */ }
      if (token !== sceneToken) return
    }
    quiet(listRendersInternal())
    wake(1500)
    await nextFrame()
    await nextFrame()
    if (!data.thumb_url) quiet(saveThumbnail())
  } catch (e) {
    if (token !== sceneToken) return
    Object.assign(sceneLoad, { loading: false, phase: null, name: null, scene: null })
    emit('scene', { phase: 'failed', name })
    throw reportError(e.status === 404 ? `There's no scene "${name}"` : `Could not open the scene "${name}"`, e)
  }
}

function syncUrl(name) {
  try {
    const u = new URL(location.href)
    if (name) u.searchParams.set('scene', name); else u.searchParams.delete('scene')
    history.replaceState(history.state, '', u)
  } catch { /* ignore */ }
}

function closeScene() {
  flushLook()
  sceneToken++
  Object.assign(sceneLoad, { loading: false, phase: null, name: null, scene: null })
  quiet(quietly(() => clearItemsInternal()))
  clearPhoto()
  sceneName = null
  sceneData = null
  savedScene = null
  lightingToken++
  look = lookFrom({})
  setLightingData(null)
  applyLook()
  adjustFloor = false
  floorNote = null
  ruler.active = false
  ruler.points = []
  grid.visible = false
  layoutNames = []
  layoutDetails = []
  renders = []
  setLayoutName('')
  layoutBaseline = '[]'
  setDirty({ scene: false, layout: false })
  syncUrl(null)
  emit('adjust', { on: false })
  emit('scene', { phase: 'closed', name: null })
}

async function deleteScene(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Scene names are slugs (got "${name}")`)
  try { await apiJson(sceneUrl(name), { method: 'DELETE' }) } catch (e) { throw reportError(`Could not delete the scene "${name}"`, e) }
  if (store.get(LAST_SCENE_KEY) === name) store.set(LAST_SCENE_KEY, null)
  if (name === sceneName) closeScene()
  emit('scene', { phase: 'deleted', name })
  quiet(listScenesInternal())
}

// Undo of a delete: POST /api/scenes/<name>/restore puts the scene (and its layouts) back; its renders show again.
async function restoreScene(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Scene names are slugs (got "${name}")`)
  try { await apiJson(`${sceneUrl(name)}/restore`, { method: 'POST' }) } catch (e) {
    throw reportError(e.status === 409 ? `Can't restore "${name}": a scene by that name exists again` : `Could not restore the scene "${name}"`, e)
  }
  emit('scene', { phase: 'restored', name })
  await listScenesInternal()
}

async function renameScene(name, title) {
  const t = typeof title === 'string' && title.trim() ? title.trim() : null
  try { await apiJson(sceneUrl(name), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) }) } catch (e) {
    throw reportError(`Could not rename the scene`, e)
  }
  if (name === sceneName) {
    if (sceneData) sceneData.title = t
    if (savedScene) savedScene.title = t
  }
  emit('scene', { phase: 'title', name })
  quiet(listScenesInternal())
}

// PUT /api/scenes/<name>: the camera (with its source), the Look and the title.
async function saveScene() {
  if (!sceneName) throw reportError('No scene is open')
  const body = { title: sceneData?.title ?? null, camera: { ...cam }, camera_source: cameraSource, look: lookToSave() }
  let res
  try { res = await apiJson(sceneUrl(sceneName), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } catch (e) {
    throw reportError(e.status ? 'Could not save the scene' : "Not saved: the server isn't answering", e)
  }
  if (res && typeof res === 'object') {
    sceneData = { ...sceneData, ...res, lighting: sceneData?.lighting ?? null, lighting_status: sceneData?.lighting_status, lighting_error: sceneData?.lighting_error }
    cam = clampCamera(res.camera || cam)
    cameraSource = res.camera_source || cameraSource
  }
  savedScene = { title: sceneData?.title ?? null, camera: { ...cam }, camera_source: cameraSource, look: { ...look } }
  sceneBaseline = sceneSig()
  touchScene()
  emit('scene', { phase: 'saved', name: sceneName })
  quiet(listScenesInternal())
}

// A small JPEG of the photo for the Scenes page: PUT /api/scenes/<name>/thumb.
async function saveThumbnail() {
  const name = sceneName
  if (!name || !photo.image) return null
  const k = Math.min(1, 480 / Math.max(photo.w, photo.h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(photo.w * k))
  c.height = Math.max(1, Math.round(photo.h * k))
  c.getContext('2d').drawImage(photo.image, 0, 0, c.width, c.height)
  let res
  try {
    res = await apiJson(`${sceneUrl(name)}/thumb`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.82) }) })
  } catch (e) { throw reportError('Could not save the scene thumbnail', e) }
  const entry = scenesList.find((s) => s.name === name)
  if (entry) entry.thumb_url = res?.thumb_url || entry.thumb_url
  emit('scenes', { scenes: scenesList.slice() })
  return res?.thumb_url || null
}

// Calibrate again (POST …/calibrate): waits for the job, then takes the new calibration (and depth) without touching
// the placed furniture. The server replaces the camera only when it wasn't set by hand.
async function recalibrate() {
  const name = sceneName
  if (!name) throw reportError('No scene is open')
  try { await apiJson(`${sceneUrl(name)}/calibrate`, { method: 'POST' }) } catch (e) { throw reportError(e.status === 409 ? 'This scene is already calibrating' : 'Could not start the calibration', e) }
  emit('scene', { phase: 'recalibrating', name })
  const done = await waitForScene(name)
  if (name !== sceneName) return done
  const data = await getSceneInternal(name)
  const depth = data.depth_url ? await loadDepth(data.depth_url).catch(() => null) : null
  if (name !== sceneName) return data
  setPhoto(photo.image, depth)
  sceneData = data
  lightingToken++
  setLightingData(data)
  applyLook()
  floorNote = floorNoteFor(data)
  if (!dirty.scene && cameraSource !== 'manual') {
    cam = clampCamera(data.camera)
    cameraSource = data.camera_source || cameraSource
    savedScene = { ...savedScene, camera: { ...cam }, camera_source: cameraSource }
    sceneBaseline = sceneSig()
    applyCamera()
    emit('camera', { camera: { ...cam }, source: cameraSource })
  }
  if (!occlusion && depth) setOcclusion(true)
  emit('scene', { phase: data.calib_status === 'failed' ? 'recalibrate-failed' : 'recalibrated', name })
  emit('adjust', { on: adjustFloor, note: floorNote })
  if (data.calib_status === 'failed') toast(`Calibration failed: ${data.calib_error || 'see the server log'}`, 'error')
  return data
}

// --- the camera: Adjust floor (§4.5) ----------------------------------------------------------------------------------
function setCamera(partial = {}) {
  if (!partial || typeof partial !== 'object') return
  const next = clampCamera({ ...cam, ...Object.fromEntries(Object.entries(partial).filter(([k, v]) => k in CAMERA_RANGE && isNum(v))) }, cam)
  if (sameCamera(next, cam)) return
  cam = next
  cameraSource = savedScene && sameCamera(cam, savedScene.camera) ? savedScene.camera_source : 'manual'
  applyCamera()
  touchScene()
  emit('camera', { camera: { ...cam }, source: cameraSource })
}
function resetCamera() {
  const c = sceneData?.calib?.camera
  cam = clampCamera(c || DEFAULT_CAMERA)
  cameraSource = c ? 'auto' : 'default'
  applyCamera()
  touchScene()
  emit('camera', { camera: { ...cam }, source: cameraSource })
}
function setAdjustFloor(on) {
  adjustFloor = !!on && !!sceneName
  if (adjustFloor) select(null)
  else { ruler.active = false; ruler.points = [] }
  emit('adjust', { on: adjustFloor, note: floorNote })
  emit('ruler', getRuler())
}
function setOcclusion(on) {
  occlusion = !!on
  syncOcclusion()
  emit('occlusion', { on: occlusion })
}
function setGridVisible(on) {
  grid.visible = !!on
  emit('grid', { visible: grid.visible })
}

// --- layouts (per scene, contract §2.7) --------------------------------------------------------------------------------
let layoutNames = []
let layoutDetails = []
let layoutName = ''
let layoutTitle = ''  // the name as typed ("Phone A"), shown instead of the slug
function setLayoutName(name, title = null) {
  layoutName = String(name ?? '')
  layoutTitle = layoutName && typeof title === 'string' ? title.trim() : ''
}
// "two-chairs" → "Two chairs"; the stored title when the layout has one ("Phone A").
export const prettyLayout = (name) => { const s = String(name || '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }
function layoutDisplayName(name) {
  if (!name) return ''
  if (name === layoutName && layoutTitle) return layoutTitle
  const d = layoutDetails.find((x) => x.name === name)
  return (d && typeof d.title === 'string' && d.title.trim()) || prettyLayout(name)
}
// Which layout a scene opens with (§4.5). This device remembers the layout it last had open in each scene, with when
// it chose it ({name, at}: saved, loaded, or none after deleting it). The scene reopens with that layout, unless a
// layout was saved after that moment on another device (the server's `updated`), or this device has never had the
// scene open: then it opens with the most recently saved layout. So a reload keeps what this device had, and the
// phone opens a scene with the layout the desktop just saved, and the other way round.
const layoutKey = (scene) => `midstudy.layout.${scene}`
function rememberLayout(name, at = null) {
  if (!sceneName) return
  const t = Date.parse(at || '') || Date.now()
  store.set(layoutKey(sceneName), JSON.stringify({ name: name || null, at: new Date(t).toISOString() }))
}
function recalledLayout(scene) {
  const raw = store.get(layoutKey(scene))
  if (!raw) return null
  if (SLUG.test(raw)) return { name: raw, at: 0 } // the plain name stored before round 2: any later save wins
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object') return { name: typeof v.name === 'string' && SLUG.test(v.name) ? v.name : null, at: Date.parse(v.at) || 0 }
  } catch { /* unreadable: as if nothing were remembered */ }
  return null
}
function layoutToOpen(scene, details) {
  const saved = (d) => Date.parse(d?.updated || '') || 0
  const newest = details.reduce((a, d) => (!a || saved(d) > saved(a) ? d : a), null)
  const mine = recalledLayout(scene)
  if (mine && (!newest || mine.at >= saved(newest))) {
    if (!mine.name) return null                                      // this device closed it (deleted it) last
    if (details.some((d) => d.name === mine.name)) return mine.name
  }
  return newest ? newest.name : null
}
const layoutQuery = () => `?scene=${encodeURIComponent(sceneName || '')}`
function layoutDoc(name, title = null) {
  return {
    version: 1, name, title: title || null, scene_name: sceneName, library: LIBRARY_URL,
    items: [...items.values()].map((r) => ({
      uid: r.uid, id: r.id, render: r.render, // what was drawn; on load the library entry decides (§4.5 Splats)
      position: [round(r.group.position.x, 6), round(r.group.position.y, 6), round(r.group.position.z, 6)],
      rotation_y_deg: round(r.rotationDeg, 6),
      ...(validDims(r.lib.dims_cm) ? { dims_cm: { ...r.lib.dims_cm } } : {}), // a placeholder's size if the piece goes missing (§2.8)
    })),
  }
}
// opts.title: the name as the user typed it; saving over a layout keeps its title unless a new one is given.
async function saveLayoutInternal(name, opts = {}) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug like "reading-corner" (got "${name}")`)
  if (!sceneName) throw reportError('Open a scene first, then save a layout')
  const given = typeof opts?.title === 'string' && opts.title.trim() ? opts.title.trim().slice(0, 120) : null
  const kept = name === layoutName ? layoutTitle : layoutDetails.find((d) => d.name === name)?.title
  const title = given || (typeof kept === 'string' && kept.trim() ? kept.trim() : null)
  let stored
  try {
    stored = await apiJson(`/api/layouts/${name}${layoutQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layoutDoc(name, title)) })
  } catch (e) {
    throw reportError(e.status ? `Could not save layout "${name}"` : `Layout "${name}" not saved: the server isn't answering`, e)
  }
  setLayoutName(name, title)
  rememberLayout(name, stored?.updated) // the server's clock, as other devices compare against it
  markLayoutClean()
  emit('layouts', { name })
  await refreshLayouts()
}
async function loadLayoutInternal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug (got "${name}")`)
  if (!sceneName) throw reportError('Open a scene first, then load a layout')
  let doc
  try { doc = await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`) } catch (e) {
    throw reportError(e.status === 404 ? `No layout named "${name}" in this scene` : `Could not load layout "${name}"`, e)
  }
  if (!doc || !Array.isArray(doc.items)) throw reportError(`Layout "${name}" has no items array`)
  if (doc.library && doc.library !== LIBRARY_URL) toast(`Layout "${name}" was made with library ${doc.library}`, 'info')
  await quietly(async () => {
    clearItemsInternal()
    const missing = doc.items.filter((it) => it && typeof it.id === 'string' && !library.some((l) => l.id === it.id))
    const results = await Promise.allSettled(doc.items.map((it) => addItemInternal(it.id, {
      uid: it.uid, position: it.position, rotation_y_deg: it.rotation_y_deg,
      missing: missing.includes(it) ? (validDims(it.dims_cm) ? it.dims_cm : MISSING_DIMS) : undefined,
    })))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) toast(`Layout "${name}": ${failed} of ${doc.items.length} items could not be placed.`, 'error')
    if (missing.length) {
      const n = missing.length
      toast(`${n === 1 ? 'One piece in' : `${n} pieces in`} "${name}" ${n === 1 ? "isn't" : "aren't"} in the library any more: shown as ${n === 1 ? 'a box' : 'boxes'}.`, 'info', 9000)
    }
  })
  setLayoutName(name, doc.title)
  rememberLayout(name)
  markLayoutClean()
  emit('layouts', { name })
}
// Deletes a layout (the server keeps it in layouts/<scene>/.trash). Resolves with the layout as it was, for Undo.
async function deleteLayoutInternal(name) {
  let doc = null
  try { doc = await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`) } catch { /* deleted below anyway */ }
  try { await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`, { method: 'DELETE' }) } catch (e) { throw reportError(`Could not delete layout "${name}"`, e) }
  const wasCurrent = layoutName === name
  if (wasCurrent) { setLayoutName(''); rememberLayout(null) }
  await refreshLayouts()
  return doc ? { ...doc, wasCurrent } : null
}
// Undo of a delete: puts the layout back as it was (same items and title). It becomes the current layout again if it
// was, without touching the pieces in the scene.
async function restoreLayoutInternal(doc) {
  if (!doc || typeof doc.name !== 'string' || !SLUG.test(doc.name) || !Array.isArray(doc.items)) throw reportError('Nothing to restore')
  if (!sceneName || (doc.scene_name && doc.scene_name !== sceneName)) throw reportError('That layout belongs to another scene')
  const body = { version: 1, name: doc.name, title: doc.title ?? null, scene_name: sceneName, library: doc.library ?? LIBRARY_URL, items: doc.items, ...(typeof doc.notes === 'string' ? { notes: doc.notes } : {}) }
  let stored
  try {
    stored = await apiJson(`/api/layouts/${doc.name}${layoutQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (e) { throw reportError(`Could not restore layout "${doc.name}"`, e) }
  if (doc.wasCurrent && !layoutName) { setLayoutName(doc.name, doc.title); rememberLayout(doc.name, stored?.updated); emit('layouts', { name: doc.name }) }
  await refreshLayouts()
}
async function listLayoutsInternal() {
  if (!sceneName) return []
  const data = await apiJson(`/api/layouts${layoutQuery()}`)
  const names = Array.isArray(data?.layouts) ? data.layouts : []
  layoutDetails = Array.isArray(data?.details) ? data.details : names.map((n) => ({ name: n }))
  return names
}
async function refreshLayouts() {
  let names = []
  try { names = await listLayoutsInternal() } catch (e) { reportError('Could not list layouts', e); return }
  layoutNames = names
  emit('layouts', { names: names.slice(), details: layoutDetails.slice() })
}

// --- look and lighting (contract §4.8) --------------------------------------------------------------------------------
function warmthTint(w) {
  const t = new THREE.Vector3(1 + 0.14 * w, 1 + 0.015 * w, 1 - 0.14 * w)
  return t.multiplyScalar(1 / (0.2126 * t.x + 0.7152 * t.y + 0.0722 * t.z))
}
function getLook() { return { exposure: look.exposure, warmth: look.warmth, contactShadows: look.contact_shadows } }
function emitLook() { emit('look', getLook()) }
// The values in use: with Auto lighting on, the inferred direction and softness (lighting.json's key turned to the
// world, or the v1 key light); off, the stored ones (each falling back to the inferred one).
function resolvedLook() {
  const inf = lights.inferred()
  const autoDir = inf ? inf.direction : [...V1_KEY_DIR]
  const autoSoft = inf ? inf.softness : V1_SOFTNESS
  const manual = !look.auto_light
  const ae = azElOf(autoDir)
  const az = manual && look.light_azimuth_deg != null ? look.light_azimuth_deg : ae.azimuth_deg
  const el = manual && look.light_elevation_deg != null ? look.light_elevation_deg : ae.elevation_deg
  return {
    light_azimuth_deg: az, light_elevation_deg: el,
    dir: manual && (look.light_azimuth_deg != null || look.light_elevation_deg != null) ? dirOf(az, el) : autoDir,
    light_softness: manual && look.light_softness != null ? look.light_softness : autoSoft,
    light_strength: look.light_strength, ambient: look.ambient,
    cast_shadows: look.cast_shadows ?? !!lightingData,
  }
}
function applyLook() {
  compMat.uniforms.uExposure.value = look.exposure
  compMat.uniforms.uTint.value.copy(warmthTint(look.warmth))
  lights.setLook(resolvedLook())
  // splats (§4.5, §4.8): a plain multiplier, the Look's exposure × warmth times the room's light colour and level
  splatCompMat.uniforms.uGain.value.copy(warmthTint(look.warmth)).multiplyScalar(look.exposure).multiply(new THREE.Vector3(...lights.splatGain()))
  for (const r of items.values()) syncShadow(r)
  emitLook()
}
// getLighting() (hook, §4.8): the Look's values in use, where the light comes from, and the key in the world frame.
function getLighting() {
  const r = resolvedLook()
  const inf = lights.inferred()
  const k = lights.inUse()
  const r3 = (v) => v.map((x) => round(x, 6))
  return {
    exposure: look.exposure, warmth: look.warmth, contact_shadows: look.contact_shadows, auto_light: look.auto_light,
    light_azimuth_deg: round(r.light_azimuth_deg, 3), light_elevation_deg: round(r.light_elevation_deg, 3), light_softness: round(r.light_softness, 4),
    light_strength: look.light_strength, ambient: look.ambient, cast_shadows: r.cast_shadows,
    source: lightingData ? (lightingData.source === 'truth' ? 'truth' : 'photo') : 'default',
    inferred: inf && { azimuth_deg: round(inf.azimuth_deg, 3), elevation_deg: round(inf.elevation_deg, 3), softness: inf.softness, direction: r3(inf.direction), color: inf.color, intensity: inf.intensity, cct_k: inf.cct_k },
    key: { azimuth_deg: round(k.azimuth_deg, 3), elevation_deg: round(k.elevation_deg, 3), direction: r3(k.direction), color: k.color, intensity: round(k.intensity, 6), softness: round(k.softness, 4) },
    status: lightingStatus.status, error: lightingStatus.error,
  }
}
// Keeps what is in use when Auto lighting goes off, so nothing jumps.
function freezeAuto() {
  const r = resolvedLook()
  look.light_azimuth_deg = round(wrapAz(r.light_azimuth_deg), 3)
  look.light_elevation_deg = round(Math.min(90, Math.max(5, r.light_elevation_deg)), 3)
  look.light_softness = round(r.light_softness, 4)
}
// setLighting(partial) (hook, §4.8): live. A direction or softness turns Auto lighting off unless auto_light is given.
// The Look saves itself: PUT /api/scenes/<name> {look} 0.7 s after the last change (and at once when the scene is
// closed or another opens, or the page hides), so a lighting tweak is never lost and never waits for Save scene.
let lookTimer = 0
function saveLookSoon() {
  if (!sceneName) return
  clearTimeout(lookTimer)
  lookTimer = setTimeout(flushLook, 700)
}
function flushLook() {
  if (!lookTimer) return
  clearTimeout(lookTimer)
  lookTimer = 0
  const name = sceneName
  if (!name) return
  const saved = { ...look }
  quiet(apiJson(sceneUrl(name), { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ look: lookToSave() }) })
    .then(() => { if (name === sceneName && savedScene) savedScene.look = saved })
    .catch((e) => { throw reportError(e.status ? 'Could not save the look' : "The look isn't saved: the server isn't answering", e) }))
}
addEventListener('pagehide', flushLook)
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushLook() })
function setLighting(p = {}) {
  if (!p || typeof p !== 'object') { reportError('setLighting needs an object like { light_strength: 1.2 }'); return }
  const before = JSON.stringify(look)
  const manualKeys = ['light_azimuth_deg', 'light_elevation_deg', 'light_softness']
  const goesManual = (manualKeys.some((k) => isNum(p[k])) && typeof p.auto_light !== 'boolean') || p.auto_light === false
  if (goesManual && look.auto_light) freezeAuto()
  if (goesManual) look.auto_light = false
  for (const [k, [lo, hi]] of Object.entries(LOOK_NUM)) if (isNum(p[k])) look[k] = Math.min(hi, Math.max(lo, k === 'light_azimuth_deg' ? wrapAz(p[k]) : p[k]))
  for (const k of Object.keys(LOOK_BOOL)) if (typeof p[k] === 'boolean' && !(k === 'auto_light' && p[k] === false)) look[k] = p[k]
  applyLook()
  if (JSON.stringify(look) !== before) saveLookSoon()
}
// resetLighting() (hook, Reset): Auto lighting, strength, ambient, exposure and warmth back; the shadows to their
// defaults; the stored direction and softness gone.
function resetLighting() {
  Object.assign(look, { auto_light: true, light_strength: 1, ambient: 1, exposure: 1, warmth: 0, cast_shadows: null, contact_shadows: true, light_azimuth_deg: null, light_elevation_deg: null, light_softness: null })
  applyLook()
  saveLookSoon()
}
function setLook(s = {}) {
  setLighting({ ...(isNum(s.exposure) ? { exposure: s.exposure } : {}), ...(isNum(s.warmth) ? { warmth: s.warmth } : {}) })
}
// PUT body: every key; null removes it on the server (the direction and softness while Auto lighting is on, and
// cast_shadows while it follows the scene's default).
function lookToSave() {
  const out = Object.fromEntries(LOOK_KEYS.map((k) => [k, look[k]]))
  if (look.auto_light) out.light_azimuth_deg = out.light_elevation_deg = out.light_softness = null
  return out
}
function setLightingData(data) {
  lightingData = data?.lighting && typeof data.lighting === 'object' ? data.lighting : null
  lightingStatus = { status: data?.lighting_status || (lightingData ? 'done' : 'missing'), error: data?.lighting_error || null }
  lights.setData(lightingData)
}
function emitLighting() { emit('lighting', { status: lightingStatus.status, error: lightingStatus.error }); emitLook() }
// A scene calibrated before lighting.json existed (§4.8 backfill): POST …/light runs only the lighting step on the
// server; this polls the scene until it is there (or the server found none), then lights the furniture with it.
// Opening such a scene starts it; the Look panel's "Infer lighting" starts it again after a failure.
async function inferLighting() {
  const name = sceneName
  if (!name) throw reportError('No scene is open')
  const token = ++lightingToken
  try {
    await apiJson(`${sceneUrl(name)}/light`, { method: 'POST' })
  } catch (e) {
    const why = e.status === 409 ? 'the scene is calibrating; its light comes with it' : e.status ? "the server couldn't start it" : "the server isn't answering"
    if (name === sceneName) { lightingStatus = { status: 'failed', error: why }; emitLighting() }
    throw reportError(e.status === 409 ? 'This scene is calibrating; its lighting comes with it' : 'Could not start inferring the light', e)
  }
  lightingStatus = { status: 'pending', error: null }
  emitLighting()
  for (let i = 0; i < 600; i++) {
    await sleep(i < 4 ? 600 : 1500)
    if (name !== sceneName || token !== lightingToken) return null
    let data
    try { data = await getSceneInternal(name) } catch { continue }
    if (name !== sceneName || token !== lightingToken) return null
    const st = data.lighting_status || (data.lighting ? 'done' : 'missing')
    if (st === 'pending' || st === 'running') { if (st !== lightingStatus.status) { lightingStatus = { status: st, error: null }; emitLighting() } continue }
    sceneData = { ...sceneData, lighting: data.lighting ?? null, lighting_status: st, lighting_error: data.lighting_error ?? null }
    setLightingData(sceneData)
    applyLook()
    emitLighting()
    if (st === 'done') toast('Lighting inferred from the photo', 'ok', 3500)
    else if (st === 'failed') toast(`Couldn't infer the light: ${lightingStatus.error || 'see the server log'}`, 'error')
    return getLighting()
  }
  return null
}

// --- drawing ------------------------------------------------------------------------------------------------------------
// The pieces that cast the key's shadow, as one world box (null without any): the shadow camera is fitted to it.
function shadowBox() {
  if (!lights.key.castShadow || !items.size) return null
  const b = new THREE.Box3()
  for (const r of items.values()) if (r.child && !r.missing) b.union(worldBounds(r))
  return b.isEmpty() ? null : b
}
function drawTo(target, { furniture = true } = {}) {
  depthMat.uniforms.uScale.value = depthScale() // every frame: the camera or calib.json (Calibrate again) may have changed
  if (furniture) lights.fitShadow(shadowBox())
  renderer.setRenderTarget(furnRT)
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, true, true)
  if (furniture) renderer.render(scene, camera)
  // The splats, alone (camera layer SPLAT_LAYER), over the depth the furniture pass left in the shared depth texture
  // (resolved from its MSAA buffer when that render ended): colour cleared, depth kept, Spark writes no depth.
  // Skipped when nothing it draws changed (splatKey): splatRT still holds that picture.
  const splats = furniture && !!spark && splatItemCount() > 0
  const key = splats ? splatKey() : null
  if (splats && key !== splatDrawn) {
    renderer.setRenderTarget(splatRT)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, false, false)
    camera.layers.set(SPLAT_LAYER)
    try { renderer.render(scene, camera) } catch (e) { splatDrawn = null; throw e } finally { camera.layers.set(0) }
    // The key after the render: a generate Spark ran in it (bumping splatEpoch) is already in this picture; the sort
    // it started bumps splatEpoch again when it lands, and that redraws.
    splatDrawn = splatKey()
  }
  renderer.setRenderTarget(target)
  renderer.setClearColor(BAR, 1)
  renderer.clear(true, true, true)
  renderer.render(photoScene, orthoCam)
  if (furniture) renderer.render(compScene, orthoCam)
  if (splats) renderer.render(splatCompScene, orthoCam)
}
function renderFrame() { drawTo(null, { furniture: !!sceneName }) }

// The full photo frame at the photo's resolution (or scaled to maxPx): photo + furniture, no view offset, no grid.
// → { dataUrl, width, height }
function withFullFrame(w, h, fn) {
  const saved = { grid: grid.visible, rect: photoMat.uniforms.uRect.value.clone(), target: photoMat.uniforms.uTarget.value.clone(), proj: depthMat.uniforms.uProj.value.clone(), furn: [furnRT.width, furnRT.height] }
  grid.visible = false
  camera.clearViewOffset()
  camera.aspect = photo.w / photo.h
  camera.updateProjectionMatrix()
  for (const m of [photoMat, depthMat, compMat]) { m.uniforms.uRect.value.set(0, 0, w, h); m.uniforms.uTarget.value.set(w, h) }
  depthMat.uniforms.uProj.value.copy(camera.projectionMatrix)
  sizeTargets(w, h)
  try { return fn() } finally {
    grid.visible = saved.grid
    sizeTargets(...saved.furn)
    renderer.setRenderTarget(null)
    updateView()
  }
}
function readTarget(rt, w, h) {
  const buf = new Uint8Array(w * h * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx2 = c.getContext('2d')
  const img = ctx2.createImageData(w, h)
  for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4) // GL rows are bottom-up
  ctx2.putImageData(img, 0, 0)
  return { canvas: c, pixels: img.data }
}
// The view as a 2D canvas: both passes at the photo's own size times k (no view offset, no grid, no UI).
function captureCanvas(k = 1) {
  if (!photo.has) throw new Error('no photo is open')
  const w = Math.max(1, Math.round(photo.w * k)), h = Math.max(1, Math.round(photo.h * k))
  const max = renderer.capabilities.maxTextureSize || 4096
  if (Math.max(w, h) > max) throw new Error(`${w} × ${h} is larger than this GPU draws (${max} px)`)
  const out = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false })
  try {
    return withFullFrame(w, h, () => { drawTo(out); return readTarget(out, w, h) }).canvas
  } finally { out.dispose() }
}
function captureComposite({ maxPx = null, quality = 0.92 } = {}) {
  const k = maxPx ? Math.min(1, maxPx / Math.max(photo.w, photo.h)) : 1
  const c = captureCanvas(k)
  return { dataUrl: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height }
}
// Export (no AI, free, nothing leaves the device): the scene as drawn, at `longEdge` px on its longer side (default the
// photo's own size; up to 2× it), as a JPEG or PNG blob, and the canvas. encode: false skips the blob (the caller
// composes the canvas itself, as Before and after does).
async function exportImage({ longEdge = null, type = 'image/jpeg', quality = 0.92, encode = true } = {}) {
  if (!sceneName || !photo.has) throw reportError('Open a scene first, then export it')
  if (!/^image\/(jpeg|png)$/.test(type)) throw reportError(`Can't export as ${type} (JPEG or PNG)`)
  const long = Math.max(photo.w, photo.h)
  const k = isNum(longEdge) && longEdge > 0 ? Math.min(2, longEdge / long) : 1
  try { await settleSplats() } catch (e) { reportError('Could not sort the splats for the export', e) }
  holdFrames++
  let canvas
  try {
    try { canvas = captureCanvas(k) } catch (e) { throw reportError('Could not capture the view', e) }
  } finally { holdFrames--; wake() }
  if (!encode) return { blob: null, canvas, width: canvas.width, height: canvas.height, type }
  const blob = await new Promise((res) => canvas.toBlob(res, type, type === 'image/jpeg' ? quality : undefined))
  if (!blob) throw reportError('Could not encode the image')
  return { blob, canvas, width: canvas.width, height: canvas.height, type }
}
// The keep-room mask (§4.7): items white on black at the photo's size (what the photo hides of them stays black),
// dilated by 3 % of the photo's width, and twice that below each piece for its shadow. → { dataUrl, width, height, coverage }
const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false })
function captureMask() {
  if (!photo.has) throw new Error('no photo is open')
  const w = photo.w, h = photo.h
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true })
  const swapped = []
  const shown = [] // a splat item's invisible GLB (or box) stands for its splat here (the mask is dilated anyway)
  for (const rec of items.values()) {
    if (rec.splat && rec.child && !rec.child.visible) { rec.child.visible = true; shown.push(rec.child) }
    rec.group.traverse((o) => { if (o.isMesh || o.isLine) { swapped.push([o, o.material, o.visible]); o.material = maskMat; if (o.isLine) o.visible = false } })
  }
  let pixels
  lights.maskMode(true) // the pieces' cast shadow on the floor is part of what the render may change
  try {
    pixels = withFullFrame(w, h, () => {
      lights.fitShadow(shadowBox())
      renderer.setRenderTarget(rt)
      renderer.setClearColor(0x000000, 1)
      renderer.clear(true, true, true)
      renderer.render(scene, camera)
      const buf = new Uint8Array(w * h * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf)
      return buf
    })
  } finally {
    lights.maskMode(false)
    for (const [o, m, v] of swapped) { o.material = m; o.visible = v }
    for (const o of shown) o.visible = false
    rt.dispose()
  }
  // binary, top-down rows
  let on = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4
    for (let x = 0; x < w; x++) on[y * w + x] = pixels[src + x * 4] > 127 ? 1 : 0
  }
  const r = Math.max(1, Math.round(0.03 * w))
  on = dilate(on, w, h, r, r, r, 2 * r)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx2 = c.getContext('2d')
  const img = ctx2.createImageData(w, h)
  let count = 0
  for (let i = 0; i < w * h; i++) { const v = on[i] ? 255 : 0; count += on[i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255 }
  ctx2.putImageData(img, 0, 0)
  return { dataUrl: c.toDataURL('image/png'), width: w, height: h, coverage: count / (w * h) }
}
// Box dilation in O(n): a pixel turns on when a set pixel is within `left`/`right` px on its row, then within `up`
// px below it or `down` px above it in its column (so the mask reaches further below a piece than above it).
function dilate(src, w, h, left, right, up, down) {
  const a = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let last = -1e9
    for (let x = 0; x < w; x++) { if (src[row + x]) last = x; if (x - last <= right) a[row + x] = 1 }
    last = 1e9
    for (let x = w - 1; x >= 0; x--) { if (src[row + x]) last = x; if (last - x <= left) a[row + x] = 1 }
  }
  const b = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    let last = -1e9
    for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= down) b[y * w + x] = 1 }
    last = 1e9
    for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= up) b[y * w + x] = 1 }
  }
  return b
}

// --- render (contract §2.6, §4.7) ---------------------------------------------------------------------------------------
// First entry is the default. Nano Banana takes the scene photo as a reference (image 2).
export const RENDER_MODELS = {
  'nano-banana': { label: 'Nano Banana edit', price: () => 0.0398 },
  kontext: { label: 'FLUX.1 Kontext [pro]', price: () => 0.04 },
  qwen: { label: 'Qwen Image Edit', price: (mp) => 0.03 * mp },
}
export const fmtUsd = (v) => `$${Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4)}`
export function renderPrice(model, shot) { return RENDER_MODELS[model].price(shot ? (shot.width * shot.height) / 1e6 : 1) }
let renders = []
let renderMock = false
// opts: { model, prompt, keepRoom, mask (from captureMask, when keepRoom) }
async function postRender(shot, opts = {}) {
  const model = opts.model || 'nano-banana'
  const layout = layoutName.trim()
  const scene = sceneName
  let meta
  emit('render', { phase: 'start', model })
  try {
    meta = await apiJson('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: shot.dataUrl, model, prompt: opts.prompt || undefined, scene: scene || undefined,
        layout: SLUG.test(layout) ? layout : undefined,
        ...(opts.keepRoom ? { keep_room: true, mask: opts.mask?.dataUrl } : {}),
      }),
    })
  } catch (e) {
    emit('render', { phase: 'failed', model, error: e.message })
    throw reportError(e.status === 402 ? "Not rendered: today's fal budget is used up" : 'Render failed', e)
  }
  emit('render', { phase: 'done', model, meta })
  if (meta.scene === sceneName) {
    renders = [meta, ...renders.filter((r) => r.name !== meta.name)]
    emit('renders', { renders: renders.slice() })
  }
  return meta
}
async function renderViewInternal(opts = {}) {
  const o = opts || {}
  const model = o.model ?? 'nano-banana'
  if (!Object.hasOwn(RENDER_MODELS, model)) throw reportError(`Unknown render model "${model}" (use ${Object.keys(RENDER_MODELS).join(', ')})`)
  if (o.prompt != null && typeof o.prompt !== 'string') throw reportError('Render prompt must be a string')
  if (!sceneName) throw reportError('Open a scene first, then render it')
  // §4.7: the splats sorted for the capture camera first, with the view still drawing (a piece placed a moment ago
  // only joins Spark's sorted set through those frames). Then the view holds still for the capture itself.
  try { await settleSplats() } catch (e) { reportError('Could not sort the splats for the render', e) }
  holdFrames++
  let shot, mask = null
  try {
    try {
      shot = captureComposite()
      if (o.keepRoom) mask = captureMask()
    } catch (e) { throw reportError('Could not capture the view', e) }
  } finally { holdFrames--; wake() }
  return postRender(shot, { model, prompt: o.prompt, keepRoom: !!o.keepRoom, mask })
}
async function listRendersInternal() {
  let data
  try { data = await apiJson(sceneName ? `/api/renders?scene=${encodeURIComponent(sceneName)}` : '/api/renders') } catch (e) { throw reportError('Could not list renders', e) }
  renders = Array.isArray(data?.renders) ? data.renders : []
  renderMock = data?.mock === true
  emit('renders', { renders: renders.slice() })
  return renders.slice()
}
function compare(a, b) {
  const names = [a, b].map((x) => (typeof x === 'string' ? x : x?.name))
  if (!names.every((n) => typeof n === 'string' && n)) { reportError('compare needs two render names'); return }
  emit('compare', { a: names[0], b: names[1] })
}

// --- render loop + overlay hooks ----------------------------------------------------------------------------------------
const frameFns = new Set()
function onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn) }
applyCamera()
const clock = new THREE.Clock()
let renderErrorReported = false
let holdFrames = 0 // > 0 while a render captures the view (renderViewInternal)
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (holdFrames) return
    if (performance.now() > awakeUntil && !framePending) return
    framePending = false
    renderFrame()
    for (const fn of frameFns) fn(dt)
  } catch (e) {
    if (!renderErrorReported) reportError('Rendering failed', e)
    renderErrorReported = true
  }
})

// --- state for window.midstudy (contract §2.4, §4.6) --------------------------------------------------------------------
function getSceneState() {
  if (!sceneName) return null
  return {
    name: sceneName, title: sceneData?.title ?? null, camera: { ...cam }, camera_source: cameraSource,
    floor_found: sceneData?.calib?.floor?.found ?? null, hasDepth: !!photo.depthTexture, occlusion, adjustFloor,
  }
}
function getState() {
  return {
    scene: getSceneState(),
    items: [...items.values()].map((r) => {
      const b = worldBounds(r)
      return {
        uid: r.uid, id: r.id, render: r.render, ...(r.splat ? { splats: r.splat.numSplats } : {}),
        position: [r.group.position.x, r.group.position.y, r.group.position.z], rotation_y_deg: r.rotationDeg,
        ...(r.missing ? { missing: true } : {}),
        worldBounds: { min: b.min.toArray(), max: b.max.toArray() },
      }
    }),
    layout: layoutName || null,
    dirty: dirty.layout,
  }
}
function getRenderSettings() {
  return {
    toneMapping: 'aces', exposure: look.exposure, warmth: look.warmth, contactShadows: look.contact_shadows,
    shadowCount: [...items.values()].filter((r) => r.shadow && r.shadow.visible).length,
  }
}

// The first page state (§4.5): ?scene=<name>; else the scene last opened on this device, if it still exists; else none
// (the UI shows the Scenes page). → the scene name opened, or null
async function startScene() {
  const want = params.get('scene')
  const list = await listScenesInternal().catch(() => null)
  const has = (n) => !!n && !!list && list.some((s) => s.name === n)
  if (want) {
    if (has(want)) { await openScene(want).catch(() => {}); return sceneName }
    reportError(`There's no scene "${want}"`)
    syncUrl(null)
    return null
  }
  const last = store.get(LAST_SCENE_KEY)
  if (has(last)) { await openScene(last).catch(() => {}); return sceneName }
  return null
}
async function init() {
  const [, first] = await Promise.allSettled([loadLibrary(), startScene()])
  return first.status === 'fulfilled' ? first.value : null
}

export const engine = {
  events, errors, canvas,
  three: { scene, camera, renderer, get spark() { return spark } },
  // setup
  init, mount, setStageInsets,
  // state
  getScene: () => (sceneName ? { ...sceneData, name: sceneName, w: photo.w, h: photo.h, camera: { ...cam }, camera_source: cameraSource, hasDepth: !!photo.depthTexture } : null),
  getSceneName: () => sceneName,
  getSceneLoad: () => ({ ...sceneLoad }),
  getScenesList: () => scenesList.slice(),
  getCamera: () => ({ ...cam }),
  getCameraSource: () => cameraSource,
  getCalibCamera: () => (sceneData?.calib?.camera ? clampCamera(sceneData.calib.camera) : null),
  getSavedScene: () => clone(savedScene),
  getAdjustFloor: () => adjustFloor,
  getFloorNote: () => floorNote,
  getOcclusion: () => occlusion,
  getGridVisible: () => grid.visible,
  getView, getPhotoRect, getStageRect: stageRect, getVisiblePhotoRect: visiblePhotoRect,
  getPhotoSize: () => ({ w: photo.w, h: photo.h, has: photo.has }),
  isSceneDirty: () => dirty.scene,
  isLayoutDirty: () => dirty.layout,
  getDirty: () => ({ ...dirty }),
  getItems: () => [...items.values()].map(itemInfo),
  getItem: (uid) => (items.has(uid) ? itemInfo(items.get(uid)) : null),
  getItemBounds: (uid) => { const rec = items.get(uid); if (!rec) return null; const b = worldBounds(rec); return { min: b.min.toArray(), max: b.max.toArray() } },
  getSelected: () => selected,
  getSelection: () => [...selection],
  isSelected: (uid) => selection.has(uid),
  getDrag: () => (drag.mode ? { mode: drag.mode, uid: drag.uid } : null),
  getFootprint, hitItemAt, itemAt, getScreenRect, getElevation,
  getLook, getLibrary: () => library.slice(), assetUrl,
  getLayouts: () => layoutNames.slice(), getLayoutDetails: () => layoutDetails.map((d) => ({ ...d })), getLayoutName: () => layoutName,
  getLayoutTitle: () => layoutDisplayName(layoutName), layoutDisplayName, getScenesTrash: () => scenesTrash.map((t) => ({ ...t })),
  getRenders: () => renders.slice(), isRenderMock: () => renderMock,
  getRuler, getState, getRenderSettings, horizonAt,
  // scenes
  listScenesInternal, openScene, closeScene, waitForScene, createScene, deleteScene, restoreScene, renameScene, saveScene, saveThumbnail, recalibrate,
  setCamera, resetCamera, setAdjustFloor, setOcclusion, setGridVisible, setPitchFromHorizon,
  // view
  zoomAt, zoomBy, panBy, fitView,
  // items + selection
  addItemInternal, moveItemInternal, removeItemInternal, clearItemsInternal, select, selectMany, selectAll, rotateSelected,
  nudgeSelected, duplicateSelected, setSnap,
  beginItemDrag, beginRotateDrag, dragTo, endItemDrag, removeItemWithUndo, restoreItem, restoreItems,
  setElevation, nudgeElevation, dropToFloor, reloadLibrary: () => loadLibrary(),
  tap, setRulerActive, clearRuler, setRulerPointAt, setRulerTrueLength,
  // look and lighting (§4.8)
  setLook, setContactShadows, getLighting, setLighting, resetLighting, inferLighting,
  getLightingStatus: () => ({ ...lightingStatus }),
  // layouts
  saveLayoutInternal, loadLayoutInternal, deleteLayoutInternal, restoreLayoutInternal, listLayoutsInternal, refreshLayouts, setLayoutName,
  // renders
  captureComposite, captureMask, postRender, renderViewInternal, listRendersInternal, compare, settleSplats, exportImage,
  // errors + overlays + projection
  reportError, toast, onFrame, wake, worldToScreen, projectPhoto, photoToFloor, floorToPhoto, clientToPhoto, photoToClient,
}
