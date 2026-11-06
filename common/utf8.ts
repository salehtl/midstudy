// Python's strict UTF-8 decode (`bytes.decode("utf-8")`, `Path.read_text(encoding="utf-8")`), with the
// UnicodeDecodeError message Python gives, for the files both tools read as v1 did (library.json, costs.csv, a mock
// answer). A byte order mark is kept, as Python keeps it (so json.loads refuses it).

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** `bytes.decode("utf-8")`: the text, or Python's UnicodeDecodeError message. */
export function decodeUtf8(b: Uint8Array): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, text: decoder.decode(b) }
  } catch {
    return { ok: false, error: utf8Error(b) }
  }
}

function utf8Error(b: Uint8Array): string {
  const hex = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`
  let i = 0
  while (i < b.length) {
    const c = b[i] ?? 0
    if (c < 0x80) {
      i++
      continue
    }
    let need: number
    let lo = 0x80
    let hi = 0xbf
    if (c >= 0xc2 && c <= 0xdf) need = 1
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2
      if (c === 0xe0) lo = 0xa0
      if (c === 0xed) hi = 0x9f
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3
      if (c === 0xf0) lo = 0x90
      if (c === 0xf4) hi = 0x8f
    } else return `'utf-8' codec can't decode byte ${hex(c)} in position ${String(i)}: invalid start byte`
    for (let k = 1; k <= need; k++) {
      if (i + k >= b.length) {
        const end = b.length - 1
        return end > i
          ? `'utf-8' codec can't decode bytes in position ${String(i)}-${String(end)}: unexpected end of data`
          : `'utf-8' codec can't decode byte ${hex(c)} in position ${String(i)}: unexpected end of data`
      }
      const d = b[i + k] ?? 0
      const okRange = k === 1 ? d >= lo && d <= hi : d >= 0x80 && d <= 0xbf
      if (!okRange) {
        return k === 1
          ? `'utf-8' codec can't decode byte ${hex(c)} in position ${String(i)}: invalid continuation byte`
          : `'utf-8' codec can't decode bytes in position ${String(i)}-${String(i + k - 1)}: invalid continuation byte`
      }
    }
    i += need + 1
  }
  return "'utf-8' codec can't decode the data"
}

/** A failed strict decode, named as Python names it (`UnicodeDecodeError: 'utf-8' codec can't decode byte …`). */
class UnicodeDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnicodeDecodeError'
  }
}

/** The text of `b`, or a thrown UnicodeDecodeError with Python's message. */
export function utf8Text(b: Uint8Array): string {
  const d = decodeUtf8(b)
  if (!d.ok) throw new UnicodeDecodeError(d.error)
  return d.text
}
