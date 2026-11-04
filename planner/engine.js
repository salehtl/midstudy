// midstudy planner engine: the photo, the locked scene camera registered to it, the furniture drawn over it, and the
// API calls. No DOM UI lives here: UI modules (planner/ui/) read state through getters, call actions, and listen to
// `engine.events`. Spec: contract/CONTRACT.md §2 (carried from nook) and §4 (scenes). Units are meters, Y-up, the floor
// is y = 0, the camera stands at (0, height, 0) and looks along −Z (contract §4.1). Items are stored in their item frame.
//
// Drawing (each frame, on demand):
//   1. furniture pass, into a half-float MSAA target: an optional depth pre-pass writes the photo's depth (depth.png,
//      + 3 cm) into the depth buffer with colour writes off, then the pieces, their contact shadows and the floor grid
//      draw on top of it (so the real sofa hides a piece behind it);
//   2. the screen: the photo, drawn exactly as its bytes are (no tone mapping, exposure or warmth), contain-fit in the
//      uncovered part of the window (letterbox bars), then the furniture pass composited over it with the Look
//      (exposure, warmth), ACES Filmic and sRGB applied to the furniture only.
//   Zoom and pan are 2D (camera.setViewOffset over the photo's rectangle); the camera block never changes for them.
//   Renders capture the same two passes at the photo's own resolution (no view offset, no UI).
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
//   getLook()           { exposure, warmth, contactShadows }
//   getLibrary(), assetUrl(rel), getLayouts(), getLayoutDetails(), getLayoutName(), getRenders(), isRenderMock()
//   getRuler()          { active, points: [[x,0,z]…], meters|null }
//   getState() / getRenderSettings()   the window.midstudy shapes (contract §2.4, §4.6)
// Actions (async ones return Promises that reject with a reported error)
//   init(), mount(el), setStageInsets({ left, right, top, bottom }) (client px the chrome covers)
//   listScenesInternal(), openScene(name), closeScene(), waitForScene(name), createScene(file, meta), deleteScene(name),
//   renameScene(name, title), saveScene(), saveThumbnail()
//   setCamera(partial), resetCamera(), setAdjustFloor(on), setOcclusion(on), setGridVisible(on), setPitchFromHorizon(py)
//   zoomAt(clientX, clientY, zoom), zoomBy(factor, clientX?, clientY?), panBy(dxClient, dyClient), fitView()
//   addItemInternal(id, opts), moveItemInternal(uid, opts), removeItemInternal(uid), clearItemsInternal(), select(uid|null),
//   rotateSelected(deg), setSnap(on), beginItemDrag / beginRotateDrag / dragTo / endItemDrag, removeItemWithUndo(uid),
//   restoreItem(snapshot), setElevation(uid, m), nudgeElevation(uid, dm), dropToFloor(uid), reloadLibrary()
//   tap(clientX, clientY), setRulerActive(on), clearRuler()
//   setLook({exposure, warmth}), setContactShadows(on)
//   saveLayoutInternal(name), loadLayoutInternal(name), deleteLayoutInternal(name), listLayoutsInternal(), refreshLayouts()
//   captureComposite({ maxPx, quality }), captureMask(), postRender(shot, opts), renderViewInternal(opts),
//   listRendersInternal(), compare(a, b)
//   reportError(msg, err) → Error, toast(text, kind, ms), onFrame(fn), worldToScreen(p) → { x, y, visible } (client px)
//   projectPhoto(p) → [px, py, d], photoToFloor(px, py), floorToPhoto(p), clientToPhoto(x, y), photoToClient(px, py)
// Events (engine.events, CustomEvents; read e.detail)
//   'scene'  { phase: 'loading'|'calibrating'|'opened'|'failed'|'closed'|'saved'|'title'|'deleted', name }
//   'scenes' { scenes }   'camera' { camera, source }   'adjust' { on }   'occlusion' { on }   'grid' { visible }
//   'view' getView()      'dirty' { scene, layout }     'items' { change, uid }   'selection' { uid }   'drag' { mode, uid, phase }
//   'look' getLook()      'library' { items }   'layouts' { names?, details?, name? }   'renders' { renders }
//   'render' { phase: 'start'|'done'|'failed', model, meta? }   'compare' { a, b }   'ruler' getRuler()
//   'error' { text }      'toast' { text, kind, ms }
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

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
const OCCLUSION_TOLERANCE = 0.03 // m (§4.5)
const MAX_ZOOM = 4
const BAR = new THREE.Color(0x0e0f11) // letterbox bars

