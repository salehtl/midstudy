// Layouts per scene (contract §2.7): v1's list_layouts, get_layout, put_layout and delete_layout (planner/serve.py),
// `?scene=` through ctx.query. The patterns are v1's.
import path from 'node:path'
import { isoUtc } from '../../../common/logic/time.ts'
import type { RequestContext } from '../http/context.ts'
import type { RouteModule } from '../http/router.ts'
import { listDir, makeDirs, mtimeOf, readJson, writeJsonSync } from '../scenes/files.ts'
import { exists, isDir, isFile, replace } from '../../../common/files.ts'
import { checkLayout, layoutNameProblem, layoutSceneProblem, layoutSummary, noLayout, unreadableLayout } from '../scenes/logic/layout.ts'
import { numbered, trashBase } from '../scenes/logic/names.ts'
import { noScene } from '../scenes/logic/scene.ts'
import { isoFromTimestamp } from '../scenes/logic/time.ts'
import { cmpCodePoints } from '../scenes/logic/values.ts'
import { scenesFor } from '../scenes/shared.ts'
import { isSlug } from '../../../common/logic/slug.ts'
import type { SceneService } from '../scenes/service.ts'

/** v1 `layout_scene` (+ `bad_layout_name` when `name` is given): the scene of `?scene=`, or null with the refusal sent. */
async function layoutScene(ctx: RequestContext, scenes: SceneService, name: string | null): Promise<string | null> {
  const scene = ctx.query('scene')
  const problem = layoutSceneProblem(scene)
  if (problem !== null || scene === null) {
    await ctx.error(400, problem ?? '')
    return null
  }
  if (!scenes.exists(scene)) {
    await ctx.error(404, noScene(scene))
    return null
  }
  if (name !== null) {
    const bad = layoutNameProblem(name)
    if (bad !== null) {
      await ctx.error(400, bad)
      return null
    }
  }
  return scene
}

export const routes: RouteModule = (deps) => {
  const { scenes } = scenesFor(deps)
  const dir = deps.config.layoutsDir
  const file = (scene: string, name: string): string => path.join(dir, scene, name + '.json')
  return [
    {
      method: 'GET', path: /^\/api\/layouts$/, handle: async (ctx) => {
        const scene = await layoutScene(ctx, scenes, null)
        if (scene === null) return
        const d = path.join(dir, scene)
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
        const scene = await layoutScene(ctx, scenes, name)
        if (scene === null) return
        const p = file(scene, name)
        if (!isFile(p)) {
          await ctx.error(404, noLayout(scene, name))
          return
        }
        const data = readJson(p)
        if (data === null) await ctx.error(500, unreadableLayout(scene, name))
        else await ctx.send(200, data)
      },
    },
    {
      method: 'PUT', path: /^\/api\/layouts\/([^/]*)$/, handle: async (ctx, [name = '']) => {
        const scene = await layoutScene(ctx, scenes, name)
        if (scene === null) return
        const body = await ctx.readJson()
        const check = checkLayout(body, name, scene, isoUtc(Date.now()))
        if (!check.ok) {
          await ctx.error(400, check.error)
          return
        }
        writeJsonSync(file(scene, name), check.layout, 'midstudy/layout.schema.json')
        await ctx.send(200, check.layout)
      },
    },
    {
      method: 'DELETE', path: /^\/api\/layouts\/([^/]*)$/, handle: async (ctx, [name = '']) => {
        const scene = await layoutScene(ctx, scenes, name)
        if (scene === null) return
        const p = file(scene, name)
        if (!isFile(p)) {
          await ctx.error(404, noLayout(scene, name))
          return
        }
        // Not gone for good: layouts/<scene>/.trash/<layout>-<UTC stamp>.json (never listed or served). The planner's
        // Undo puts the layout back with a PUT of the copy it read first.
        const trashDir = path.join(dir, scene, '.trash')
        makeDirs(trashDir)
        const base = trashBase(name, Date.now())
        let n = 1
        let trash = path.join(trashDir, base + '.json')
        while (exists(trash)) {
          n += 1
          trash = path.join(trashDir, numbered(base, n) + '.json')
        }
        replace(p, trash)
        await ctx.send(200, { ok: true, name, scene, trash: path.basename(dir) + '/' + scene + '/.trash/' + path.basename(trash) })
      },
    },
  ]
}
