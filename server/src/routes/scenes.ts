// Scenes (contract §4.2–§4.4, §4.8 backfill): stubs until the server-scenes track ports planner/serve.py's
// SceneService and its handlers (get_scene, post_scene, put_scene, put_scene_thumb, calibrate_scene, light_scene,
// delete_scene, restore_scene). The patterns are v1's, in v1's order; keep them when replacing the handlers.
import type { RouteModule } from '../http/router.ts'
import { notImplemented } from './stub.ts'

export const routes: RouteModule = () => [
  notImplemented('GET', /^\/api\/scenes$/),
  notImplemented('GET', /^\/api\/scenes\/jobs$/),
  notImplemented('GET', /^\/api\/scenes\/jobs\/([^/]*)$/),
  notImplemented('GET', /^\/api\/scenes\/([^/]*)$/),
  notImplemented('PUT', /^\/api\/scenes\/([^/]*)\/thumb$/),
  notImplemented('PUT', /^\/api\/scenes\/(?!jobs$)([^/]*)$/),
  notImplemented('POST', /^\/api\/scenes$/),
  notImplemented('POST', /^\/api\/scenes\/([^/]*)\/calibrate$/),
  notImplemented('POST', /^\/api\/scenes\/([^/]*)\/light$/),
  notImplemented('POST', /^\/api\/scenes\/([^/]*)\/restore$/),
  notImplemented('DELETE', /^\/api\/scenes\/(?!jobs$)([^/]*)$/),
]
