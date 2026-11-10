// midstudy-add (contract §3; docs/REFACTOR.md §1): a photo, image URL, GLB or OBJ zip → a normalized item in the
// midstudy library, at real-world size. `node pipeline/src/cli.ts`, with exactly v1's arguments, files, lines and exit
// codes: the last stdout line is the JSON summary; every failure is one line on stderr prefixed `midstudy-add: `.
import fs from 'node:fs'
import path from 'node:path'

import { falKey as loadFalKey, falMockDir, mockCost } from '../../common/fal.ts'
import { exists, isDir, isFile, removeTree as rmtree, resolvePath as resolve } from '../../common/files.ts'
import { releaseAllSync } from '../../common/lock.ts'
import { pyFloat } from '../../common/logic/csv.ts'
import { numText, pyFixed as fixed, pyRepr as repr, pyStrip as strip } from '../../common/logic/pyfmt.ts'
import { isSlug, slugify } from '../../common/logic/slug.ts'
import { isoUtc } from '../../common/logic/time.ts'
import { keepPaidOutputs, replaceTogether, swapIn } from './commit.ts'
import { Interrupted, MidstudyError, UnexpectedError, describe } from './errors.ts'
import { type Fal, LiveFal, MockFal, download, run as runEngine, urlBasename } from './fal.ts'
import { copy2, expanduser, mkdtemp } from './fsx.ts'
import { normalize as normalizeGlb, standInBox } from './glb.ts'
import { checkImage, engineInput, makeThumb } from './images.ts'
import { err, out, outRaw } from './io.ts'
import { appendCost, load, locked, prepareUpsert, validate, writeLibrary } from './library.ts'
import { HELP, type Options, parseArgs } from './logic/args.ts'
import { dimsCm, fitValue, itemEntry, summary } from './logic/entry.ts'
import { dimsMetres, spzLine } from './logic/fit.ts'
import { IDENTITY, type Mat3, mul3, orientation, yawRotation } from './logic/frames.ts'
import { MESSAGES, MODEL_EXT, USD_EXT, costUsd, isFalEngine, isUrl, parseDims, pilExt, urlPath } from './logic/inputs.ts'
import { oneLine, pyStr, pyTypeName } from './logic/pyformat.ts'
import { NULL, dict, dumps, entry, get, numeric, plain, set, str, truthy } from './logic/pyjson.ts'
import type { PyValue } from './logic/pyjson.ts'
import { join, name as pathName, normalize as pathNormalize, parent, suffix, withName } from './logic/pypath.ts'
import * as objzip from './objzip.ts'
import * as rug from './rug.ts'
import * as splat from './splat.ts'
import { falStandIn } from './standin.ts'

/** The midstudy checkout (this file is pipeline/src/cli.ts). */
const REPO = path.resolve(import.meta.dirname, '../..')
const MATH = { sqrt: Math.sqrt, cos: Math.cos, sin: Math.sin }

/** Staging folders to remove if the run is interrupted. */
const scratch = new Set<string>()

type StopSignal = 'SIGINT' | 'SIGTERM'

/** Aborted by the first signal of a live paid run: LiveFal's requests and sleeps end with Interrupted. */
const stop = new AbortController()
/** A live fal run, from the engine call until its commit ends: a first signal unwinds it so the cost is recorded. */
let paidRun = false
/** The signal unwinding a paid run. */
let interruptRequested: StopSignal | null = null
/** From the item swap to the cost row: a first signal waits for the section's end. */
let inCommit = false
/** The signal waiting for the commit section to end. */
let pendingSignal: StopSignal | null = null

/** Lets a pending Ctrl-C or SIGTERM in between two steps. The steps run synchronously (the kernels; a mocked fal
 *  answers at once), and Node only sees a signal when its event loop turns: v1's KeyboardInterrupt came between any
 *  two bytecodes. In a live paid run it ends the build with Interrupted, so the paid branch can record the cost. */
function tick(): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      if (interruptRequested === null) resolve()
      else reject(new Interrupted())
    })
  })
}

function say(msg: string): void {
  out(`midstudy-add: ${msg}`)
}

/** `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")`. */
function utcStamp(): string {
  return isoUtc(Date.now())
}

