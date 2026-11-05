// The registration seam for /api routes. Each route module (server/src/routes/*.ts, server/src/product/route.ts)
// exports `routes(deps: ServerDeps): readonly ApiRoute[]`; main.ts concatenates them in a fixed order and the
// dispatcher (server.ts) takes, per method, the first route whose pattern matches the whole decoded /api path, as
// v1's chain of `re.fullmatch` did. Everything before a handler runs (Host, framing, the forged-request check for
// mutations) and after it (strict mode, error mapping, the 404/405 fallbacks) is the dispatcher's.
import type { ServerDeps } from '../deps.ts'
import type { RequestContext } from './context.ts'

/** A route module: what it registers, given the server's dependencies (main.ts calls each once). */
export type RouteModule = (deps: ServerDeps) => readonly ApiRoute[]

/** The methods an /api route answers. A GET route also answers HEAD (v1 `do_HEAD = do_GET`), without the body. */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** One /api route. */
export interface ApiRoute {
  readonly method: ApiMethod
  /** v1's pattern, matched against the whole percent-decoded path (`re.fullmatch`): e.g. `/^\/api\/scenes\/([^/]*)$/`.
   *  Its groups are the handler's params (an unmatched group is ''). A route that must not take a value v1 skipped
   *  says so in the pattern (v1's `m.group(1) != "jobs"`: `/^\/api\/scenes\/(?!jobs$)([^/]*)$/`). */
  readonly path: RegExp
  /** Answers the request (ctx.send / ctx.error) or throws: HttpError → `{error}` with its status, Busy → 503 (v1
   *  library_busy), BodyStalled → 408 or a close, anything else → 500 `<Name>: <message>`. */
  readonly handle: (ctx: RequestContext, params: readonly string[]) => Promise<void>
}

/** The params of `path` in `apiPath` when it matches the whole of it, else null. */
export function matchPath(path: RegExp, apiPath: string): readonly string[] | null {
  const m = path.exec(apiPath)
  if (m?.index !== 0 || m[0].length !== apiPath.length) return null
  // An unmatched group is undefined at run time, whatever lib.d.ts says.
  return m.slice(1).map((g: string | undefined) => g ?? '')
}

/** The first route for `method` (GET for HEAD) whose pattern matches the whole `apiPath`, and its params. */
export function findRoute(routes: readonly ApiRoute[], method: string, apiPath: string): { readonly route: ApiRoute; readonly params: readonly string[] } | null {
  const wanted = method === 'HEAD' ? 'GET' : method
  for (const route of routes) {
    if (route.method !== wanted) continue
    const params = matchPath(route.path, apiPath)
    if (params !== null) return { route, params }
  }
  return null
}
