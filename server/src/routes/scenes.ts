// Scenes (contract §4.2–§4.4, §4.8 backfill): v1's handlers (planner/serve.py get_scene, post_scene, put_scene,
// put_scene_thumb, calibrate_scene, light_scene, delete_scene, restore_scene, and the scene routes of
// handle_api_get) on server/src/scenes/service.ts. The patterns are v1's, in v1's order.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareNames, decodeImageDataUri, decodeMeta, photoExt, sniff, stripJpeg } from '../../../core/js/node.ts'
import { isSlug } from '../../../common/logic/slug.ts'
import { HttpError, type RequestContext } from '../http/context.ts'
import type { RouteModule } from '../http/router.ts'
import { readHead, removeTree } from '../scenes/files.ts'
import { NOT_JPEG_URI } from '../scenes/logic/render.ts'
import {
  FILENAME_REQUIRED, LENGTH_REQUIRED, MAX_SCENE_UPLOAD, MAX_THUMB, NOT_IMAGE, THUMB_TOO_BIG, UPLOAD_STOPPED, existsAgain, metaTitle, noDeletedScene,
  noJob, noScene, notInTrash, storedFilename, uploadFilename, uploadTooLarge,
} from '../scenes/logic/scene.ts'
import { checkScenePut } from '../scenes/logic/sceneput.ts'
import { isRecord } from '../scenes/logic/values.ts'
import { scenesFor } from '../scenes/shared.ts'
import type { SceneService } from '../scenes/service.ts'

/** X-Midstudy-Meta may be as long as a header line (v1 decoded any length; Node reads at most 64 KiB of headers). */
const MAX_META = 64 * 1024

/** The JSON inside X-Midstudy-Meta (strict base64 of UTF-8), or undefined when it isn't (v1: `meta = None`). */
function metaJson(header: string): unknown {
  // A UTF-8 byte order mark (base64 "77u/…"): Python's json refused it; the kernel's decoder drops it.
  if (header.startsWith('77u/')) return undefined
  const text = decodeMeta(header, MAX_META)
  if (!text.ok) return undefined
  try {
    const value: unknown = JSON.parse(text.value)
    return value
  } catch {
    return undefined
  }
}