/** v1's `resolve_mock_dir`: MIDSTUDY_FAL_MOCK as a folder (relative to the working directory, then the repo). */
function resolveMockDir(): string | null {
  const value = falMockDir()
  if (value === null) return null
  const p = pathNormalize(expanduser(value))
  const candidates = p.startsWith('/') ? [p] : [join(process.cwd(), p), join(REPO, p)]
  for (const c of candidates) if (isDir(c)) return c
  throw new MidstudyError(MESSAGES.mockNotDir(value))
}

/** v1's `library_dir`: --library (`~` expanded), else <repo>/library; refused when it is something else. */
function libraryDir(o: Options): string {
  const dir = o.library !== null && o.library !== '' ? pathNormalize(expanduser(o.library)) : join(REPO, 'library')
  if (exists(dir) && !isDir(dir)) throw new MidstudyError(MESSAGES.libraryNotDir(dir))
  return dir
}

/** The summary line (`json.dumps`), checked against add-summary.schema.json in strict mode: done before the commit,
 *  so a violation can't report a finished add as a failure. */
async function summaryLine(value: PyValue): Promise<string> {
  await validate('midstudy/add-summary.schema.json', plain(value))
  const d = dumps(value, { indent: null, ensureAscii: true, allowNan: true })
  if (!d.ok) throw new UnexpectedError('ValueError', d.error)
  return d.text
}

/** `{fit['w']}/{fit['d']}/{fit['h']}`. */
function fitText(fit: PyValue): string {
  return ['w', 'd', 'h'].map((k) => {
    const v = get(fit, k)
    return v === undefined ? '' : pyStr(v)
  }).join('/')
}

/** What `shutil.rmtree(p)` refuses (a symbolic link, a file), checked before the commit starts. */
function checkReplaceable(p: string): void {
  if (fs.lstatSync(p).isSymbolicLink()) throw new UnexpectedError('OSError', 'Cannot call rmtree on a symbolic link')
  if (!isDir(p)) throw new UnexpectedError('NotADirectoryError', `[Errno 20] Not a directory: ${repr(p)}`)
}

interface AddPlan {
  readonly o: Options
  readonly libDir: string
  readonly name: string
  readonly id: string
  readonly w: number
  readonly d: number
  readonly h: number
  readonly imageInput: boolean
  readonly resolution: number
  readonly prompt: string
  readonly rawInput: string
  readonly isUrl: boolean
  readonly local: string | null
  readonly mockDir: string | null
  readonly falKey: string | null
}

/** v1's `run`: every argument checked before any work, so bad input never touches the library. */
async function run(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') {
    outRaw(HELP)
    return
  }
  if (parsed.kind === 'error') throw new MidstudyError(`${parsed.message} (see midstudy-add --help)`)
  const o = parsed.options
  if (o.rescale !== null) {
    await rescale(o, o.rescale)
    return
  }
  if (o.input === null) throw new MidstudyError(MESSAGES.needInput)
  if (o.name === null) throw new MidstudyError(MESSAGES.needName)
  const dims = parseDims(o.dims)
  if (!dims.ok) throw new MidstudyError(dims.error)
  const name = strip(o.name)
  if (name === '') throw new MidstudyError(MESSAGES.emptyName)
  let id: string
  if (o.id !== null) {
    id = o.id
    if (!isSlug(id)) throw new MidstudyError(MESSAGES.badId(id))
  } else {
    id = slugify(name)
    if (!isSlug(id)) throw new MidstudyError(MESSAGES.noId(name))
  }
  const engine = o.engine
  const imageEngine = isFalEngine(engine)
  const imageInput = imageEngine || engine === 'rug'
  const resolution = o.resolution ?? 512
  const prompt = o.prompt !== null && o.prompt !== '' ? o.prompt : o.category !== null && o.category !== '' ? o.category : 'furniture'
  if (o.resolution !== null && engine !== 'trellis2') say(`note: --resolution only applies to trellis2; ignored for ${engine}`)
  if (o.prompt !== null && o.prompt !== '' && engine !== 'sam3d') say(`note: --prompt only applies to sam3d; ignored for ${engine}`)

  const rawInput = o.input
  const url = isUrl(rawInput)
  const ext = suffix(url ? urlPath(rawInput) : rawInput).toLowerCase()
  const models: readonly string[] = MODEL_EXT
  const usd: readonly string[] = USD_EXT
  if (usd.includes(ext)) throw new MidstudyError(MESSAGES.usd(ext))
  if (engine === 'glb' && !models.includes(ext) && !(url && ext === '')) throw new MidstudyError(MESSAGES.glbNeedsModel(rawInput))
  if (imageInput && models.includes(ext)) throw new MidstudyError(MESSAGES.modelForImage(ext))

  const mockDir = resolveMockDir()
  let local: string | null = null
  if (url) {
    if (mockDir !== null) throw new MidstudyError(MESSAGES.mockNoNetwork)
  } else {
    local = pathNormalize(expanduser(rawInput))
    if (!isFile(local)) throw new MidstudyError(MESSAGES.notFound(rawInput))
    if (imageInput) checkImage(local)
  }
  // a test's stand-in for fal (pipeline/src/standin.ts) brings its own key: neither FAL_KEY nor .env is read then
  const falKey = imageEngine && mockDir === null ? falStandIn()?.key ?? loadFalKey(REPO) : null
  if (imageEngine && mockDir === null && falKey === null) throw new MidstudyError(MESSAGES.noKey(join(REPO, '.env')))
  // a bad zip is refused before the lock is taken or anything is written
  if (ext === '.zip' && local !== null) objzip.check(local)

  const libDir = libraryDir(o)
  const plan: AddPlan = { o, libDir, name, id, w: dims.w, d: dims.d, h: dims.h, imageInput, resolution, prompt, rawInput, isUrl: url, local, mockDir, falKey }
  // the whole run holds the library lock (§2.8 "one writer")
  await locked(libDir, () => add(plan))
}

