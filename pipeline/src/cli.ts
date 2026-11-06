// midstudy-add (contract §3; docs/REFACTOR.md §1): a photo, image URL, GLB or OBJ zip → a normalized item in the
// midstudy library, at real-world size. `node pipeline/src/cli.ts`, with exactly v1's arguments, files, lines and exit
// codes: the last stdout line is the JSON summary; every failure is one line on stderr prefixed `midstudy-add: `.
import fs from 'node:fs'
import path from 'node:path'

import { MidstudyError, UnexpectedError, describe } from './errors.ts'
import { type Fal, LiveFal, MockFal, download, loadFalKey, run as runEngine, urlBasename } from './fal.ts'
import { copy2, exists, expanduser, isDir, isFile, mkdtemp, move, replace, resolve, rmtree } from './fsx.ts'
import { normalize as normalizeGlb, standInBox } from './glb.ts'
import { checkImage, engineInput, makeThumb } from './images.ts'
import { err, out, outRaw } from './io.ts'
import { appendCost, load, locked, upsert, validate } from './library.ts'
import { releaseAll } from './lock.ts'
import { HELP, type Options, parseArgs } from './logic/args.ts'
import { dimsCm, fitValue, itemEntry, summary } from './logic/entry.ts'
import { dimsMetres, spzLine } from './logic/fit.ts'
import { IDENTITY, type Mat3, mul3, orientation, yawRotation } from './logic/frames.ts'
import { MESSAGES, MODEL_EXT, USD_EXT, costUsd, isFalEngine, isSlug, isUrl, parseDims, pilExt, slugify, urlPath } from './logic/inputs.ts'
import { fixed, numText, oneLine, pyFloat, pyStr, pyTypeName, repr, strip } from './logic/pyformat.ts'
import { NULL, dict, dumps, entry, get, numeric, plain, set, str, truthy } from './logic/pyjson.ts'
import type { PyValue } from './logic/pyjson.ts'
import { join, name as pathName, normalize as pathNormalize, parent, suffix, withName } from './logic/pypath.ts'
import * as objzip from './objzip.ts'
import * as rug from './rug.ts'
import * as splat from './splat.ts'

/** The midstudy checkout (this file is pipeline/src/cli.ts). */
const REPO = path.resolve(import.meta.dirname, '../..')
const MATH = { sqrt: Math.sqrt, cos: Math.cos, sin: Math.sin }

/** Staging folders to remove if the run is interrupted. */
const scratch = new Set<string>()

