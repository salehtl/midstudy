// Rooms (contract §4.9): GET/POST /api/rooms, the align jobs (GET /api/rooms/jobs[/<id>]), GET/PUT/DELETE
// /api/rooms/<room>, POST /api/rooms/<room>/align and …/restore, on server/src/rooms/service.ts. Room layouts are
// routes/layouts.ts (`?room=`); a render's `room` is routes/render.ts.
import { isSlug } from '../../../common/logic/slug.ts'
import type { RequestContext } from '../http/context.ts'
import type { RouteModule } from '../http/router.ts'
import { checkAlignRequest, checkRoomCreate, checkRoomPut, noAlignJob, noRoom, roomExistsAgain, roomNotInTrash } from '../rooms/logic/room.ts'
import type { RoomService } from '../rooms/service.ts'
import { isRecord } from '../scenes/logic/values.ts'
import { scenesFor } from '../scenes/shared.ts'

/** The body's entries when it is a JSON object, else null. */
function entriesOf(body: unknown): readonly (readonly [string, unknown])[] | null {
  return isRecord(body) ? Object.entries(body) : null
}

async function postRoom(ctx: RequestContext, rooms: RoomService): Promise<void> {
  const check = checkRoomCreate(entriesOf(await ctx.readJson()))
  if (!check.ok) {
    await ctx.error(400, check.error)
    return
  }
  const r = rooms.create(check.value.title, check.value.scenes)
  if ('error' in r) {
    await ctx.error(r.status, r.error)
    return
  }
  const detail = rooms.detail(r.name)
  if (detail === null) await ctx.error(404, noRoom(r.name))
  else await ctx.send(201, detail)
}

async function putRoom(ctx: RequestContext, rooms: RoomService, name: string): Promise<void> {
  if (!rooms.exists(name)) {
    await ctx.error(404, noRoom(name))
    return
  }
  const check = checkRoomPut(entriesOf(await ctx.readJson()))
  if (!check.ok) {
    await ctx.error(400, check.error)
    return
  }
  const r = rooms.update(name, check.value)
  if ('error' in r) {
    await ctx.error(r.status, r.error)
    return
  }
  const detail = rooms.detail(name)
  if (detail === null) await ctx.error(404, noRoom(name))
  else await ctx.send(200, detail)
}

async function postAlign(ctx: RequestContext, rooms: RoomService, name: string): Promise<void> {
  if (!rooms.exists(name)) {
    await ctx.error(404, noRoom(name))
    return
  }
  // No body, or a JSON object.
  const empty = !ctx.chunked && (ctx.contentLength ?? 0) === 0
  const body = empty ? null : await ctx.readJson()
  const check = checkAlignRequest(entriesOf(body), empty)
  if (!check.ok) {
    await ctx.error(400, check.error)
    return
  }
  const r = rooms.align(name, check.value)
  if ('error' in r) await ctx.error(r.status, r.error)
  else await ctx.send(202, { job: r.job })
}

export const routes: RouteModule = (deps) => {
  const { rooms } = scenesFor(deps)
  return [
    {
      method: 'GET', path: /^\/api\/rooms$/, handle: async (ctx) => {
        const trash = rooms.trash().map((t) => ({ name: t.name, title: t.title, created: t.created, deleted: t.deleted }))
        await ctx.send(200, { rooms: rooms.all(), trash })
      },
    },
    { method: 'POST', path: /^\/api\/rooms$/, handle: (ctx) => postRoom(ctx, rooms) },
    {
      method: 'GET', path: /^\/api\/rooms\/jobs$/, handle: async (ctx) => {
        await ctx.send(200, { jobs: rooms.listJobs() })
      },
    },
    {
      method: 'GET', path: /^\/api\/rooms\/jobs\/([^/]*)$/, handle: async (ctx, [id = '']) => {
        const job = rooms.getJob(id)
        if (job === null) await ctx.error(404, noAlignJob(id))
        else await ctx.send(200, job)
      },
    },
    {
      method: 'GET', path: /^\/api\/rooms\/(?!jobs$)([^/]*)$/, handle: async (ctx, [name = '']) => {
        const data = isSlug(name) ? rooms.detail(name) : null
        if (data === null) await ctx.error(404, noRoom(name))
        else await ctx.send(200, data)
      },
    },
    { method: 'PUT', path: /^\/api\/rooms\/(?!jobs$)([^/]*)$/, handle: (ctx, [name = '']) => putRoom(ctx, rooms, name) },
    {
      method: 'DELETE', path: /^\/api\/rooms\/(?!jobs$)([^/]*)$/, handle: async (ctx, [name = '']) => {
        const trash = rooms.exists(name) ? rooms.delete(name) : null
        if (trash === null) await ctx.error(404, noRoom(name))
        else await ctx.send(200, { ok: true, trash })
      },
    },
    { method: 'POST', path: /^\/api\/rooms\/([^/]*)\/align$/, handle: (ctx, [name = '']) => postAlign(ctx, rooms, name) },
    {
      method: 'POST', path: /^\/api\/rooms\/([^/]*)\/restore$/, handle: async (ctx, [name = '']) => {
        if (!isSlug(name)) {
          await ctx.error(404, roomNotInTrash(name))
          return
        }
        const r = rooms.restore(name)
        if (r === 'none') await ctx.error(404, roomNotInTrash(name))
        else if (r === 'exists') await ctx.error(409, roomExistsAgain(name))
        else if (r.room === null) await ctx.error(404, noRoom(name))
        else await ctx.send(200, r.room)
      },
    },
  ]
}