/** The first 4 bytes of a file. */
function head4(file: string): string {
  const buf = new Uint8Array(4)
  const fd = fs.openSync(file, 'r')
  try {
    const n = fs.readSync(fd, buf, 0, 4, 0)
    return Buffer.from(buf.subarray(0, n)).toString('latin1')
  } finally {
    fs.closeSync(fd)
  }
}

/** v1's `add`: the item is built in a staging folder and moves into the library only after its self-checks pass. */
async function add(p: AddPlan): Promise<void> {
  const { o, libDir, id, w, d, h } = p
  const engine = o.engine
  load(libDir) // v1's early refusal of a file that isn't a version 1 library; the commit reads it afresh
  // library.json and costs.csv are tracked in git and library.json is served: a local file is recorded by its name
  // only (no home-folder path), a URL as given; serve.py passes the upload's own name
  const sourceInput = o.sourceInput !== null && o.sourceInput !== '' ? o.sourceInput : p.isUrl ? p.rawInput : pathName(p.rawInput)
  const mock = p.mockDir !== null
  const cost = !mock || mockCost() ? costUsd(engine, p.resolution) : 0.0
  const staging = mkdtemp(`midstudy-add-${id}-`)
  scratch.add(staging)
  let fal: Fal | null = null
  // where the new item's files are while they aren't in the library yet (null: at the item's final name)
  let outputs: string | null = staging
  let costRecorded = false
  let local = p.local ?? ''
  let sourceName = ''
  let hasSplat = false
  let glbFit: PyValue = NULL
  let splatFit: PyValue | null = null
  let line = ''
  const itemDir = join(libDir, id)
  try {
    if (p.isUrl) {
      const dl = path.join(staging, 'download')
      fs.mkdirSync(dl)
      local = await download(p.rawInput, path.join(dl, urlBasename(p.rawInput)))
      await tick()
    }
    let ext = suffix(local).toLowerCase()
    if (p.imageInput) {
      const fmt = checkImage(local)
      if (ext === '') ext = pilExt(fmt)
    } else if (ext === '') {
      ext = head4(local) === 'glTF' ? '.glb' : '.gltf'
    }
    sourceName = `source${ext}`
    copy2(local, path.join(staging, sourceName))
    if (ext === '.zip') {
      local = await objzip.toGlb(local, path.join(staging, 'unzipped'), path.join(staging, 'converted.glb'))
      await tick()
      ext = '.glb'
    }
    if (p.imageInput) {
      // the engines and the thumbnail get a metadata-free, upright copy (raw/engine-input.<ext>); source.<ext> keeps
      // the original as given and is never served (contract §2.8)
      local = await engineInput(local, path.join(staging, 'raw'))
      await tick()
    }

    let modelSrc: string | null = local
    let splatSrc: string | null = null
    let splatToGlb: Mat3 = IDENTITY
    let thumbSrc = local
    if (engine === 'rug') {
      say(`rug ($0, no model call): ${p.rawInput}`)
      thumbSrc = path.join(staging, 'raw', 'rug-texture.jpg')
      modelSrc = path.join(staging, 'raw', 'rug.glb')
      for (const n of await rug.build(local, w, d, h, modelSrc, thumbSrc)) say(`note: ${n}`)
      await tick()
    } else if (isFalEngine(engine)) {
      fal = mock ? new MockFal(p.mockDir) : new LiveFal(p.falKey ?? '', falStandIn()?.fetch ?? fetch, undefined, Date.now, stop.signal)
      say(`${engine}${mock ? ' (mock, $0)' : ` ($${fixed(cost, 2)})`}: ${p.rawInput}`)
      paidRun = !mock
      const engineOutputs = await runEngine(fal, engine, local, p.prompt, p.resolution, path.join(staging, 'raw'))
      await tick()
      modelSrc = engineOutputs.glb
      splatSrc = engineOutputs.splat
      splatToGlb = engineOutputs.splatToGlb
    } else if (ext === '.gltf') {
      say('note: a .gltf input is packed into a single GLB; source.gltf is kept without its side files')
    }

    const dims = dimsMetres(w, d, h)
    if (modelSrc === null) {
      // a splat-only engine (idol): model.glb is a stand-in box exactly at --dims, never drawn (contract §1)
      glbFit = await standInBox(dims, path.join(staging, 'model.glb'))
      say(`model.glb is a stand-in box at ${numText(w)} x ${numText(d)} x ${numText(h)} cm (${engine} makes a splat only)`)
    } else {
      glbFit = await normalizeGlb(modelSrc, orientation(engine, 'glb', o.yaw, MATH) ?? IDENTITY, dims, path.join(staging, 'model.glb'), MATH)
      say(`model.glb fit to ${numText(w)} x ${numText(d)} x ${numText(h)} cm (error % w/d/h: ${fitText(glbFit)})`)
    }
    await tick()
    if (splatSrc !== null) {
      hasSplat = true
      const rotation = mul3(orientation(engine, 'splat', o.yaw, MATH) ?? IDENTITY, splatToGlb)
      const r = splat.normalize(splatSrc, rotation, dims, path.join(staging, 'splat.ply'), engine)
      splatFit = r.fit
      for (const n of r.notes) say(`note: ${n}`)
      say(`splat.ply fitted per axis to ${numText(w)} x ${numText(d)} x ${numText(h)} cm (error % w/d/h: ${fitText(r.fit)})`)
      await tick()
      const spz = splat.writeSpz(path.join(staging, 'splat.ply'), path.join(staging, 'splat.spz'))
      say(spzLine(spz.count, spz.bytes, spz.dropped))
      await tick()
    }
    if (p.imageInput) makeThumb(thumbSrc, path.join(staging, 'thumb.jpg'))
    await tick()
    // v1: shutil.rmtree / unlink, which raise (the staging folder's own scratch: an error here is a real one)
    for (const s of ['download', 'unzipped', 'converted.glb', 'converted.jpg']) rmtree(path.join(staging, s), false)

    // prepare: every refusal comes before anything in the library changes
    const created = utcStamp()
    fs.mkdirSync(libDir, { recursive: true })
    // re-running on this item's own raw output (e.g. to fix --yaw): keep those raw files
    const hasOld = exists(itemDir)
    if (hasOld) checkReplaceable(itemDir)
    const carryRaw = hasOld && isDir(path.join(itemDir, 'raw')) && !exists(path.join(staging, 'raw')) && resolve(p.rawInput).startsWith(`${resolve(itemDir)}/`)
    const item = itemEntry({
      id, name: p.name, category: o.category, w, d, h, splat: hasSplat, thumb: p.imageInput, engine,
      sourceInput, prompt: p.prompt, cost, mock, created, glbFit, splatFit, notes: o.notes, mount: o.mount,
    })
    const prepared = await prepareUpsert(libDir, item)
    line = await summaryLine(summary(id, engine, cost, mock, {
      library: join(libDir, 'library.json'),
      item: itemDir,
      glb: join(itemDir, 'model.glb'),
      splat: hasSplat ? join(itemDir, 'splat.ply') : null,
      spz: hasSplat ? join(itemDir, 'splat.spz') : null,
      thumb: p.imageInput ? join(itemDir, 'thumb.jpg') : null,
      source: join(itemDir, sourceName),
      raw: carryRaw || isDir(path.join(staging, 'raw')) ? join(itemDir, 'raw') : null,
      costs: join(libDir, 'costs.csv'),
    }, fitValue(glbFit, splatFit)))
    await tick()

    // commit: the item folder, then library.json, then costs.csv
    inCommit = true
    const swap = swapIn(staging, itemDir, libDir, carryRaw)
    if (!swap.ok) {
      outputs = swap.outputs
      throw swap.error
    }
    outputs = null
    scratch.delete(staging)
    try {
      writeLibrary(libDir, prepared.text)
    } catch (e) {
      outputs = swap.undo()
      throw e
    }
    // a second signal during the wait for the costs lock exits at once: the old item must not stay behind then
    if (swap.aside !== null) scratch.add(swap.aside)
    say(prepared.replaced ? `replaced existing item '${id}' in ${join(libDir, 'library.json')}` : `added '${id}' to ${join(libDir, 'library.json')}`)
    try {
      await appendCost(libDir, created, id, engine, cost, mock, sourceInput)
      costRecorded = true
    } finally {
      swap.finish()
      if (swap.aside !== null) scratch.delete(swap.aside)
    }
  } catch (e) {
    if (fal === null || fal.mock || !fal.charged || costRecorded) throw e
    // a live call was paid for: keep its outputs for a free `--engine glb` retry, and record the cost
    const stamp = utcStamp()
    const { kept, problems } = await keepPaidOutputs(outputs, libDir, id, stamp, () => appendCost(libDir, stamp, id, engine, cost, mock, sourceInput))
    if (kept !== null) outputs = null
    const recorded = problems.some((t) => t.startsWith('the cost row')) ? '' : `$${fixed(cost, 2)} recorded in costs.csv`
    const where = kept !== null ? `engine outputs kept in ${join(kept, 'raw')}` : ''
    const details = [recorded, where, ...problems].filter((t) => t !== '').join('; ')
    if (e instanceof Interrupted || interruptRequested !== null) {
      say(details)
      throw new Interrupted()
    }
    const msg = e instanceof MidstudyError ? e.message : `unexpected error (${describe(e)})`
    throw new MidstudyError(`${msg} (${details})`)
  } finally {
    if (outputs !== null && outputs !== staging && exists(outputs)) rmtree(outputs)
    if (exists(staging)) rmtree(staging)
    scratch.delete(staging)
    paidRun = false
    leaveCommit()
  }

  out(line)
}

