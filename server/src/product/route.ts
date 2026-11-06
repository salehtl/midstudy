// POST /api/library/product (contract §2.11): what a shop's product page says, from its link or from a copy of it the
// user's browser made. It adds nothing; a bad page is a 422 (read.ts). §2.9's rules (X-Midstudy, Origin, Host) were
// checked by the dispatcher before this runs. The body's checks and sentences are v1's (serve.py
// post_library_product).
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import type { RouteModule } from '../http/router.ts'
import { cpLength } from './logic/text.ts'
import { readProduct } from './read.ts'

const SHAPE = 'the body must be JSON like {"url": "https://...", "llm": true}, or {"html": "<the page>", "url": "https://..."}'

export const routes: RouteModule = (deps) => [
  {
    method: 'POST',
    path: /^\/api\/library\/product$/,
    handle: async (ctx) => {
      const body: unknown = await ctx.readJson()
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        await ctx.error(400, SHAPE)
        return
      }
      const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k)
      const url: unknown = has('url') ? Reflect.get(body, 'url') : null
      const page: unknown = has('html') ? Reflect.get(body, 'html') : null
      if (page !== null && (typeof page !== 'string' || pyStrip(page) === '')) {
        await ctx.error(400, "html must be the page's source as text")
        return
      }
      if (url !== null && (typeof url !== 'string' || cpLength(url) > 4096)) {
        await ctx.error(400, SHAPE)
        return
      }
      const link = typeof url === 'string' && pyStrip(url) !== '' ? pyStrip(url) : null
      if (link === null && page === null) {
        await ctx.error(400, SHAPE)
        return
      }
      const llm: unknown = has('llm') ? Reflect.get(body, 'llm') : true
      if (typeof llm !== 'boolean') {
        await ctx.error(400, 'llm must be true or false')
        return
      }
      const answer = await readProduct(link, llm, typeof page === 'string' ? page : null, deps)
      await ctx.send(answer.status, answer.body)
    },
  },
]
