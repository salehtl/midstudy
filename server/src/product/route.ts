// The product page reader's route (contract §2.11): a stub until the product track ports planner/product_page.py.
// Its page and feed fetches go through server/src/fetch.ts (safeFetch: maxRedirects 5, maxBytes 10 MB with
// overflow 'cut', decode true; feeds 2 MB with sameOrigin: originOf(page url); one Budget(20 s) for all of them),
// the model through common/fal.ts (falCall, readMockAnswer, logMockCall), its money through deps.spend and
// common/costs.ts.
import type { RouteModule } from '../http/router.ts'
import { notImplemented } from '../routes/stub.ts'

export const routes: RouteModule = () => [notImplemented('POST', /^\/api\/library\/product$/)]
