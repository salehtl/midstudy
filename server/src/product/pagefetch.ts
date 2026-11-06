// Fetching a product page and its feeds (contract §2.9 Page fetches) through the server's safe fetcher
// (server/src/fetch.ts: each hop resolved once, checked and pinned, private addresses refused before any connection,
// MIDSTUDY_FETCH_ALLOW the only exemption), with v1's limits (5 redirects, 20 s for the page and its feeds together, the
// first 10 MB of the page, feeds 2 MB and only to the page's origin, gzip/deflate decoded within the limit, no
// cookies, an honest User-Agent) and v1's sentences for each way a fetch stops.
import { Budget, FetchFailed, PRIVATE, safeFetch, type FetchFailure, type FetchResult } from '../fetch.ts'
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import { PageTimeout, ProductError } from './errors.ts'

const UA = 'midstudy/1.0 (product page reader)'
export const PAGE_MAX = 10 * 1024 * 1024
const FEED_MAX = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
/** v1's BUDGET_S: the page and its feeds together. */
export const BUDGET_MS = 20 * 1000

/** v1's errors for each way `_get` stopped (a decoding error escaped v1's handler: its generic 422). */
function failure(f: FetchFailure): Error {
  switch (f.kind) {
    case 'bad-url':
    case 'bad-port':
      return new ProductError(400, "that link isn't a valid web address: paste the product page's full address")
    case 'scheme':
      return new ProductError(400, "only http and https links work: paste the product page's web address")
    case 'no-host':
      return new ProductError(400, "that link has no host name: paste the product page's full web address")
    case 'dns':
      return new ProductError(400, `couldn't find ${f.host}: check the link`)
    case 'private':
      return new ProductError(400, PRIVATE)
    case 'cross-origin':
      return new ProductError(422, "the shop's feed redirects to another site")
    case 'redirect-without-location':
      return new ProductError(422, `the page redirects (HTTP ${String(f.status)}) without saying where`)
    case 'too-many-redirects':
      return new ProductError(422, `the link redirects more than ${String(MAX_REDIRECTS)} times: open it in a browser and paste the address it ends on`)
    case 'timeout':
      return new PageTimeout()
    case 'tls':
      return new ProductError(422, `couldn't connect securely to ${f.host}: check the link opens in a browser`)
    case 'network':
      return new ProductError(422, `couldn't read the page from ${f.host}: check the link opens in a browser`)
    case 'encoding':
      return new ProductError(422, `the page came in an encoding this reader can't decode (${f.encoding})`)
    case 'too-large':
    case 'decode':
    case 'refused':
      return new Error(`fetch failed: ${f.kind}`)
  }
}

/** v1's `_get`: a GET under §2.9's rules; the body is read only for a 200. Throws ProductError, PageTimeout, or an
 *  Error v1 had no sentence for. */
export async function getPage(url: string, budget: Budget, maxBytes: number, accept: string, sameOrigin?: string): Promise<FetchResult> {
  try {
    return await safeFetch(url, {
      budget,
      maxRedirects: MAX_REDIRECTS,
      maxBytes,
      overflow: 'cut',
      decode: true,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Encoding': 'gzip, deflate', 'Accept-Language': 'en' },
      ...(sameOrigin === undefined ? {} : { sameOrigin }),
      // shops send odd headers; v1's http.client read them
      insecureHTTPParser: true,
    })
  } catch (e) {
    if (e instanceof FetchFailed) throw failure(e.failure)
    throw e
  }
}

/** The page itself. */
export function fetchPage(url: string, budget: Budget): Promise<FetchResult> {
  return getPage(url, budget, PAGE_MAX, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5')
}

/** A feed (2 MB, the page's origin only). */
export function fetchFeed(url: string, budget: Budget, origin: string): Promise<FetchResult> {
  return getPage(url, budget, FEED_MAX, 'application/json, text/javascript;q=0.9, */*;q=0.1', origin)
}

/** A response's media type (`r.ctype`). */
export function contentTypeOf(r: FetchResult): string {
  return pyStrip((r.headers['content-type'] ?? '').split(';')[0] ?? '').toLowerCase()
}

