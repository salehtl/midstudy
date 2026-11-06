// The scenes, rooms and renders services one server shares between its route modules (routes/scenes.ts, rooms.ts,
// layouts.ts, render.ts): main.ts calls each module with the same ServerDeps, so the first call makes them and the others reuse
// them (v1 had one SceneService per server). The calibration worker is stopped on shutdown.
import path from 'node:path'
import type { ServerDeps } from '../deps.ts'
import { RoomService } from '../rooms/service.ts'
import { RenderService } from './render.ts'
import { SceneService } from './service.ts'

/** One server's scenes, rooms (contract §4.9) and renders. */
export interface Scenes {
  readonly scenes: SceneService
  readonly rooms: RoomService
  readonly renders: RenderService
}

const made = new WeakMap<ServerDeps, Scenes>()

/** The services of the server `deps` belongs to. */
export function scenesFor(deps: ServerDeps): Scenes {
  const known = made.get(deps)
  if (known !== undefined) return known
  const c = deps.config
  const log = (line: string): void => {
    process.stderr.write(line + '\n')
  }
  const scenes = new SceneService({ scenesDir: c.scenesDir, layoutsDir: c.layoutsDir, calib: c.calib, repo: c.repo, log })
  const renders = new RenderService({
    rendersDir: c.rendersDir, costsFile: c.costsFile, repo: c.repo, calib: c.calib, spend: deps.spend,
    scenePhoto: (scene) => path.join(scenes.path(scene), 'photo.jpg'),
  })
  const rooms = new RoomService({ roomsDir: c.roomsDir, layoutsDir: c.layoutsDir, scenes })
  deps.onShutdown(() => scenes.shutdown())
  const s: Scenes = { scenes, rooms, renders }
  made.set(deps, s)
  return s
}
