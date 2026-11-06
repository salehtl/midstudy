// The page's address as v1 read it (Python's urlsplit): `_target` (the 400s before anything is fetched) and
// `_public_url` (no user:password@, no #fragment: the address is answered, and the cost row is in git).
import { urlHostname, urlPort, urlsplit, urlunsplit, type SplitUrl } from '../logic/url.ts'
import { ProductError } from './errors.ts'

/** v1's `_target`: the link's parts, or ProductError 400 with v1's sentence. */
export function target(url: string): SplitUrl {
  const parts = urlsplit(url)
  if (parts === null || urlPort(parts) === 'invalid') {
    throw new ProductError(400, "that link isn't a valid web address: paste the product page's full address")
  }
  const scheme = parts.scheme.toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') throw new ProductError(400, "only http and https links work: paste the product page's web address")
  if (urlHostname(parts) === null) throw new ProductError(400, "that link has no host name: paste the product page's full web address")
  return parts
}

/** v1's `_public_url`: the link without a user:password@ part or a #fragment. */
export function publicUrl(url: string): string {
  const p = urlsplit(url)
  if (p === null) return url
  let host = urlHostname(p) ?? ''
  if (host.includes(':')) host = `[${host}]`
  const port = urlPort(p)
  const portText = typeof port === 'number' && port !== 0 ? `:${String(port)}` : ''
  return urlunsplit({ scheme: p.scheme, netloc: host + portText, path: p.path, query: p.query, fragment: '' })
}
