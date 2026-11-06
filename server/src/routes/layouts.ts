// Layouts per scene (contract §2.7) or per room (§4.9, `?room=`, in layouts/@<room>/): v1's list_layouts, get_layout,
// put_layout and delete_layout (planner/serve.py), `?scene=` through ctx.query. The patterns are v1's.
import path from 'node:path'
import { isoUtc } from '../../../common/logic/time.ts'
import type { RequestContext } from '../http/context.ts'
import type { RouteModule } from '../http/router.ts'
import { listDir, makeDirs, mtimeOf, readJson, writeJsonSync } from '../scenes/files.ts'
import { exists, isDir, isFile, replace } from '../../../common/files.ts'
import {
  checkLayout, checkRoomLayout, layoutNameProblem, layoutOwner, layoutSceneProblem, layoutSummary, noLayout, noRoomLayout, unreadableLayout, unreadableRoomLayout,
} from '../scenes/logic/layout.ts'
import { noRoom } from '../rooms/logic/room.ts'
import type { RoomService } from '../rooms/service.ts'
import { numbered, trashBase } from '../scenes/logic/names.ts'
import { noScene } from '../scenes/logic/scene.ts'
import { isoFromTimestamp } from '../scenes/logic/time.ts'
import { cmpCodePoints } from '../scenes/logic/values.ts'
import { scenesFor } from '../scenes/shared.ts'
import { isSlug } from '../../../common/logic/slug.ts'
import type { SceneService } from '../scenes/service.ts'

/** Whose layouts a request is about: a scene's (layouts/<scene>/) or a room's (layouts/@<room>/, §4.9). */
interface Owner {
  readonly kind: 'scene' | 'room'
  readonly name: string
  /** The folder under the layouts dir: `<scene>` or `@<room>`. */
  readonly folder: string
}

/** v1 `layout_scene` (+ `bad_layout_name` when `name` is given), with §4.9's `?room=`: exactly one of `?scene=` and
 *  `?room=`; the owner, or null with the refusal sent. */
async function layoutOwnerOf(ctx: RequestContext, scenes: SceneService, rooms: RoomService, name: string | null): Promise<Owner | null> {
  const which = layoutOwner(ctx.query('scene'), ctx.query('room'))
  let owner: Owner
  if (which.kind === 'refused') {
    await ctx.error(400, which.error)
    return null
  }
  if (which.kind === 'room') {
    if (!rooms.exists(which.name)) {
      await ctx.error(404, noRoom(which.name))
      return null
    }
    owner = { kind: 'room', name: which.name, folder: '@' + which.name }
  } else {
    const scene = which.name
    const problem = layoutSceneProblem(scene)
    if (problem !== null || scene === null) {
      await ctx.error(400, problem ?? '')
      return null
    }
    if (!scenes.exists(scene)) {
      await ctx.error(404, noScene(scene))
      return null
    }
    owner = { kind: 'scene', name: scene, folder: scene }
  }
  if (name !== null) {
    const bad = layoutNameProblem(name)
    if (bad !== null) {
      await ctx.error(400, bad)
      return null
    }
  }
  return owner
}

function missing(owner: Owner, name: string): string {
  return owner.kind === 'room' ? noRoomLayout(owner.name, name) : noLayout(owner.name, name)
}

export const routes: RouteModule = (deps) => {
  const { scenes, rooms } = scenesFor(deps)
  const dir = deps.config.layoutsDir
  const file = (owner: Owner, name: string): string => path.join(dir, owner.folder, name + '.json')
  return [
    {
      method: 'GET', path: /^\/api\/layouts$/, handle: async (ctx) => {
        const owner = await layoutOwnerOf(ctx, scenes, rooms, null)
        if (owner === null) return
        const d = path.join(dir, owner.folder)
        const names = isDir(d) ? listDir(d).filter((f) => f.endsWith('.json')).sort(cmpCodePoints) : []
        const details = []
        for (const f of names) {
          const stem = f.slice(0, -'.json'.length)
          const p = path.join(d, f)
          if (!isSlug(stem) || !isFile(p)) continue
          const t = mtimeOf(p)
          details.push(layoutSummary(stem, readJson(p), t === null ? '' : isoFromTimestamp(t)))
        }
        await ctx.send(200, { layouts: details.map((x) => x.name), details })
      },
    },
    {
      method: 'GET', path: /^\/api\/layouts\/([^/]*)$/, handle: async (ctx, [name = '']) => {
        const owner = await layoutOwnerOf(ctx, scenes, rooms, name)
        if (owner === null) return
        const p = file(owner, name)
        if (!isFile(p)) {
          await ctx.error(404, missing(owner, name))
          return
        }
        const data = readJson(p)
        if (data === null) await ctx.error(500, owner.kind === 'room' ? unreadableRoomLayout(owner.name, name) : unreadableLayout(owner.name, name))
        else await ctx.send(200, data)
      },
    },
    {
      method: 'PUT', path: /^\/api\/layouts\/([^/]*)$/, handle: async (ctx, [name = '']) => {
        const owner = await layoutOwnerOf(ctx, scenes, rooms, name)
        if (owner === null) return
        const body = await ctx.readJson()
        const updated = isoUtc(Date.now())
        const check = owner.kind === 'room' ? checkRoomLayout(body, name, owner.name, updated) : checkLayout(body, name, owner.name, updated)
        if (!check.ok) {
          await ctx.error(400, check.error)
          return
        }
        writeJsonSync(file(owner, name), check.layout, 'midstudy/layout.schema.json')
        await ctx.send(200, check.layout)
      },
    },
    {
      method: 'DELETE', path: /^\/api\/layouts\/([^/]*)$/, handle: async (ctx, [name = '']) => {
        const owner = await layoutOwnerOf(ctx, scenes, rooms, name)
        if (owner === null) return
        const p = file(owner, name)
        if (!isFile(p)) {
          await ctx.error(404, missing(owner, name))
          return
        }
        // Not gone for good: layouts/<scene>/.trash/<layout>-<UTC stamp>.json (a room's: layouts/@<room>/.trash/…;
        // never listed or served). The planner's Undo puts the layout back with a PUT of the copy it read first.
        const trashDir = path.join(dir, owner.folder, '.trash')
        makeDirs(trashDir)
        const base = trashBase(name, Date.now())
        let n = 1
        let trash = path.join(trashDir, base + '.json')
        while (exists(trash)) {
          n += 1
          trash = path.join(trashDir, numbered(base, n) + '.json')
        }
        replace(p, trash)
        const where = path.basename(dir) + '/' + owner.folder + '/.trash/' + path.basename(trash)
        if (owner.kind === 'room') await ctx.send(200, { ok: true, name, room: owner.name, trash: where })
        else await ctx.send(200, { ok: true, name, scene: owner.name, trash: where })
      },
    },
  ]
}
