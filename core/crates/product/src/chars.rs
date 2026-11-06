//! Python 3.12's `re` character classes, as v1's patterns saw them (str patterns, `re.I` where v1 set it), over text
//! held as code points: v1 indexed strings by code point, so every position, slice and length here is one too.
use crate::tables::{PY_DIGIT, PY_SPACE, PY_WORD};

/// The code point at `i`, if any.
pub(crate) fn at(s: &[char], i: usize) -> Option<char> {
    s.get(i).copied()
}

/// `i + n` (positions never come near `usize::MAX`; saturating keeps the arithmetic panic-free).
pub(crate) fn add(i: usize, n: usize) -> usize {
    i.saturating_add(n)
}

fn in_ranges(table: &[(u32, u32)], c: char) -> Option<u32> {
    let cp = u32::from(c);
    let i = table.partition_point(|&(_, hi)| hi < cp);
    match table.get(i) {
        Some(&(lo, hi)) if lo <= cp && cp <= hi => Some(lo),
        _ => None,
    }
}

/// Python's `\w`: `str.isalnum()` or `_`.
pub(crate) fn is_word(c: char) -> bool {
    if c.is_ascii() {
        c.is_ascii_alphanumeric() || c == '_'
    } else {
        in_ranges(PY_WORD, c).is_some()
    }
}

/// Python's `\s` (`str.isspace()`): Unicode `White_Space` plus U+001C–U+001F.
pub(crate) fn is_space(c: char) -> bool {
    PY_SPACE.binary_search(&u32::from(c)).is_ok()
}

/// The value of a Python `\d` (Unicode Nd) digit, as `int()` and `float()` read it.
pub(crate) fn digit_value(c: char) -> Option<u32> {
    if c.is_ascii_digit() {
        return u32::from(c).checked_sub(u32::from('0'));
    }
    let lo = in_ranges(PY_DIGIT, c)?;
    u32::from(c).checked_sub(lo).map(|d| d % 10)
}

/// Python's `\d`.
pub(crate) fn is_digit(c: char) -> bool {
    digit_value(c).is_some()
}

/// `Some(c)` passes `pred`.
pub(crate) fn is(c: Option<char>, pred: impl Fn(char) -> bool) -> bool {
    c.is_some_and(pred)
}

/// How many Python digits start at `i`, counting at most `cap`.
pub(crate) fn digit_run(s: &[char], i: usize, cap: usize) -> usize {
    s.get(i..).map_or(0, |t| {
        t.iter().take(cap).take_while(|c| is_digit(**c)).count()
    })
}

/// The position after the run of Python whitespace at `i` (`\s*`, greedy).
pub(crate) fn skip_ws(s: &[char], i: usize) -> usize {
    add(
        i,
        s.get(i..)
            .map_or(0, |t| t.iter().take_while(|c| is_space(**c)).count()),
    )
}

fn simple_lower(c: char) -> char {
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// `c` matches the pattern literal `lit` under `re.I`: ASCII letters in either case, plus the four non-ASCII letters
/// Python folds onto them (ı and İ onto i, ſ onto s, the Kelvin sign onto k); any other letter by its lowercase.
pub(crate) fn ci(c: char, lit: char) -> bool {
    if c == lit {
        return true;
    }
    if lit.is_ascii_lowercase() {
        if c == lit.to_ascii_uppercase() {
            return true;
        }
        return match lit {
            'i' => c == '\u{131}' || c == '\u{130}',
            's' => c == '\u{17f}',
            'k' => c == '\u{212a}',
            _ => false,
        };
    }
    !lit.is_ascii() && simple_lower(c) == simple_lower(lit)
}

/// `[a-z]` (or `[A-Za-z]`) under `re.I`: the ASCII letters and ı, İ, ſ, K.
pub(crate) fn az_ci(c: char) -> bool {
    c.is_ascii_alphabetic() || matches!(c, '\u{131}' | '\u{130}' | '\u{17f}' | '\u{212a}')
}

/// `[A-Za-z0-9]` under `re.I`.
pub(crate) fn alnum_ci(c: char) -> bool {
    az_ci(c) || c.is_ascii_digit()
}

/// The literal `lit` (lowercase ASCII, or any other character) under `re.I` at `i`: the position after it.
pub(crate) fn lit_ci(s: &[char], i: usize, lit: &str) -> Option<usize> {
    let mut j = i;
    for l in lit.chars() {
        if !is(at(s, j), |c| ci(c, l)) {
            return None;
        }
        j = add(j, 1);
    }
    Some(j)
}

/// Python's `str.strip()` (its whitespace), on code points.
pub(crate) fn strip(s: &[char]) -> &[char] {
    let start = s.iter().take_while(|c| is_space(**c)).count();
    let rest = s.get(start..).unwrap_or_default();
    let end = rest
        .len()
        .saturating_sub(rest.iter().rev().take_while(|c| is_space(**c)).count());
    rest.get(..end).unwrap_or_default()
}

/// Python's `str.strip()` on a `&str`.
pub(crate) fn strip_str(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s[a:b]` as Python slices (bounds clamped, an inverted range empty).
pub(crate) fn slice(s: &[char], a: usize, b: usize) -> &[char] {
    let b = b.min(s.len());
    s.get(a.min(b)..b).unwrap_or_default()
}

/// `s[:n]` of a `&str`, by code points.
pub(crate) fn prefix(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => s.get(..i).unwrap_or(s),
        None => s,
    }
}

/// Python's `re.sub(r"\s+", " ", s)`.
pub(crate) fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// Python's `str.lower()`.
pub(crate) fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// Code points to a `String`.
pub(crate) fn text(s: &[char]) -> String {
    s.iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_classes() {
        assert!(
            is_space('\u{1c}')
                && is_space('\u{a0}')
                && is_space('\u{3000}')
                && !is_space('\u{200b}')
        );
        assert!(!is_space('\u{feff}'));
        assert_eq!(digit_value('\u{663}'), Some(3)); // Arabic-Indic three
        assert_eq!(digit_value('7'), Some(7));
        assert_eq!(digit_value('\u{b2}'), None); // ² is not \d
        assert!(is_word('\u{b2}') && is_word('\u{bd}') && is_word('_') && !is_word('-'));
        assert!(!is_word('\u{301}')); // a combining mark is not \w in Python
        assert!(
            ci('\u{131}', 'i') && ci('\u{130}', 'i') && ci('\u{17f}', 's') && ci('\u{212a}', 'k')
        );
        assert!(ci('\u{d8}', '\u{f8}') && ci('\u{d6}', '\u{f6}') && !ci('x', 'y'));
        assert!(az_ci('\u{17f}') && !az_ci('\u{e9}'));
        assert_eq!(
            text(strip(&" \u{1c} ab\u{a0}".chars().collect::<Vec<_>>())),
            "ab"
        );
    }
}
