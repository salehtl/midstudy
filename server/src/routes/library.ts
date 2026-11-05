// The library (contract §2.8): stubs until the server-library track ports planner/serve.py's LibraryService jobs
// and its handlers (get_library, post_library_upload, post_library_from_url, patch_library_item,
// put_library_thumb, delete_library_item, restore_library_item) on common/lock.ts (withLibraryLock, 60 s then
// Busy → 503), server/src/jobs.ts, server/src/tools.ts and server/src/fetch.ts (fetchImage). The patterns are v1's,
// in v1's order. POST /api/library/product is the product track's (server/src/product/route.ts).
import type { RouteModule } from '../http/router.ts'
import { notImplemented } from './stub.ts'

export const routes: RouteModule = () => [
  notImplemented('GET', /^\/api\/library$/),
  notImplemented('GET', /^\/api\/library\/jobs$/),
  notImplemented('GET', /^\/api\/library\/jobs\/([^/]*)$/),
  notImplemented('PUT', /^\/api\/library\/items\/([^/]*)\/thumb$/),
  notImplemented('POST', /^\/api\/library\/items$/),
  notImplemented('POST', /^\/api\/library\/items\/from-url$/),
  notImplemented('POST', /^\/api\/library\/items\/([^/]*)\/restore$/),
  notImplemented('PATCH', /^\/api\/library\/items\/([^/]*)$/),
  notImplemented('DELETE', /^\/api\/library\/items\/([^/]*)$/),
]
