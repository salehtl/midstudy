// Static files' Content-Type (contract §2.1): v1's MIME table (planner/serve.py `MIME`, over http.server's own), then
// the few of Python's mimetypes defaults a planner build can hold, else application/octet-stream (as v1 for `.map`
// and files without an extension). Pure (TScert).

const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.wasm', 'application/wasm'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.bin', 'application/octet-stream'],
  ['.spz', 'application/octet-stream'],
  ['.ply', 'application/octet-stream'],
  ['.splat', 'application/octet-stream'],
  ['.ksplat', 'application/octet-stream'],
  ['.sog', 'application/octet-stream'],
  // http.server's SimpleHTTPRequestHandler.extensions_map
  ['.gz', 'application/gzip'],
  ['.Z', 'application/octet-stream'],
  ['.bz2', 'application/x-bzip2'],
  ['.xz', 'application/x-xz'],
  // Python's mimetypes defaults (the guess v1 fell back to)
  ['.gif', 'image/gif'],
  ['.ico', 'image/vnd.microsoft.icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.xml', 'text/xml'],
  ['.pdf', 'application/pdf'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.avif', 'image/avif'],
])

/** `posixpath.splitext(path)[1]`: the last component's extension, `''` for none or a leading-dot name. */
export function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  // a name of only dots and the extension (`..x`) has none, as splitext says
  if (/^\.+$/.test(name.slice(0, dot))) return ''
  return name.slice(dot)
}

/** v1's `guess_type`: the extension as written, then lowercased, else application/octet-stream. */
export function mimeType(path: string): string {
  const ext = extension(path)
  return TYPES.get(ext) ?? TYPES.get(ext.toLowerCase()) ?? 'application/octet-stream'
}