// --- events, errors + toasts ------------------------------------------------
const events = new EventTarget()
const emit = (name, detail = {}) => { wake(); events.dispatchEvent(new CustomEvent(name, { detail })) }
// On-demand rendering: draw while something changes (input, any engine event) and for a short tail after.
let awakeUntil = 0
function wake(ms = 400) { awakeUntil = Math.max(awakeUntil, performance.now() + ms) }
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
const furnRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true })
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

// The furniture scene: lights, the depth pre-pass, the grid, the pieces.
const scene = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.8
const key = new THREE.DirectionalLight(0xffffff, 1.1)
key.position.set(-1.5, 4, 2.5)
const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 0.35)
scene.add(key, hemi)

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
  furnRT.setSize(Math.max(1, drawSize.x), Math.max(1, drawSize.y))
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
let contactShadows = true
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
  contactShadows = !!on
  for (const r of items.values()) syncShadow(r)
  emitLook()
}
// The blob stays on the floor (a child of the item, shifted down by the elevation); a raised item (its bottom more
// than 2 cm up, §2.10) has none.
function syncShadow(rec) {
  const y = rec.group.position.y
  if (rec.shadow) { rec.shadow.visible = contactShadows && y <= 0.02; rec.shadow.position.y = SHADOW_Y - y }
}

// --- library + items --------------------------------------------------------------------------------------------------
let library = []
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

