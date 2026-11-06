//! v1's `NUM` pattern (a number as shops write it: `80`, `80,5`, `31 1/2`, `41 ¾`, `1/2`, `½`) and `_num`, which
//! reads one.
//!
//! `NUM` is matched by hand: at one position it yields every end the backtracking `re` engine would try, in the
//! order it would try them, so a caller whose continuation fails moves on to the next end exactly as v1's patterns
//! did. Digit runs are bounded (at most 7, 4, 3 digits), so there are at most a few dozen ends per position.
use crate::chars::{add, at, digit_run, digit_value, is, is_digit, is_space, strip};

/// The vulgar fractions v1 read, with their values (`_FR`).
const FRACTIONS: [(char, f64); 15] = [
    ('\u{bd}', 0.5),
    ('\u{bc}', 0.25),
    ('\u{be}', 0.75),
    ('\u{2153}', 1.0 / 3.0),
    ('\u{2154}', 2.0 / 3.0),
    ('\u{215b}', 0.125),
    ('\u{215c}', 0.375),
    ('\u{215d}', 0.625),
    ('\u{215e}', 0.875),
    ('\u{2155}', 0.2),
    ('\u{2156}', 0.4),
    ('\u{2157}', 0.6),
    ('\u{2158}', 0.8),
    ('\u{2159}', 1.0 / 6.0),
    ('\u{215a}', 5.0 / 6.0),
];

/// The value of a vulgar fraction character.
pub(crate) fn fraction_value(c: char) -> Option<f64> {
    FRACTIONS.iter().find(|(f, _)| *f == c).map(|(_, v)| *v)
}

fn is_slash(c: char) -> bool {
    c == '/' || c == '\u{2044}'
}

/// `[ ]?[/⁄][ ]?\d{1,3}(?!\d)` at `r`: the end, if it matches (there is only ever one way).
fn fraction_tail(s: &[char], r: usize) -> Option<usize> {
    let r = if at(s, r) == Some(' ') && is(at(s, add(r, 1)), is_slash) {
        add(r, 2)
    } else if is(at(s, r), is_slash) {
        add(r, 1)
    } else {
        return None;
    };
    let d = if at(s, r) == Some(' ') { add(r, 1) } else { r };
    let m = digit_run(s, d, 4);
    (1..=3).contains(&m).then(|| add(d, m))
}

/// `\d{1,3}` + `fraction_tail` at `q` (`31/2`, the part after the whole number in `31 1/2`).
fn numerator_fraction(s: &[char], q: usize) -> Option<usize> {
    let n = digit_run(s, q, 4);
    if (1..=3).contains(&n) {
        fraction_tail(s, add(q, n))
    } else {
        None
    }
}

/// The optional fraction after a whole number, both alternatives in order: `(?:[  ]+|-)\d{1,3}…` then `[  ]?[½…]`.
fn fraction_parts(s: &[char], p2: usize, out: &mut Vec<usize>) {
    let sp = |c: char| c == ' ' || c == '\u{a0}';
    let lead = s
        .get(p2..)
        .map_or(0, |t| t.iter().take_while(|c| sp(**c)).count());
    let q = if lead > 0 {
        Some(add(p2, lead))
    } else if at(s, p2) == Some('-') {
        Some(add(p2, 1))
    } else {
        None
    };
    if let Some(end) = q.and_then(|q| numerator_fraction(s, q)) {
        out.push(end);
    }
    if is(at(s, p2), sp) {
        if is(at(s, add(p2, 1)), |c| fraction_value(c).is_some()) {
            out.push(add(p2, 2));
        }
    } else if is(at(s, p2), |c| fraction_value(c).is_some()) {
        out.push(add(p2, 1));
    }
}

/// Every end of `NUM` at `p`, in the order v1's engine tries them (empty when `NUM` can't start at `p`).
pub(crate) fn num_ends(s: &[char], p: usize, out: &mut Vec<usize>) {
    out.clear();
    let Some(c0) = at(s, p) else { return };
    if is_digit(c0) {
        let whole = digit_run(s, p, 7);
        for k in (1..=whole).rev() {
            let p1 = add(p, k);
            let mut decimals: Vec<usize> = Vec::new();
            if is(at(s, p1), |c| c == '.' || c == ',') {
                let e = digit_run(s, add(p1, 1), 4);
                decimals.extend((1..=e).rev().map(|j| add(p1, add(1, j))));
            }
            decimals.push(p1);
            for p2 in decimals {
                fraction_parts(s, p2, out);
                out.push(p2);
            }
        }
        if let Some(end) = numerator_fraction(s, p) {
            out.push(end);
        }
    } else if fraction_value(c0).is_some() {
        out.push(add(p, 1));
    }
}

/// The first end of `NUM` at `p` (what a pattern whose rest is optional takes).
pub(crate) fn num_first(s: &[char], p: usize) -> Option<usize> {
    let mut ends = Vec::new();
    num_ends(s, p, &mut ends);
    ends.first().copied()
}

/// A run of Python digits (any script) as the ASCII digits `float()` and `int()` read.
fn ascii_digits(s: &[char]) -> Option<String> {
    s.iter()
        .map(|c| digit_value(*c).and_then(|d| char::from_digit(d, 10)))
        .collect()
}

fn digits_value(s: &[char]) -> Option<f64> {
    ascii_digits(s)?.parse::<f64>().ok()
}

/// `\d+` at `i`: its end (`i` when there is none).
fn digits_end(s: &[char], i: usize) -> usize {
    add(
        i,
        s.get(i..)
            .map_or(0, |t| t.iter().take_while(|c| is_digit(**c)).count()),
    )
}

