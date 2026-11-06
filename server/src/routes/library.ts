// The library API (contract §2.8, §2.9; v1 planner/serve.py: get_library, post_library_upload, post_library_from_url,
// queue_add, patch_library_item, put_library_thumb, delete_library_item, restore_library_item, and the library job
// routes of handle_api_get). The patterns are v1's, in v1's order; POST /api/library/product is the product track's
// (server/src/product/route.ts). Every check runs in v1's order with v1's sentence; library writes take the v2 library
// lock for at most 60 s (then Busy: the dispatcher answers 503); adds go to the one job queue (server/src/library/).
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { decodeImageDataUri, decodeMeta, jpegFrame, photoExt, sniff, stripJpeg } from '../../../core/js/node.ts'
import { countsAgainstCap } from '../../../common/fal.ts'
import { atomicWrite, isDir, makeTempDir, move, removeTree, resolvePath } from '../../../common/files.ts'
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import { isSlug } from '../../../common/logic/slug.ts'
import { isoUtc } from '../../../common/logic/time.ts'
import type { ServerDeps } from '../deps.ts'
import { FetchError, fetchImage } from '../fetch.ts'
import type { RequestContext } from '../http/context.ts'
import type { RouteModule } from '../http/router.ts'
import { isRecord, plain, pyValue, pyValueFromText } from '../library/json.ts'
import { addArgv, checkMeta, rescaleArgv, type AddMeta } from '../library/logic/meta.ts'
import { existsAgain, noFolder, noItem, noJob, noTrashed, notInTrash, QUEUED, queuedMessage, THUMB_NOT_JPEG, THUMB_TOO_LARGE, trashName } from '../library/logic/messages.ts'
import { checkPatch, needsRefit, patchShape } from '../library/logic/patch.ts'
import type { PyValue } from '../library/logic/pyvalue.ts'
import {
  EMPTY_FILE, extProblem, FILENAME_REQUIRED, FROM_URL_SHAPE, KIND_REQUIRED, LENGTH_REQUIRED, LINK_NOT_IMAGE, META_REQUIRED, NOT_GLB, NOT_IMAGE, sizeLimit, STOPPED,
  suffixOf, tooLarge, uploadFilename, uploadKind,
} from '../library/logic/upload.ts'
import { currentDims, findItem, getOr, itemFacts, itemsOf, LibraryService, PyError, readDocument } from '../library/service.ts'
import { zipProblem } from '../library/zip.ts'

/** v1 MAX_THUMB: a thumbnail JPEG may be 2 MiB. */
const MAX_THUMB = 2 * 1024 * 1024
/** How much of an upload sniff() reads. */
const HEAD_BYTES = 64

/** An answer decided inside the lock, sent once it is released. */
interface Answer {
  readonly status: number
  readonly body: unknown
}

function answer(status: number, error: string): Answer {
  return { status, body: { error } }
}

/** A check of an upload's bytes failed: 400 with v1's sentence (v1 raised ValueError). */
class UploadRefused extends Error {}