/** `float(v)` of a dims_cm value as v1 reads it (numbers, bools, numeric strings), or null where that raises. */
function asFloat(v: PyValue | undefined): number | null {
  if (v === undefined) return null
  if (v.kind === 'str') return pyFloat(v.value)
  return numeric(v)
}

/** `(d.get(key) or {})`: a dict, or {} for a falsy value; anything else has no `.get` (AttributeError). */
function dictOrEmpty(v: PyValue | undefined): PyValue {
  if (v === undefined || !truthy(v)) return dict([])
  if (v.kind !== 'dict') throw new UnexpectedError('AttributeError', `'${pyTypeName(v)}' object has no attribute 'get'`)
  return v
}

interface Dims {
  readonly w: number
  readonly d: number
  readonly h: number
}

/** v1's `rescale`: refits an existing item's normalized assets to new dims and/or a relative yaw; no engine, $0. */
async function rescale(o: Options, id: string): Promise<void> {
  if (!isSlug(id)) throw new MidstudyError(`--rescale needs an item id (a slug like 'reading-chair'), got '${id}'`)
  if (o.input !== null) throw new MidstudyError("--rescale refits the item's own assets: drop INPUT (to replace the model, add it again)")
  let newDims: Dims | null = null
  if (o.dims !== null) {
    const parsed = parseDims(o.dims)
    if (!parsed.ok) throw new MidstudyError(parsed.error)
    newDims = parsed
  }
  const libDir = libraryDir(o)
  if (!isFile(join(libDir, 'library.json'))) throw new MidstudyError(`no library at ${libDir}: --rescale only works on an existing item`)
  out(await locked(libDir, () => refit(o, id, libDir, newDims)))
}