async function loadLibrary() {
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
  emit('library', { items: library.slice() })
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

async function buildChild(lib) {
  if (lib.missing || !lib.assets?.glb) return missingChild(validDims(lib.dims_cm) ? lib.dims_cm : MISSING_DIMS)
  const t = await loadGlbTemplate(assetUrl(lib.assets.glb))
  return { obj: t.scene.clone(true), box: t.box.clone() }
}
function disposeChild(obj) {
  if (obj?.name === 'missing-item') obj.traverse((c) => c.geometry?.dispose())
}

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
  const rec = { uid, id, lib, group, child: null, localBox: null, rotationDeg: rot, shadow: null, missing: !!lib.missing, noGlb: !lib.missing && !lib.assets?.glb }
  try {
    const { obj, box } = await buildChild(lib)
    rec.child = obj
    rec.localBox = box
    group.add(obj)
    rec.shadow = makeContactShadow(rec)
    group.add(rec.shadow)
    syncShadow(rec)
  } catch (e) {
    throw reportError(`Could not load "${lib.name || id}"`, e)
  }
  if (gen !== itemsGen) {
    disposeChild(rec.child)
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
function rotateSelected(deg) {
  const rec = selected && items.get(selected)
  if (rec) moveItemInternal(rec.uid, { rotation_y_deg: round(wrapDeg(rec.rotationDeg + deg), 6) })
}
function removeItemInternal(uid) {
  const rec = items.get(uid)
  if (!rec) return
  if (selected === uid) select(null)
  scene.remove(rec.group)
  disposeChild(rec.child)
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
    uid: r.uid, id: r.id, name: r.lib.name || r.id, lib: r.lib, render: 'glb',
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
let selected = null
let snap = false // Shift on desktop: lift drags, 15° grip
const drag = { mode: null, uid: null, off: new THREE.Vector3(), a0: 0, rot0: 0, plane: new THREE.Plane() }
function select(uid) {
  const next = uid && items.has(uid) ? uid : null
  if (drag.mode && drag.uid !== next) endItemDrag()
  selected = next
  emit('selection', { uid: selected })
}
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
// Drag to move: the item keeps its offset from the finger and slides on its own horizontal plane (y stays its
// elevation): farther away it shrinks with perspective, closer it grows. With `lift` (Shift) it moves up and down only.
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
  } else plane.set(new THREE.Vector3(0, 1, 0), -rec.group.position.y)
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (selected !== uid) select(uid)
  Object.assign(drag, { mode, uid, off: rec.group.position.clone().sub(p) })
  drag.plane.copy(plane)
  emit('drag', { mode, uid, phase: 'start' })
  return true
}
function beginRotateDrag(uid, clientX, clientY) {
  const rec = items.get(uid)
  if (!rec) return false
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -rec.group.position.y)
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  const c = rec.group.position
  Object.assign(drag, { mode: 'rotate', uid, a0: Math.atan2(p.x - c.x, p.z - c.z), rot0: rec.rotationDeg })
  drag.plane.copy(plane)
  emit('drag', { mode: 'rotate', uid, phase: 'start' })
  return true
}
function dragTo(clientX, clientY, { snapTo = false } = {}) {
  const rec = drag.mode && items.get(drag.uid)
  if (!rec) return
  const p = planePointAt(drag.plane, clientX, clientY)
  if (!p) return
  const g = rec.group.position
  if (drag.mode === 'move') {
    moveItemInternal(drag.uid, { position: [round(p.x + drag.off.x, 6), g.y, round(p.z + drag.off.z, 6)] })
  } else if (drag.mode === 'lift') {
    let y = clampElev(p.y + drag.off.y)
    if (snap) y = Math.round(y / 0.01) * 0.01
    moveItemInternal(drag.uid, { position: [g.x, round(y, 6), g.z] })
  } else {
    let deg = drag.rot0 + (Math.atan2(p.x - g.x, p.z - g.z) - drag.a0) / DEG
    if (snapTo || snap) deg = Math.round(deg / 15) * 15
    moveItemInternal(drag.uid, { rotation_y_deg: round(wrapDeg(deg), 6) })
  }
}
function endItemDrag() {
  if (!drag.mode) return
  const d = { mode: drag.mode, uid: drag.uid }
  drag.mode = null
  drag.uid = null
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
// Move ruler point i to the floor under a client point (after a camera change the points stay in the photo's place).
function setRulerPointAt(i, clientX, clientY) {
  const p = photoToFloor(...clientToPhoto(clientX, clientY))
  if (!p || !ruler.points[i]) return false
  ruler.points[i] = p
  emit('ruler', getRuler())
  return true
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
let look = { ...LOOK_DEFAULT }
let adjustFloor = false
let occlusion = true
let floorNote = null
let scenesList = []
let sceneToken = 0
const sceneLoad = { loading: false, phase: null, name: null, scene: null }
const dirty = { scene: false, layout: false }
let quietItems = 0
function setDirty(next) {
  if (next.scene === dirty.scene && next.layout === dirty.layout) return
  Object.assign(dirty, next)
  emit('dirty', { ...dirty })
}
const sceneSig = () => JSON.stringify([cam, look.exposure, look.warmth])
let sceneBaseline = ''
const touchScene = () => setDirty({ ...dirty, scene: !!sceneName && sceneSig() !== sceneBaseline })
events.addEventListener('items', () => { if (!quietItems) setDirty({ ...dirty, layout: true }) })
async function quietly(fn) { quietItems++; try { return await fn() } finally { quietItems-- } }

async function listScenesInternal() {
  let data
  try { data = await apiJson('/api/scenes') } catch (e) { throw reportError('Could not list the scenes', e) }
  scenesList = Array.isArray(data?.scenes) ? data.scenes : []
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
    const l = data.look && typeof data.look === 'object' ? data.look : {}
    look = { exposure: clampNum(l.exposure, 0.25, 4, 1), warmth: clampNum(l.warmth, -1, 1, 0) }
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
    quiet(refreshLayouts())
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
  sceneToken++
  Object.assign(sceneLoad, { loading: false, phase: null, name: null, scene: null })
  quiet(quietly(() => clearItemsInternal()))
  clearPhoto()
  sceneName = null
  sceneData = null
  savedScene = null
  adjustFloor = false
  floorNote = null
  ruler.active = false
  ruler.points = []
  grid.visible = false
  layoutNames = []
  layoutDetails = []
  renders = []
  setLayoutName('')
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
  const body = { title: sceneData?.title ?? null, camera: { ...cam }, camera_source: cameraSource, look: { ...look } }
  let res
  try { res = await apiJson(sceneUrl(sceneName), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } catch (e) {
    throw reportError(e.status ? 'Could not save the scene' : "Not saved: the server isn't answering", e)
  }
  if (res && typeof res === 'object') {
    sceneData = { ...sceneData, ...res }
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
function setLayoutName(name) { layoutName = String(name ?? '') }
const layoutQuery = () => `?scene=${encodeURIComponent(sceneName || '')}`
function layoutDoc(name) {
  return {
    version: 1, name, scene_name: sceneName, library: LIBRARY_URL,
    items: [...items.values()].map((r) => ({
      uid: r.uid, id: r.id, render: 'glb',
      position: [round(r.group.position.x, 6), round(r.group.position.y, 6), round(r.group.position.z, 6)],
      rotation_y_deg: round(r.rotationDeg, 6),
      ...(validDims(r.lib.dims_cm) ? { dims_cm: { ...r.lib.dims_cm } } : {}), // a placeholder's size if the piece goes missing (§2.8)
    })),
  }
}
async function saveLayoutInternal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`Layout name must be a slug like "reading-corner" (got "${name}")`)
  if (!sceneName) throw reportError('Open a scene first, then save a layout')
  try {
    await apiJson(`/api/layouts/${name}${layoutQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layoutDoc(name)) })
  } catch (e) {
    throw reportError(e.status ? `Could not save layout "${name}"` : `Layout "${name}" not saved: the server isn't answering`, e)
  }
  setLayoutName(name)
  setDirty({ ...dirty, layout: false })
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
  setLayoutName(name)
  setDirty({ ...dirty, layout: false })
  emit('layouts', { name })
}
async function deleteLayoutInternal(name) {
  try { await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`, { method: 'DELETE' }) } catch (e) { throw reportError(`Could not delete layout "${name}"`, e) }
  if (layoutName === name) setLayoutName('')
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

// --- look (furniture only) --------------------------------------------------------------------------------------------
function warmthTint(w) {
  const t = new THREE.Vector3(1 + 0.14 * w, 1 + 0.015 * w, 1 - 0.14 * w)
  return t.multiplyScalar(1 / (0.2126 * t.x + 0.7152 * t.y + 0.0722 * t.z))
}
function getLook() { return { exposure: look.exposure, warmth: look.warmth, contactShadows } }
function emitLook() { emit('look', getLook()) }
function applyLook() {
  compMat.uniforms.uExposure.value = look.exposure
  compMat.uniforms.uTint.value.copy(warmthTint(look.warmth))
  emitLook()
}
function setLook(s = {}) {
  if (isNum(s.exposure)) look.exposure = clampNum(s.exposure, 0.25, 4, 1)
  if (isNum(s.warmth)) look.warmth = clampNum(s.warmth, -1, 1, 0)
  applyLook()
  touchScene()
}

// --- drawing ------------------------------------------------------------------------------------------------------------
function drawTo(target, { furniture = true } = {}) {
  depthMat.uniforms.uScale.value = depthScale() // every frame: the camera or calib.json (Calibrate again) may have changed
  renderer.setRenderTarget(furnRT)
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, true, true)
  if (furniture) renderer.render(scene, camera)
  renderer.setRenderTarget(target)
  renderer.setClearColor(BAR, 1)
  renderer.clear(true, true, true)
  renderer.render(photoScene, orthoCam)
  if (furniture) renderer.render(compScene, orthoCam)
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
  furnRT.setSize(w, h)
  try { return fn() } finally {
    grid.visible = saved.grid
    furnRT.setSize(...saved.furn)
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
function captureComposite({ maxPx = null, quality = 0.92 } = {}) {
  if (!photo.has) throw new Error('no photo is open')
  const k = maxPx ? Math.min(1, maxPx / Math.max(photo.w, photo.h)) : 1
  const w = Math.max(1, Math.round(photo.w * k)), h = Math.max(1, Math.round(photo.h * k))
  const out = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false })
  try {
    const { canvas: c } = withFullFrame(w, h, () => { drawTo(out); return readTarget(out, w, h) })
    return { dataUrl: c.toDataURL('image/jpeg', quality), width: w, height: h }
  } finally { out.dispose() }
}
// The keep-room mask (§4.7): items white on black at the photo's size (what the photo hides of them stays black),
// dilated by 3 % of the photo's width, and twice that below each piece for its shadow. → { dataUrl, width, height, coverage }
const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false })
function captureMask() {
  if (!photo.has) throw new Error('no photo is open')
  const w = photo.w, h = photo.h
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true })
  const swapped = []
  for (const rec of items.values()) rec.group.traverse((o) => { if (o.isMesh || o.isLine) { swapped.push([o, o.material, o.visible]); o.material = maskMat; if (o.isLine) o.visible = false } })
  let pixels
  try {
    pixels = withFullFrame(w, h, () => {
      renderer.setRenderTarget(rt)
      renderer.setClearColor(0x000000, 1)
      renderer.clear(true, true, true)
      renderer.render(scene, camera)
      const buf = new Uint8Array(w * h * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf)
      return buf
    })
  } finally {
    for (const [o, m, v] of swapped) { o.material = m; o.visible = v }
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
  let shot, mask = null
  try {
    shot = captureComposite()
    if (o.keepRoom) mask = captureMask()
  } catch (e) { throw reportError('Could not capture the view', e) }
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
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (performance.now() > awakeUntil) return
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
        uid: r.uid, id: r.id, render: 'glb',
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
    toneMapping: 'aces', exposure: look.exposure, warmth: look.warmth, contactShadows,
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
  three: { scene, camera, renderer },
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
  getDrag: () => (drag.mode ? { mode: drag.mode, uid: drag.uid } : null),
  getFootprint, hitItemAt, getScreenRect, getElevation,
  getLook, getLibrary: () => library.slice(), assetUrl,
  getLayouts: () => layoutNames.slice(), getLayoutDetails: () => layoutDetails.map((d) => ({ ...d })), getLayoutName: () => layoutName,
  getRenders: () => renders.slice(), isRenderMock: () => renderMock,
  getRuler, getState, getRenderSettings, horizonAt,
  // scenes
  listScenesInternal, openScene, closeScene, waitForScene, createScene, deleteScene, renameScene, saveScene, saveThumbnail, recalibrate,
  setCamera, resetCamera, setAdjustFloor, setOcclusion, setGridVisible, setPitchFromHorizon,
  // view
  zoomAt, zoomBy, panBy, fitView,
  // items + selection
  addItemInternal, moveItemInternal, removeItemInternal, clearItemsInternal, select, rotateSelected, setSnap,
  beginItemDrag, beginRotateDrag, dragTo, endItemDrag, removeItemWithUndo, restoreItem,
  setElevation, nudgeElevation, dropToFloor, reloadLibrary: () => loadLibrary(),
  tap, setRulerActive, clearRuler, setRulerPointAt,
  // look
  setLook, setContactShadows,
  // layouts
  saveLayoutInternal, loadLayoutInternal, deleteLayoutInternal, listLayoutsInternal, refreshLayouts, setLayoutName,
  // renders
  captureComposite, captureMask, postRender, renderViewInternal, listRendersInternal, compare,
  // errors + overlays + projection
  reportError, toast, onFrame, wake, worldToScreen, projectPhoto, photoToFloor, floorToPhoto, clientToPhoto, photoToClient,
}
