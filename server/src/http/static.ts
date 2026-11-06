// Static files (contract §2.1 Static is an allowlist, §2.8 What /library/ serves, §4.4 Static, §2.9 Paths): the
// target is normalized once (percent-decoding, `.`, `..`) by the media kernel's staticRoute before any rule, and only
// what it names is served: the planner folder, a library's library.json and item assets, a scene's photo, depth and
// thumbnail, renders. Everything else is v1's 404 page, whatever its spelling or case. Answers carry v1's headers
// (Content-Type by extension, Last-Modified, no caching, nosniff) and v1's folder rules.
import fs from 'node:fs'
import path from 'node:path'
import { staticRoute, type StaticRoute } from '../../../core/js/node.ts'
import { folderLocation } from '../logic/http.ts'
import { mimeType } from '../logic/mime.ts'
import type { RequestContext } from './context.ts'

/** Where each allowlisted kind lives. */
export interface StaticDirs {
  /** The planner folder (`<repo>/planner`: index.html, dist/, styles/, …). */
  readonly planner: string
  readonly library: string
  readonly scenes: string
  readonly renders: string
}

const NOT_FOUND = 'File not found'

/** The file a static route names, or null for none. */
function routeFile(route: StaticRoute, dirs: StaticDirs): string | null {
  switch (route.kind) {
    case 'planner': return route.path === '' ? dirs.planner : path.join(dirs.planner, ...route.path.split('/'))
    case 'library-json': return path.join(dirs.library, 'library.json')
    case 'library': return path.join(dirs.library, route.id, route.file)
    case 'scene': return path.join(dirs.scenes, route.name, route.file)
    case 'render': return path.join(dirs.renders, route.file)
    case 'redirect-to-planner':
    case 'not-found': return null
  }
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** `If-Modified-Since` (without `If-None-Match`) at or after the file's time, in UTC: v1 answered 304. */
function notModified(ctx: RequestContext, mtimeMs: number): boolean {
  const ims = ctx.header('if-modified-since')
  if (ims === undefined || ctx.header('if-none-match') !== undefined) return false
  if (!/(GMT|UTC|[+-]0000|Z)\s*$/i.test(ims)) return false
  const t = Date.parse(ims)
  if (Number.isNaN(t)) return false
  return Math.floor(mtimeMs / 1000) * 1000 <= t
}

/** Files up to this size are read whole and sent in one write (fewer stream turns: the planner's bundle); larger ones
 *  (models, splats) are streamed. */
const WHOLE_FILE = 4 * 1024 * 1024

async function serveFile(ctx: RequestContext, file: string, stat: fs.Stats): Promise<void> {
  if (notModified(ctx, stat.mtimeMs)) {
    const res = ctx.beginFile(304, [])
    res.end()
    return
  }
  const headers: readonly (readonly [string, string])[] = [
    ['Content-Type', mimeType(file)],
    ['Content-Length', String(stat.size)],
    ['Last-Modified', new Date(stat.mtimeMs).toUTCString()],
  ]
  if (stat.size <= WHOLE_FILE) {
    // One read from the page cache (well under a millisecond for the bundle) beats three trips to the thread pool.
    let data: Buffer
    try {
      data = fs.readFileSync(file)
    } catch {
      ctx.sendHtmlError(404, NOT_FOUND)
      return
    }
    ctx.beginFile(200, headers).end(ctx.method === 'HEAD' ? undefined : data)
    return
  }
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, 'r')
  } catch {
    ctx.sendHtmlError(404, NOT_FOUND)
    return
  }
  const res = ctx.beginFile(200, headers)
  if (ctx.method === 'HEAD') {
    await handle.close()
    res.end()
    return
  }
  const stream = handle.createReadStream({ highWaterMark: 1024 * 1024 })
  stream.on('error', () => {
    res.destroy()
  })
  stream.pipe(res)
}

/** Answers a static GET or HEAD (v1's do_GET after the /api routes): the `/` redirect, the allowlist, folders
 *  (redirected to their slash, then their index.html; never listed), an empty library while library.json is
 *  missing, files. */
export async function serveStatic(ctx: RequestContext, dirs: StaticDirs): Promise<void> {
  if (ctx.parts?.rawPath === '/') {
    ctx.sendEmpty(302, [['Location', '/planner/'], ['Content-Length', '0']])
    return
  }
  const route = staticRoute(ctx.target)
  if (route.kind === 'redirect-to-planner') {
    ctx.sendEmpty(302, [['Location', '/planner/'], ['Content-Length', '0']])
    return
  }
  const file = routeFile(route, dirs)
  if (file === null) {
    ctx.sendHtmlError(404, NOT_FOUND)
    return
  }
  let stat = statOf(file)
  if (route.kind === 'library-json' && stat?.isFile() !== true) {
    // A library dir nothing has been added to yet: an empty library (§2.2), not a 404 the browser logs.
    await ctx.send(200, { version: 1, items: [] })
    return
  }
  if (stat === null) {
    ctx.sendHtmlError(404, NOT_FOUND)
    return
  }
  let target = file
  if (stat.isDirectory()) {
    const parts = ctx.parts
    if (parts === null) {
      ctx.sendHtmlError(404, NOT_FOUND)
      return
    }
    if (!parts.rawPath.endsWith('/')) {
      ctx.sendEmpty(301, [['Location', folderLocation(parts)], ['Content-Length', '0']])
      return
    }
    const index = ['index.html', 'index.htm'].map((n) => path.join(file, n)).find((p) => statOf(p)?.isFile() === true)
    if (index === undefined) {
      ctx.sendHtmlError(404, NOT_FOUND)
      return
    }
    target = index
    stat = statOf(index)
    if (stat === null) {
      ctx.sendHtmlError(404, NOT_FOUND)
      return
    }
  }
  if (!stat.isFile()) {
    ctx.sendHtmlError(404, NOT_FOUND)
    return
  }
  await serveFile(ctx, target, stat)
}
