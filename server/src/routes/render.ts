// Render (contract §2.6, §4.7): stubs until the server-scenes track ports planner/serve.py's post_render, render,
// align and list_renders (the spend cap through deps.spend, fal through common/fal.ts, cost rows through
// common/costs.ts, align through server/src/tools.ts). The patterns are v1's.
import type { RouteModule } from '../http/router.ts'
import { notImplemented } from './stub.ts'

export const routes: RouteModule = () => [
  notImplemented('POST', /^\/api\/render$/),
  notImplemented('GET', /^\/api\/renders$/),
]