/// `(\d+)\s*[/⁄]\s*(\d+)` matched against the whole of `s` (its groups).
fn full_fraction(s: &[char], i: usize) -> Option<(usize, usize, usize)> {
    let a_end = digits_end(s, i);
    if a_end == i {
        return None;
    }
    let mut j = a_end;
    while is(at(s, j), is_space) {
        j = add(j, 1);
    }
    if !is(at(s, j), is_slash) {
        return None;
    }
    j = add(j, 1);
    while is(at(s, j), is_space) {
        j = add(j, 1);
    }
    let b_end = digits_end(s, j);
    (b_end > j && b_end == s.len()).then_some((a_end, j, b_end))
}

/// v1's `_num`: a number's value (`80`, `80,5`, `1,200`, `31 1/2`, `31-1/2`, `41 ¾`, `1/2`, `½`), or None.
pub(crate) fn py_num(text: &str) -> Option<f64> {
    let chars: Vec<char> = text.chars().collect();
    let mut s: Vec<char> = strip(&chars)
        .iter()
        .map(|c| if *c == '\u{a0}' { ' ' } else { *c })
        .collect();
    let mut total = 0.0;
    if let Some(v) = s.last().copied().and_then(fraction_value) {
        total += v;
        s.pop();
        s = strip(&s).to_vec();
        if s.is_empty() {
            return Some(total);
        }
    }
    if s.is_empty() {
        return None;
    }
    // (\d+(?:[.,]\d+)?)(?:(?:\s+|-)(\d+)\s*[/⁄]\s*(\d+))?   as a full match
    let int_end = digits_end(&s, 0);
    if int_end > 0 {
        let mut whole_end = int_end;
        if is(at(&s, int_end), |c| c == '.' || c == ',') {
            let frac_end = digits_end(&s, add(int_end, 1));
            if frac_end > add(int_end, 1) {
                whole_end = frac_end;
            }
        }
        let rest_ok = if whole_end == s.len() {
            Some(None)
        } else {
            let mut j = whole_end;
            let lead = s
                .get(j..)
                .map_or(0, |t| t.iter().take_while(|c| is_space(**c)).count());
            if lead > 0 {
                j = add(j, lead);
            } else if at(&s, j) == Some('-') {
                j = add(j, 1);
            } else {
                j = usize::MAX;
            }
            if j == usize::MAX {
                None
            } else {
                full_fraction(&s, j).map(|(a_end, b_start, b_end)| Some((j, a_end, b_start, b_end)))
            }
        };
        if let Some(frac) = rest_ok {
            let whole: Vec<char> = s.get(..whole_end).unwrap_or_default().to_vec();
            let text_whole: String = if whole.contains(&',') {
                let thousands = whole.len() >= 5 && whole.len() <= 7 && {
                    let comma = whole.iter().position(|c| *c == ',').unwrap_or(0);
                    (1..=3).contains(&comma) && whole.len().saturating_sub(comma) == 4
                };
                let mapped: String = whole
                    .iter()
                    .filter_map(|c| match c {
                        ',' if thousands => None,
                        ',' => Some('.'),
                        c => digit_value(*c)
                            .and_then(|d| char::from_digit(d, 10))
                            .or(Some(*c)),
                    })
                    .collect();
                mapped
            } else {
                whole
                    .iter()
                    .map(|c| {
                        digit_value(*c)
                            .and_then(|d| char::from_digit(d, 10))
                            .unwrap_or(*c)
                    })
                    .collect()
            };
            total += text_whole.parse::<f64>().ok()?;
            if let Some((a_start, a_end, b_start, b_end)) = frac {
                let num = digits_value(s.get(a_start..a_end).unwrap_or_default())?;
                let den = digits_value(s.get(b_start..b_end).unwrap_or_default())?;
                if den != 0.0 {
                    total += num / den;
                }
            }
            return Some(total);
        }
    }
    let (a_end, b_start, b_end) = full_fraction(&s, 0)?;
    let num = digits_value(s.get(..a_end).unwrap_or_default())?;
    let den = digits_value(s.get(b_start..b_end).unwrap_or_default())?;
    (den != 0.0).then(|| total + num / den)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ends(t: &str) -> Vec<usize> {
        let s: Vec<char> = t.chars().collect();
        let mut out = Vec::new();
        num_ends(&s, 0, &mut out);
        out
    }

    #[test]
    fn num_matches_like_v1() {
        assert_eq!(ends("80 cm").first(), Some(&2));
        assert_eq!(ends("31 1/2\"").first(), Some(&6));
        assert_eq!(ends("41 \u{be}").first(), Some(&4));
        assert_eq!(ends("12/34").first(), Some(&2)); // the whole number first; 12/34 is the last alternative
        assert_eq!(ends("12/34").last(), Some(&5));
        assert_eq!(ends("12345678").first(), Some(&7));
        assert!(ends("x").is_empty());
    }

    #[test]
    fn reads_numbers_like_v1() {
        assert_eq!(py_num("80"), Some(80.0));
        assert_eq!(py_num("80,5"), Some(80.5));
        assert_eq!(py_num("1,200"), Some(1200.0));
        assert_eq!(py_num("31 1/2"), Some(31.5));
        assert_eq!(py_num("31-1/2"), Some(31.5));
        assert_eq!(py_num("41 \u{be}"), Some(41.75));
        assert_eq!(py_num("\u{bd}"), Some(0.5));
        assert_eq!(py_num("1/2"), Some(0.5));
        assert_eq!(py_num("1/0"), None);
        assert_eq!(py_num("3 1/0"), Some(3.0));
        assert_eq!(py_num("\u{663}\u{660}"), Some(30.0));
        assert_eq!(py_num(""), None);
        assert_eq!(py_num("abc"), None);
    }
}