/** Lets a pending Ctrl-C or SIGTERM in between two steps. The steps run synchronously (the kernels; a mocked fal
 *  answers at once), and Node only sees a signal when its event loop turns: v1's KeyboardInterrupt came between any
 *  two bytecodes. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

function say(msg: string): void {
  out(`midstudy-add: ${msg}`)
}

/** `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")`. */
function utcStamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`
}

/** v1's `resolve_mock_dir`: MIDSTUDY_FAL_MOCK as a folder (relative to the working directory, then the repo). */
function resolveMockDir(): string | null {
  const value = process.env['MIDSTUDY_FAL_MOCK'] ?? ''
  if (value === '') return null
  const p = pathNormalize(expanduser(value))
  const candidates = p.startsWith('/') ? [p] : [join(process.cwd(), p), join(REPO, p)]
  for (const c of candidates) if (isDir(c)) return c
  throw new MidstudyError(MESSAGES.mockNotDir(value))
}

/** MIDSTUDY_FAL_MOCK_COST=1 (evals only): mock runs record the engine's real price, to test the spend cap. */
function mockCost(): boolean {
  const v = process.env['MIDSTUDY_FAL_MOCK_COST'] ?? ''
  return v !== '' && v !== '0'
}

/** v1's `library_dir`: --library (`~` expanded), else <repo>/library; refused when it is something else. */
function libraryDir(o: Options): string {
  const dir = o.library !== null && o.library !== '' ? pathNormalize(expanduser(o.library)) : join(REPO, 'library')
  if (exists(dir) && !isDir(dir)) throw new MidstudyError(MESSAGES.libraryNotDir(dir))
  return dir
}

/** The summary line (`json.dumps`), checked against add-summary.schema.json in strict mode. */
async function printSummary(value: PyValue): Promise<void> {
  await validate('midstudy/add-summary.schema.json', plain(value))
  const d = dumps(value, { indent: null, ensureAscii: true, allowNan: true })
  if (!d.ok) throw new UnexpectedError('ValueError', d.error)
  out(d.text)
}

/** `{fit['w']}/{fit['d']}/{fit['h']}`. */
function fitText(fit: PyValue): string {
  return ['w', 'd', 'h'].map((k) => {
    const v = get(fit, k)
    return v === undefined ? '' : pyStr(v)
  }).join('/')
}

/** `shutil.rmtree(p)`, which refuses a symbolic link and a file. */
function rmtreeChecked(p: string): void {
  if (fs.lstatSync(p).isSymbolicLink()) throw new UnexpectedError('OSError', 'Cannot call rmtree on a symbolic link')
  if (!isDir(p)) throw new UnexpectedError('NotADirectoryError', `[Errno 20] Not a directory: ${repr(p)}`)
  rmtree(p)
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
    id = slugify(name, (s) => s.normalize('NFKD'))
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
  const falKey = imageEngine && mockDir === null ? loadFalKey(REPO) : null
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
  const data = load(libDir)
  // library.json and costs.csv are tracked in git and library.json is served: a local file is recorded by its name
  // only (no home-folder path), a URL as given; serve.py passes the upload's own name
  const sourceInput = o.sourceInput !== null && o.sourceInput !== '' ? o.sourceInput : p.isUrl ? p.rawInput : pathName(p.rawInput)
  const mock = p.mockDir !== null
  const cost = !mock || mockCost() ? costUsd(engine, p.resolution) : 0.0
  const staging = mkdtemp(`midstudy-add-${id}-`)
  scratch.add(staging)
  let fal: Fal | null = null
  let committed = false
  let local = p.local ?? ''
  let sourceName = ''
  let hasSplat = false
  let glbFit: PyValue = NULL
  let splatFit: PyValue | null = null
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
      fal = mock ? new MockFal(p.mockDir) : new LiveFal(p.falKey ?? '')
      say(`${engine}${mock ? ' (mock, $0)' : ` ($${fixed(cost, 2)})`}: ${p.rawInput}`)
      const outputs = await runEngine(fal, engine, local, p.prompt, p.resolution, path.join(staging, 'raw'))
      await tick()
      modelSrc = outputs.glb
      splatSrc = outputs.splat
      splatToGlb = outputs.splatToGlb
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
    for (const s of ['download', 'unzipped', 'converted.glb', 'converted.jpg']) rmtree(path.join(staging, s))

    // commit: the item folder, then library.json, then costs.csv
    const created = utcStamp()
    fs.mkdirSync(libDir, { recursive: true })
    if (exists(itemDir)) {
      // re-running on this item's own raw output (e.g. to fix --yaw): keep those raw files
      const oldRaw = path.join(itemDir, 'raw')
      if (isDir(oldRaw) && !exists(path.join(staging, 'raw')) && resolve(p.rawInput).startsWith(`${resolve(itemDir)}/`)) {
        move(oldRaw, path.join(staging, 'raw'))
      }
      rmtreeChecked(itemDir)
    }
    move(staging, itemDir)
    scratch.delete(staging)
    committed = true

    const item = itemEntry({
      id, name: p.name, category: o.category, w, d, h, splat: hasSplat, thumb: p.imageInput, engine,
      sourceInput, prompt: p.prompt, cost, mock, created, glbFit, splatFit, notes: o.notes, mount: o.mount,
    })
    const up = await upsert(libDir, data, item)
    say(up.replaced ? `replaced existing item '${id}' in ${join(libDir, 'library.json')}` : `added '${id}' to ${join(libDir, 'library.json')}`)
    await appendCost(libDir, created, id, engine, cost, mock, sourceInput)
  } catch (e) {
    if (fal === null || fal.mock || !fal.charged || committed) throw e
    // a live call was paid for: record the cost, and keep its outputs for a free `--engine glb` retry
    const stamp = utcStamp()
    fs.mkdirSync(libDir, { recursive: true })
    await appendCost(libDir, stamp, id, engine, cost, mock, sourceInput)
    const kept = join(join(libDir, '_failed'), `${id}-${stamp.replaceAll(':', '')}`)
    if (!isDir(parent(kept))) fs.mkdirSync(parent(kept))
    move(staging, kept)
    scratch.delete(staging)
    const msg = e instanceof MidstudyError ? e.message : `unexpected error (${describe(e)})`
    throw new MidstudyError(`${msg} ($${fixed(cost, 2)} recorded in costs.csv; engine outputs kept in ${join(kept, 'raw')})`)
  } finally {
    if (exists(staging)) rmtree(staging)
    scratch.delete(staging)
  }

  await printSummary(summary(id, engine, cost, mock, {
    library: join(libDir, 'library.json'),
    item: itemDir,
    glb: join(itemDir, 'model.glb'),
    splat: hasSplat ? join(itemDir, 'splat.ply') : null,
    spz: hasSplat ? join(itemDir, 'splat.spz') : null,
    thumb: p.imageInput ? join(itemDir, 'thumb.jpg') : null,
    source: join(itemDir, sourceName),
    raw: isDir(join(itemDir, 'raw')) ? join(itemDir, 'raw') : null,
    costs: join(libDir, 'costs.csv'),
  }, fitValue(glbFit, splatFit)))
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
  const r = await locked(libDir, () => refit(o, id, libDir, newDims))
  const thumb = get(r.assets, 'thumb')
  const itemDir = parent(r.glbSrc)
  await printSummary(summary(id, 'rescale', 'int-zero', resolveMockDir() !== null, {
    library: join(libDir, 'library.json'),
    item: itemDir,
    glb: r.glbSrc,
    splat: r.splatSrc,
    spz: r.spzDst,
    thumb: thumb !== undefined && truthy(thumb) ? join(libDir, pyStr(thumb)) : null,
    source: null,
    raw: isDir(join(itemDir, 'raw')) ? join(itemDir, 'raw') : null,
    costs: join(libDir, 'costs.csv'),
  }, fitValue(r.glbFit, r.splatFit)))
}

interface Refit {
  readonly assets: PyValue
  readonly glbSrc: string
  readonly splatSrc: string | null
  readonly spzDst: string | null
  readonly glbFit: PyValue
  readonly splatFit: PyValue | null
}

/** The part of `rescale` under the library lock. */
async function refit(o: Options, id: string, libDir: string, newDims: Dims | null): Promise<Refit> {
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
  let glbFit: PyValue
  let splatFit: PyValue | null = null
  try {
    glbFit = await normalizeGlb(glbSrc, rotation, dims, path.join(staging, 'model.glb'), MATH)
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
    // commit: every file passed its self-check, so they are replaced in place
    replace(path.join(staging, 'model.glb'), glbSrc)
    if (splatSrc !== null && spzDst !== null) {
      replace(path.join(staging, 'splat.ply'), splatSrc)
      replace(path.join(staging, 'splat.spz'), spzDst)
    }
  } finally {
    rmtree(staging)
    scratch.delete(staging)
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
  await upsert(libDir, data, item)
  say(`refit '${id}' in ${join(libDir, 'library.json')} ($0, no cost row)`)
  return { assets, glbSrc, splatSrc, spzDst, glbFit, splatFit }
}

/** Releases the locks and removes the staging folders (an interrupt). */
function cleanUp(): void {
  releaseAll()
  for (const s of scratch) rmtree(s)
  scratch.clear()
}

/** v1's `main`: the run, its one-line failures and exit codes (1; 130 when interrupted). */
async function main(argv: readonly string[]): Promise<void> {
  process.on('SIGINT', () => {
    cleanUp()
    err('midstudy-add: interrupted')
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    // v1 died of the signal (its flock went with it): clean up, then die of it too
    cleanUp()
    process.removeAllListeners('SIGTERM')
    process.kill(process.pid, 'SIGTERM')
  })
  try {
    await run(argv)
  } catch (e) {
    if (e instanceof MidstudyError) {
      err(`midstudy-add: ${oneLine(e.message)}`)
    } else {
      if ((process.env['MIDSTUDY_DEBUG'] ?? '') !== '') err(e instanceof Error ? e.stack ?? String(e) : String(e))
      err(`midstudy-add: unexpected error (${oneLine(describe(e))}); re-run with MIDSTUDY_DEBUG=1 for a traceback`)
    }
    process.exitCode = 1
  }
}

await main(process.argv.slice(2))
