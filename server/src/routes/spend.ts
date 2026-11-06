// GET /api/spend (contract §2.9): today's (UTC) spend from costs.csv, what running calls have reserved, and the cap.
// No route changes the cap (a flag only).
import type { ServerDeps } from '../deps.ts'
import type { ApiRoute } from '../http/router.ts'

export function routes(deps: ServerDeps): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/api\/spend$/,
      handle: async (ctx) => {
        await ctx.send(200, deps.spend.view())
      },
    },
  ]
}
