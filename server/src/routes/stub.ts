// The answer of a route v2 doesn't implement yet (stage A of Phase 2): 501 `{"error": "not implemented in v2 yet"}`.
// The stage-B tracks replace each stub's handler; nothing else needs to change (main.ts registers the modules).
import { NOT_IMPLEMENTED } from '../logic/http.ts'
import type { ApiMethod, ApiRoute } from '../http/router.ts'

/** A route that answers 501 until its track implements it. */
export function notImplemented(method: ApiMethod, path: RegExp): ApiRoute {
  return {
    method,
    path,
    handle: async (ctx) => {
      await ctx.error(501, NOT_IMPLEMENTED)
    },
  }
}
