// Ids, layout and scene names (CLAUDE.md, contract §2.7): slugs, and the default id midstudy-add makes from a name.
// Pure (TScert).

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `^[a-z0-9][a-z0-9-]{0,63}$` over the whole string (a JS `$` without the m flag never matches before a newline, so
 *  `evil\n` is not a slug, as v1's `\Z`). */
export function isSlug(s: string): boolean {
  return SLUG.test(s)
}

/** v1's `slugify` after its NFKD step: non-ASCII dropped, lowercased, every run of other characters one `-`, no `-` at
 *  either end, at most 64 characters. */
export function slugifyDecomposed(nfkd: string): string {
  const ascii = nfkd.replace(/[^\x00-\x7f]/g, '').toLowerCase()
  const dashed = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '')
  return dashed.slice(0, 64).replace(/-+$/, '')
}

/** midstudy-add's default id from a name (v1 `slugify`: `unicodedata.normalize("NFKD", …)` then ASCII only): `""`
 *  when nothing is left. */
export function slugify(text: string): string {
  return slugifyDecomposed(text.normalize('NFKD'))
}

/** Python's `PurePosixPath(s).name`: the last component, empty and `.` components dropped (`a/b/` → `b`, `/` → ``). */
export function posixName(s: string): string {
  const parts = s.split('/').filter((p) => p !== '' && p !== '.')
  return parts.at(-1) ?? ''
}
