// `shlex.split(s)` (POSIX mode, no comments), the way v1 split --calib and --midstudy-add once at startup into the
// argument list it always ran without a shell. Pure (TScert): a port of CPython's shlex.read_token for these settings.

/** The argument list, or Python's ValueError sentence. */
export type SplitResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly error: 'No closing quotation' | 'No escaped character' }

const WHITESPACE = ' \t\r\n'

function isWhitespace(c: string): boolean {
  return c !== '' && WHITESPACE.includes(c)
}

function isQuote(c: string): boolean {
  return c === '"' || c === "'"
}

/** Python's `shlex.split(s)`: whitespace separates words, `'…'` is literal, `"…"` keeps a backslash except before `"`
 *  or `\`, a backslash outside quotes escapes any character, quoted empty strings are words. */
export function shlexSplit(s: string): SplitResult {
  const words: string[] = []
  let i = 0
  for (;;) {
    // read_token(): one word, or the end.
    let state = ' '
    let escapedState = ' '
    let token = ''
    let quoted = false
    let done = false
    while (!done) {
      const c = i < s.length ? s.charAt(i) : ''
      i += 1
      if (state === ' ') {
        if (c === '') {
          done = true
        } else if (isWhitespace(c)) {
          if (token !== '' || quoted) done = true
        } else if (c === '\\') {
          escapedState = 'a'
          state = '\\'
        } else if (isQuote(c)) {
          state = c
        } else {
          token = c
          state = 'a'
        }
      } else if (isQuote(state)) {
        quoted = true
        if (c === '') return { ok: false, error: 'No closing quotation' }
        if (c === state) {
          state = 'a'
        } else if (c === '\\' && state === '"') {
          escapedState = state
          state = '\\'
        } else {
          token += c
        }
      } else if (state === '\\') {
        if (c === '') return { ok: false, error: 'No escaped character' }
        // In POSIX shells only the quote itself or the escape character may be escaped within quotes.
        if (isQuote(escapedState) && c !== '\\' && c !== escapedState) token += '\\'
        token += c
        state = escapedState
      } else {
        // state 'a': inside a word
        if (c === '') {
          done = true
        } else if (isWhitespace(c)) {
          state = ' '
          if (token !== '' || quoted) done = true
        } else if (isQuote(c)) {
          state = c
        } else if (c === '\\') {
          escapedState = 'a'
          state = '\\'
        } else {
          token += c
        }
      }
    }
    if (!quoted && token === '') {
      if (i > s.length) return { ok: true, value: words }
      continue
    }
    words.push(token)
    if (i > s.length) return { ok: true, value: words }
  }
}