/** The part of `rescale` under the library lock; returns the summary line, validated before anything was replaced. */
async function refit(o: Options, id: string, libDir: string, newDims: Dims | null): Promise<string> {
  const data = load(libDir)
  const items = get(data, 'items')
  const found = items?.kind === 'list' ? items.items.find((it) => {
    const v = get(it, 'id')
    return v?.kind === 'str' && v.value === id
  }) : undefined
  if (found === undefined) throw new MidstudyError(`no item '${id}' in ${join(libDir, 'library.json')}: check the id (midstudy-add --rescale ID)`)
  const dc = get(found, 'dims_cm')
  const [w0, d0, h0] = (['w', 'd', 'h'] as const).map((k) => asFloat(dc?.kind === 'dict' ? get(dc, k) : undefined))
  if (w0 === null || d0 === null || h0 === null || w0 === undefined || d0 === undefined || h0 === undefined) {
    throw new MidstudyError(`item '${id}' has no valid dims_cm; pass --dims WxDxH`)
  }
  const { w, d, h } = newDims ?? { w: w0, d: d0, h: h0 }
  // the splat's extent percentiles depend on the engine (§1)
  const source = dictOrEmpty(get(found, 'source'))
  const assets = dictOrEmpty(get(found, 'assets'))
  const engineV = get(source, 'engine')
  const engine = engineV?.kind === 'str' ? engineV.value : null
  const glbRel = get(assets, 'glb')
  const glbSrc = join(libDir, glbRel !== undefined && truthy(glbRel) ? pyStr(glbRel) : `${id}/model.glb`)
  const splatRel = get(assets, 'splat')
  let splatSrc: string | null = null
  let spzRel: string | null = null
  if (splatRel !== undefined && truthy(splatRel)) {
    if (splatRel.kind !== 'str') throw new UnexpectedError('TypeError', `unsupported operand type(s) for /: 'PosixPath' and '${pyTypeName(splatRel)}'`)
    splatSrc = join(libDir, splatRel.value)
    if (pathName(splatRel.value) === '') throw new UnexpectedError('ValueError', `PurePosixPath(${repr(pathNormalize(splatRel.value))}) has an empty name`)
    spzRel = withName(splatRel.value, 'splat.spz')
  }
  const spzDst = spzRel === null ? null : join(libDir, spzRel)
  if (!isFile(glbSrc)) throw new MidstudyError(`item '${id}' has no model file at ${glbSrc}; add it again instead`)
  if (splatSrc !== null && !isFile(splatSrc)) throw new MidstudyError(`item '${id}' lists a splat at ${splatSrc} that isn't there; add it again instead`)

  // the assets are in the item frame already: only the relative turn is left
  const rotation = yawRotation(o.yaw, MATH)
  const dims = dimsMetres(w, d, h)
  const staging = mkdtemp(`midstudy-rescale-${id}-`)
  scratch.add(staging)
  let splatFit: PyValue | null = null
  try {
    const glbFit = await normalizeGlb(glbSrc, rotation, dims, path.join(staging, 'model.glb'), MATH)
    say(`model.glb refit to ${numText(w)} x ${numText(d)} x ${numText(h)} cm, yaw +${String(o.yaw)} (error % w/d/h: ${fitText(glbFit)})`)
    await tick()
    if (splatSrc !== null) {
      const r = splat.normalize(splatSrc, rotation, dims, path.join(staging, 'splat.ply'), engine)
      splatFit = r.fit
      for (const n of r.notes) say(`note: ${n}`)
      say(`splat.ply refit per axis (error % w/d/h: ${fitText(r.fit)})`)
      await tick()
      const spz = splat.writeSpz(path.join(staging, 'splat.ply'), path.join(staging, 'splat.spz'))
      say(spzLine(spz.count, spz.bytes, spz.dropped))
      await tick()
    }
    let item = set(found, 'dims_cm', dimsCm(w, d, h))
    if (spzRel !== null) {
      // every splat.ply has its splat.spz beside it (§1): an item from before v1.1 gains one here
      const known = ['glb', 'splat', 'spz', 'thumb']
      item = set(item, 'assets', dict([
        entry('glb', get(assets, 'glb') ?? NULL),
        entry('splat', get(assets, 'splat') ?? NULL),
        entry('spz', str(spzRel)),
        entry('thumb', get(assets, 'thumb') ?? NULL),
        ...(assets.kind === 'dict' ? assets.entries.filter((e) => !known.includes(e.key)) : []),
      ]))
    }
    item = set(item, 'fit', fitValue(glbFit, splatFit))
    const prepared = await prepareUpsert(libDir, item)
    const thumb = get(assets, 'thumb')
    const itemDir = parent(glbSrc)
    const line = await summaryLine(summary(id, 'rescale', 'int-zero', resolveMockDir() !== null, {
      library: join(libDir, 'library.json'),
      item: itemDir,
      glb: glbSrc,
      splat: splatSrc,
      spz: spzDst,
      thumb: thumb !== undefined && truthy(thumb) ? join(libDir, pyStr(thumb)) : null,
      source: null,
      raw: isDir(join(itemDir, 'raw')) ? join(itemDir, 'raw') : null,
      costs: join(libDir, 'costs.csv'),
    }, fitValue(glbFit, splatFit)))
    await tick()

    // commit: every file passed its self-check. No await from here to the end of the library write, so no signal can
    // land in between (a handler only runs when the event loop turns).
    replaceTogether([
      { from: path.join(staging, 'model.glb'), to: glbSrc },
      ...(splatSrc !== null && spzDst !== null ? [
        { from: path.join(staging, 'splat.ply'), to: splatSrc },
        { from: path.join(staging, 'splat.spz'), to: spzDst },
      ] : []),
    ], () => { writeLibrary(libDir, prepared.text) })
    say(`refit '${id}' in ${join(libDir, 'library.json')} ($0, no cost row)`)
    return line
  } finally {
    rmtree(staging)
    scratch.delete(staging)
  }
}

