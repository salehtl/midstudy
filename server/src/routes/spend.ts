// GET /api/spend (contract §2.9): today's (UTC) spend from costs.csv, what running calls have reserved, and the cap.
// GET/PUT /api/settings (§2.9 Settings): the daily budget; --daily-spend-usd fixes it (PUT is 409).
import type { ServerDeps } from '../deps.ts'
import { budgetLocked, budgetPut } from '../logic/spend.ts'
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
    {
      method: 'GET',
      path: /^\/api\/settings$/,
      handle: async (ctx) => {
        await ctx.send(200, deps.spend.settings())
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/settings$/,
      handle: async (ctx) => {
        const put = budgetPut(await ctx.readJson())
        if (!put.ok) {
          await ctx.error(400, put.error)
          return
        }
        if (deps.spend.locked) {
          await ctx.error(409, budgetLocked(deps.spend.capUsd))
          return
        }
        deps.spend.setCap(put.usd)
        await ctx.send(200, deps.spend.settings())
      },
    },
  ]
}