/** v1 `post_scene`: the photo as the raw body → a private temp file → a new scene and its `run` job (202). */
async function postScene(ctx: RequestContext, scenes: SceneService): Promise<void> {
  const length = ctx.contentLength
  if (ctx.chunked || length === null) {
    ctx.closeConnection()
    await ctx.error(411, LENGTH_REQUIRED)
    return
  }
  if (length > MAX_SCENE_UPLOAD) {
    await ctx.error(413, uploadTooLarge(length))
    return
  }
  const filename = uploadFilename(ctx.header('x-midstudy-filename'))
  if (filename === '') {
    await ctx.error(400, FILENAME_REQUIRED)
    return
  }
  let title: string | null = null
  const rawMeta = ctx.header('x-midstudy-meta')
  if (rawMeta !== undefined && rawMeta !== '') {
    const t = metaTitle(metaJson(rawMeta))
    if (!t.ok) {
      await ctx.error(400, t.error)
      return
    }
    title = t.title
  }
  if (length === 0) {
    await ctx.error(400, NOT_IMAGE)
    return
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midstudy-scene-')) // private, never under a served path
  let upload: string
  let ext: string
  try {
    const part = path.join(tmp, 'upload.part')
    const got = await ctx.readBodyTo(part, length)
    if (got < length) throw new HttpError(400, UPLOAD_STOPPED)
    const kind = photoExt(sniff(readHead(part, 64) ?? Buffer.alloc(0)))
    if (kind === null) throw new HttpError(400, NOT_IMAGE)
    ext = kind
    upload = path.join(tmp, 'upload.' + kind)
    fs.renameSync(part, upload)
  } catch (e) {
    removeTree(tmp)
    throw e
  }
  const { name, job } = scenes.create(upload, tmp, storedFilename(filename), ext, length, title)
  await ctx.send(202, { job, scene: name })
}

/** v1 `put_scene`. */
async function putScene(ctx: RequestContext, scenes: SceneService, name: string): Promise<void> {
  if (!scenes.exists(name)) {
    await ctx.error(404, noScene(name))
    return
  }
  const body = await ctx.readJson()
  const rec = isRecord(body) ? body : null
  const camera = rec === null ? undefined : rec['camera']
  const look = rec === null ? undefined : rec['look']
  const check = checkScenePut({
    entries: rec === null ? null : Object.entries(rec),
    camera: isRecord(camera) ? camera : null,
    cameraEntries: isRecord(camera) ? Object.entries(camera) : null,
    lookEntries: isRecord(look) ? Object.entries(look) : null,
  })
  if (!check.ok) {
    await ctx.error(400, check.error)
    return
  }
  if (!scenes.update(name, check.patch)) {
    await ctx.error(404, noScene(name))
    return
  }
  await ctx.send(200, scenes.full(name))
}

/** v1 `put_scene_thumb`: a JPEG data URI ≤ 2 MB, stored as thumb.jpg without its metadata. */
async function putThumb(ctx: RequestContext, scenes: SceneService, name: string): Promise<void> {
  if (!scenes.exists(name)) {
    await ctx.error(404, noScene(name))
    return
  }
  const body = await ctx.readJson()
  const image = isRecord(body) ? body['image'] : undefined
  const decoded = typeof image === 'string' ? decodeImageDataUri(image, 'jpeg') : null
  const data = decoded?.ok === true ? decoded.value : null
  if (data !== null && data.length > MAX_THUMB) {
    await ctx.error(413, THUMB_TOO_BIG)
    return
  }
  const clean = data !== null && data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? stripJpeg(data) : null
  if (clean?.ok !== true || clean.value.bytes.length === 0) {
    await ctx.error(400, NOT_JPEG_URI)
    return
  }
  if (!scenes.writeThumb(name, clean.value.bytes)) {
    await ctx.error(404, noScene(name))
    return
  }
  await ctx.send(200, { ok: true, thumb_url: scenes.thumbUrl(name) })
}

export const routes: RouteModule = (deps) => {
  const { scenes } = scenesFor(deps)
  return [
    {
      method: 'GET', path: /^\/api\/scenes$/, handle: async (ctx) => {
        const trash = scenes.trash().map((t) => ({ name: t.name, title: t.title, created: t.created, deleted: t.deleted }))
        await ctx.send(200, { scenes: scenes.all(compareNames), trash })
      },
    },
    {
      method: 'GET', path: /^\/api\/scenes\/jobs$/, handle: async (ctx) => {
        await ctx.send(200, { jobs: scenes.listJobs() })
      },
    },
    {
      method: 'GET', path: /^\/api\/scenes\/jobs\/([^/]*)$/, handle: async (ctx, [id = '']) => {
        const job = scenes.getJob(id)
        if (job === null) await ctx.error(404, noJob(id))
        else await ctx.send(200, job)
      },
    },
    {
      method: 'GET', path: /^\/api\/scenes\/([^/]*)$/, handle: async (ctx, [name = '']) => {
        const data = isSlug(name) ? scenes.full(name) : null
        if (data === null) await ctx.error(404, noScene(name))
        else await ctx.send(200, data)
      },
    },
    { method: 'PUT', path: /^\/api\/scenes\/([^/]*)\/thumb$/, handle: (ctx, [name = '']) => putThumb(ctx, scenes, name) },
    { method: 'PUT', path: /^\/api\/scenes\/(?!jobs$)([^/]*)$/, handle: (ctx, [name = '']) => putScene(ctx, scenes, name) },
    { method: 'POST', path: /^\/api\/scenes$/, handle: (ctx) => postScene(ctx, scenes) },
    {
      method: 'POST', path: /^\/api\/scenes\/([^/]*)\/calibrate$/, handle: async (ctx, [name = '']) => {
        if (!isSlug(name)) {
          await ctx.error(404, noScene(name))
          return
        }
        const r = scenes.calibrate(name)
        if ('job' in r) await ctx.send(202, { job: r.job })
        else await ctx.error(r.status, r.error)
      },
    },
    {
      method: 'POST', path: /^\/api\/scenes\/([^/]*)\/light$/, handle: async (ctx, [name = '']) => {
        if (!isSlug(name)) {
          await ctx.error(404, noScene(name))
          return
        }
        const r = scenes.light(name)
        if ('body' in r) await ctx.send(r.status, r.body)
        else await ctx.error(r.status, r.error)
      },
    },
    {
      method: 'POST', path: /^\/api\/scenes\/([^/]*)\/restore$/, handle: async (ctx, [name = '']) => {
        if (!isSlug(name)) {
          await ctx.error(404, noDeletedScene(name))
          return
        }
        const r = scenes.restore(name)
        if (r === 'none') await ctx.error(404, notInTrash(name))
        else if (r === 'exists') await ctx.error(409, existsAgain(name))
        else await ctx.send(200, r.scene)
      },
    },
    {
      method: 'DELETE', path: /^\/api\/scenes\/(?!jobs$)([^/]*)$/, handle: async (ctx, [name = '']) => {
        const trash = scenes.exists(name) ? scenes.delete(name) : null
        if (trash === null) await ctx.error(404, noScene(name))
        else await ctx.send(200, { ok: true, trash })
      },
    },
  ]
}