/** Releases the locks and removes the staging folders (an interrupt). */
function cleanUp(): void {
  releaseAllSync()
  for (const s of scratch) rmtree(s)
  scratch.clear()
}

/** Today's answer to a signal: release everything and leave. SIGINT exits 130 with the one line; SIGTERM dies of the
 *  signal (v1 did: its flock went with it). */
function exitNow(signal: StopSignal): void {
  cleanUp()
  if (signal === 'SIGINT') {
    err('midstudy-add: interrupted')
    process.exit(130)
  }
  process.removeAllListeners('SIGTERM')
  process.kill(process.pid, 'SIGTERM')
}

/** The end of the commit section: a signal that waited for it is acted on now. */
function leaveCommit(): void {
  inCommit = false
  if (pendingSignal !== null) exitNow(pendingSignal)
}

/** One signal policy: in the commit section a first signal waits for the section's end; in a live paid run it unwinds
 *  so the cost is recorded; anywhere else, and for any second signal, the process leaves at once. */
function onSignal(signal: StopSignal): void {
  if (pendingSignal !== null || interruptRequested !== null) {
    exitNow(signal)
  } else if (inCommit) {
    pendingSignal = signal
  } else if (paidRun) {
    interruptRequested = signal
    stop.abort()
  } else {
    exitNow(signal)
  }
}

/** v1's `main`: the run, its one-line failures and exit codes (1; 130 when interrupted). */
async function main(argv: readonly string[]): Promise<void> {
  process.on('SIGINT', () => { onSignal('SIGINT') })
  process.on('SIGTERM', () => { onSignal('SIGTERM') })
  try {
    await run(argv)
  } catch (e) {
    if (e instanceof Interrupted) {
      exitNow(interruptRequested ?? 'SIGINT')
    } else if (e instanceof MidstudyError) {
      err(`midstudy-add: ${oneLine(e.message)}`)
    } else {
      if ((process.env['MIDSTUDY_DEBUG'] ?? '') !== '') err(e instanceof Error ? e.stack ?? String(e) : String(e))
      err(`midstudy-add: unexpected error (${oneLine(describe(e))}); re-run with MIDSTUDY_DEBUG=1 for a traceback`)
    }
    process.exitCode = 1
  }
}

await main(process.argv.slice(2))
