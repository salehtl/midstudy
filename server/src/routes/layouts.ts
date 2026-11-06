// Layouts per scene (contract §2.7): stubs until the server-scenes track ports planner/serve.py's list_layouts,
// get_layout, put_layout and delete_layout (`?scene=` through ctx.query). The patterns are v1's.
import type { RouteModule } from '../http/router.ts'
import { notImplemented } from './stub.ts'

export const routes: RouteModule = () => [
  notImplemented('GET', /^\/api\/layouts$/),
  notImplemented('GET', /^\/api\/layouts\/([^/]*)$/),
  notImplemented('PUT', /^\/api\/layouts\/([^/]*)$/),
  notImplemented('DELETE', /^\/api\/layouts\/([^/]*)$/),
]