/** The first bytes of a file. */
async function head(file: string): Promise<Buffer> {
  const handle = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** A JPEG, PNG, HEIC/HEIF or WebP by its magic bytes (the media kernel's sniff, the rule calib reads uploads with). */
function isPhoto(bytes: Uint8Array): boolean {
  return photoExt(sniff(bytes)) !== null
}

/** X-Midstudy-Meta: base64 of a JSON object, read with Python's int and float (v1 `json.loads(b64decode(…))`); null
 *  when it is anything else. */
function metaOf(header: string | undefined): PyValue | null {
  const text = decodeMeta(header ?? '')
  if (!text.ok) return null
  const value = pyValueFromText(text.value)
  return value?.kind === 'dict' ? value : null
}

/** v1 `queue_add`: 202 `{job, cost_usd_estimate}`, or 402 when the cap refuses it. The job owns (and removes) `tmp`;
 *  a from-URL add hands over the reservation it held while downloading. */
async function queueAdd(ctx: RequestContext, library: LibraryService, deps: ServerDeps, src: string, tmp: string, meta: AddMeta, label: string, reservedKey: string | null): Promise<void> {
  const exists = findItem(itemsOf(library.readPlain()), meta.id) !== null
  const reserve = countsAgainstCap() ? meta.estimate : 0
  if (reservedKey !== null) deps.spend.release(reservedKey)
  const argv = addArgv(deps.config.midstudyAdd, resolvePath(src), library.libraryArg(), label, meta)
  const queued = library.newJob('add', meta.id, meta.engine, meta.estimate, argv, tmp, reserve, queuedMessage(exists, meta.id))
  if ('refused' in queued) {
    removeTree(tmp)
    await ctx.send(402, queued.refused)
    return
  }
  await ctx.send(202, { job: queued.job, cost_usd_estimate: meta.estimate })
}

/** POST /api/library/items: a raw-body upload (§2.8 Bodies, Limits). */
async function postUpload(ctx: RequestContext, library: LibraryService, deps: ServerDeps): Promise<void> {
  const kind = uploadKind(ctx.header('x-midstudy-kind'))
  if (kind === null) return ctx.error(400, KIND_REQUIRED)
  const filename = uploadFilename(ctx.header('x-midstudy-filename'))
  if (filename === '') return ctx.error(400, FILENAME_REQUIRED)
  const metaValue = metaOf(ctx.header('x-midstudy-meta'))
  if (metaValue === null) return ctx.error(400, META_REQUIRED)
  const ext = suffixOf(filename)
  const badExt = extProblem(kind, ext)
  if (badExt !== null) return ctx.error(400, badExt)
  const meta = checkMeta(metaValue, kind)
  if (!meta.ok) return ctx.error(400, meta.error)
  const length = ctx.contentLength
  if (ctx.chunked || length === null) {
    ctx.closeConnection()
    return ctx.error(411, LENGTH_REQUIRED)
  }
  if (length > sizeLimit(kind)) return ctx.error(413, tooLarge(kind, length))
  if (length === 0) return ctx.error(400, EMPTY_FILE)
  const tmp = await makeTempDir('midstudy-upload-') // private, never under a served path
  const src = path.join(tmp, 'upload' + ext)
  try {
    if (await ctx.readBodyTo(src, length) < length) throw new UploadRefused(STOPPED)
    const first = await head(src)
    if (kind === 'image' && !isPhoto(first)) throw new UploadRefused(NOT_IMAGE)
    if (ext === '.glb' && first.subarray(0, 4).toString('latin1') !== 'glTF') throw new UploadRefused(NOT_GLB)
    if (ext === '.zip') {
      const problem = await zipProblem(src)
      if (problem !== null) throw new UploadRefused(problem)
    }
  } catch (e) {
    removeTree(tmp)
    if (e instanceof UploadRefused) return ctx.error(400, e.message)
    throw e
  }
  await queueAdd(ctx, library, deps, src, tmp, meta.value, filename, null)
}

/** POST /api/library/items/from-url: the server downloads the image itself (§2.9 URL fetches), with the estimate
 *  reserved first so the cap is checked before any download. */
async function postFromUrl(ctx: RequestContext, library: LibraryService, deps: ServerDeps): Promise<void> {
  const body = await ctx.readJson()
  const url = isRecord(body) ? body['image_url'] : undefined
  if (!isRecord(body) || typeof url !== 'string' || pyStrip(url) === '') return ctx.error(400, FROM_URL_SHAPE)
  const link = pyStrip(url)
  const entries = new Map<string, PyValue>()
  for (const [k, v] of Object.entries(body)) if (k !== 'image_url') entries.set(k, pyValue(v))
  const meta = checkMeta({ kind: 'dict', entries }, 'image')
  if (!meta.ok) return ctx.error(400, meta.error)
  const key = 'fetch-' + randomBytes(4).toString('hex')
  const refused = deps.spend.reserve(key, countsAgainstCap() ? meta.value.estimate : 0)
  if (refused !== null) return ctx.send(402, refused)
  const tmp = await makeTempDir('midstudy-fetch-')
  let src: string
  try {
    src = await fetchImage(link, tmp)
    if (!isPhoto(await head(src))) throw new FetchError(LINK_NOT_IMAGE)
  } catch (e) {
    deps.spend.release(key)
    removeTree(tmp)
    if (e instanceof FetchError) return ctx.error(400, e.message)
    throw e
  }
  await queueAdd(ctx, library, deps, src, tmp, meta.value, link, key)
}

/** PATCH /api/library/items/<id>: name, category, mount, default_render in place (200 the item); new dims_cm or a
 *  turn queue a $0 rescale (202 {job}). */
async function patchItem(ctx: RequestContext, library: LibraryService, deps: ServerDeps, id: string): Promise<void> {
  const shape = patchShape(pyValue(await ctx.readJson()))
  if (!shape.ok) return ctx.error(400, shape.error)
  const outcome = await library.locked(async () => {
    const doc = library.read()
    const item = isSlug(id) ? findItem(itemsOf(doc), id) : null
    if (item === null) return answer(404, noItem(id))
    const plan = checkPatch(shape.value, itemFacts(item))
    if (!plan.ok) return answer(400, plan.error)
    let changed = false
    for (const set of plan.value.sets) {
      const current = getOr(item, set.key)
      changed = (set.value === null ? current !== null : current !== set.value) || changed
      item[set.key] = set.value
    }
    if (changed) await library.write(doc)
    return { item: plain(item), plan: plan.value }
  })
  if ('status' in outcome) return ctx.send(outcome.status, outcome.body)
  const { plan } = outcome
  const item = isRecord(outcome.item) ? outcome.item : {}
  const refit = plan.yaw !== 0 || (plan.dims !== null && needsRefit(plan, currentDims(item)))
  if (!refit) return ctx.send(200, outcome.item)
  const argv = rescaleArgv(deps.config.midstudyAdd, id, library.libraryArg(), plan.dims, plan.yaw)
  const queued = library.newJob('rescale', id, 'glb', 0, argv, null, 0, QUEUED)
  if ('refused' in queued) return ctx.send(402, queued.refused) // a $0 rescale is never refused
  await ctx.send(202, { job: queued.job })
}

/** PUT /api/library/items/<id>/thumb: the planner's picture of a piece made from a 3D file, stored without metadata. */
async function putThumb(ctx: RequestContext, library: LibraryService, id: string): Promise<void> {
  const body = await ctx.readJson()
  const image = isRecord(body) ? body['image'] : undefined
  const decoded = typeof image === 'string' ? decodeImageDataUri(image, 'jpeg') : null
  const data = decoded?.ok === true && decoded.value.length > 0 ? decoded.value : null
  if (data !== null && data.length > MAX_THUMB) return ctx.error(413, THUMB_TOO_LARGE)
  const stripped = data !== null && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? stripJpeg(data) : null
  const clean = stripped?.ok === true && stripped.value.bytes.length > 0 ? stripped.value.bytes : null
  if (clean === null || !jpegFrame(clean).ok) return ctx.error(400, THUMB_NOT_JPEG)
  const outcome = await library.locked(async () => {
    const doc = library.read()
    const item = isSlug(id) ? findItem(itemsOf(doc), id) : null
    if (item === null) return answer(404, noItem(id))
    const folder = path.join(library.dir, id)
    if (!isDir(folder)) return answer(409, noFolder(id))
    await atomicWrite(path.join(folder, 'thumb.jpg'), clean)
    const assets = isRecord(item['assets']) ? item['assets'] : {}
    item['assets'] = { ...assets, thumb: id + '/thumb.jpg' }
    await library.write(doc)
    return { status: 200, body: plain(item) }
  })
  await ctx.send(outcome.status, outcome.body)
}

/** DELETE /api/library/items/<id>: the entry and its folder move to `.trash/<id>-<UTC stamp>/`. */
async function deleteItem(ctx: RequestContext, library: LibraryService, id: string): Promise<void> {
  const outcome = await library.locked(async () => {
    const doc = library.read()
    const items = itemsOf(doc)
    const item = isSlug(id) ? findItem(items, id) : null
    if (item === null) return answer(404, noItem(id))
    const now = Date.now()
    const root = path.join(library.dir, '.trash')
    let n = 1
    while (fs.existsSync(path.join(root, trashName(id, now, n)))) n += 1
    const name = trashName(id, now, n)
    const trash = path.join(root, name)
    await fsp.mkdir(root, { recursive: true })
    await fsp.mkdir(trash)
    const folder = path.join(library.dir, id)
    if (isDir(folder)) move(folder, path.join(trash, id))
    await library.writeFile(path.join(trash, 'entry.json'), { deleted: isoUtc(now), entry: item }, 'midstudy/trash.schema.json#/$defs/item', 'ascii')
    doc['items'] = items.filter((i) => !(isRecord(i) && i['id'] === id))
    await library.write(doc)
    return { status: 200, body: { ok: true, trash: '.trash/' + name } }
  })
  await ctx.send(outcome.status, outcome.body)
}

/** POST /api/library/items/<id>/restore: the newest trashed copy back (200 the item), 404 when none, 409 when the
 *  id exists again. */
async function restoreItem(ctx: RequestContext, library: LibraryService, id: string): Promise<void> {
  if (!isSlug(id)) return ctx.error(404, noTrashed(id))
  const outcome = await library.locked(async () => {
    const doc = library.read()
    const items = itemsOf(doc)
    if (findItem(items, id) !== null || fs.existsSync(path.join(library.dir, id))) return answer(409, existsAgain(id))
    const copy = library.trash().find((t) => t.id === id)
    if (copy === undefined) return answer(404, notInTrash(id))
    const meta = readDocument(path.join(copy.dir, 'entry.json'))
    if (!isRecord(meta)) throw new PyError('TypeError', "'NoneType' object is not subscriptable")
    if (!Object.hasOwn(meta, 'entry')) throw new PyError('KeyError', "'entry'")
    const entry = meta['entry']
    const folder = path.join(copy.dir, id)
    if (isDir(folder)) move(folder, path.join(library.dir, id))
    doc['items'] = [...items, entry]
    await library.write(doc)
    removeTree(copy.dir)
    return { status: 200, body: plain(entry) }
  })
  await ctx.send(outcome.status, outcome.body)
}

export const routes: RouteModule = (deps) => {
  const library = new LibraryService(deps)
  return [
    {
      method: 'GET',
      path: /^\/api\/library$/,
      handle: async (ctx) => {
        const trash = library.trash().map((t) => ({ id: t.id, name: t.name, deleted: t.deleted }))
        await ctx.send(200, { ...library.readPlain(), trash })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/library\/jobs$/,
      handle: async (ctx) => {
        await ctx.send(200, { jobs: library.listJobs() })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/library\/jobs\/([^/]*)$/,
      handle: async (ctx, [id = '']) => {
        const job = library.getJob(id)
        await (job === null ? ctx.error(404, noJob(id)) : ctx.send(200, job))
      },
    },
    { method: 'PUT', path: /^\/api\/library\/items\/([^/]*)\/thumb$/, handle: (ctx, [id = '']) => putThumb(ctx, library, id) },
    { method: 'POST', path: /^\/api\/library\/items$/, handle: (ctx) => postUpload(ctx, library, deps) },
    { method: 'POST', path: /^\/api\/library\/items\/from-url$/, handle: (ctx) => postFromUrl(ctx, library, deps) },
    { method: 'POST', path: /^\/api\/library\/items\/([^/]*)\/restore$/, handle: (ctx, [id = '']) => restoreItem(ctx, library, id) },
    { method: 'PATCH', path: /^\/api\/library\/items\/([^/]*)$/, handle: (ctx, [id = '']) => patchItem(ctx, library, deps, id) },
    { method: 'DELETE', path: /^\/api\/library\/items\/([^/]*)$/, handle: (ctx, [id = '']) => deleteItem(ctx, library, id) },
  ]
}
