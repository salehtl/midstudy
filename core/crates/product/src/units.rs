//! Units: v1's `UNITS`, `_IN_U` and `_FT_U` patterns (each end in the order `re` tries them, with their negative
//! lookaheads), and `_unit`, which names the unit a matched token is.
use crate::chars::{add, at, az_ci, is, lit_ci, lower, strip_str};
use serde::{Deserialize, Serialize};

/// A unit a page measures in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    /// centimetres
    Cm,
    /// millimetres
    Mm,
    /// metres
    M,
    /// inches
    In,
    /// feet
    Ft,
}

impl Unit {
    /// v1's `_CM`: centimetres per unit.
    pub(crate) fn cm(self) -> f64 {
        match self {
            Self::Cm => 1.0,
            Self::Mm => 0.1,
            Self::M => 100.0,
            Self::In => 2.54,
            Self::Ft => 30.48,
        }
    }

    /// The unit's name in answers (`cm`, `in`, …).
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Cm => "cm",
            Self::Mm => "mm",
            Self::M => "m",
            Self::In => "in",
            Self::Ft => "ft",
        }
    }

    /// v1's `_UNIT_WORD`.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Cm => "centimetres",
            Self::Mm => "millimetres",
            Self::M => "metres",
            Self::In => "inches",
            Self::Ft => "feet",
        }
    }

    /// The unit named `s` exactly (`cm`, `mm`, `m`, `in`, `ft`).
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cm" => Some(Self::Cm),
            "mm" => Some(Self::Mm),
            "m" => Some(Self::M),
            "in" => Some(Self::In),
            "ft" => Some(Self::Ft),
            _ => None,
        }
    }
}

/// v1's `_unit`: the unit a matched token names, or None.
pub(crate) fn unit_of(token: &str) -> Option<Unit> {
    if token.is_empty() {
        return None;
    }
    let t = lower(strip_str(token));
    let t = t.trim_end_matches('.');
    if ["\"", "\u{2033}", "\u{201d}", "''", "\u{2032}\u{2032}"].contains(&t)
        || t.starts_with("inch")
        || t == "in"
    {
        return Some(Unit::In);
    }
    if ["'", "\u{2032}", "\u{2019}", "ft", "feet", "foot"].contains(&t) {
        return Some(Unit::Ft);
    }
    if t == "cm" || t == "cms" || t.starts_with("centimet") {
        return Some(Unit::Cm);
    }
    if t == "mm" || t.starts_with("millimet") {
        return Some(Unit::Mm);
    }
    if t == "m" || t.starts_with("met") {
        return Some(Unit::M);
    }
    None
}

/// The word alternatives of `UNITS`, each expanded in the order `re` tries its options (greedy `s?`, `(?:er|re)`).
const UNIT_WORDS: [&str; 24] = [
    "cms",
    "cm",
    "centimeters",
    "centimeter",
    "centimetres",
    "centimetre",
    "mm",
    "millimeters",
    "millimeter",
    "millimetres",
    "millimetre",
    "meters",
    "meter",
    "metres",
    "metre",
    "m",
    "inches",
    "inch",
    "in.",
    "in",
    "ft.",
    "ft",
    "feet",
    "foot",
];

fn ends_with_word(
    s: &[char],
    p: usize,
    words: &[&str],
    stop: impl Fn(char) -> bool,
    out: &mut Vec<usize>,
) {
    for w in words {
        if let Some(e) = lit_ci(s, p, w)
            && !is(at(s, e), &stop)
        {
            out.push(e);
        }
    }
}

/// Every end of `UNITS` at `p`, in order.
pub(crate) fn units_ends(s: &[char], p: usize, out: &mut Vec<usize>) {
    out.clear();
    ends_with_word(
        s,
        p,
        &UNIT_WORDS,
        |c| az_ci(c) || c == '\u{b2}' || c == '\u{b3}',
        out,
    );
    marks(s, p, out);
}

/// The quote-mark units, in `UNITS`' order: `"`, `″`, `”`, `''`, `′′`, `'(?!')`, `′(?!′)`, `’`.
fn marks(s: &[char], p: usize, out: &mut Vec<usize>) {
    let c0 = at(s, p);
    let c1 = at(s, add(p, 1));
    match c0 {
        Some('"' | '\u{2033}' | '\u{201d}') => out.push(add(p, 1)),
        Some('\'') if c1 == Some('\'') => out.push(add(p, 2)),
        Some('\u{2032}') if c1 == Some('\u{2032}') => out.push(add(p, 2)),
        _ => {}
    }
    match c0 {
        Some('\'') if c1 != Some('\'') => out.push(add(p, 1)),
        Some('\u{2032}') if c1 != Some('\u{2032}') => out.push(add(p, 1)),
        Some('\u{2019}') => out.push(add(p, 1)),
        _ => {}
    }
}

/// The first end of `UNITS` at `p`.
pub(crate) fn units_first(s: &[char], p: usize) -> Option<usize> {
    let mut out = Vec::new();
    units_ends(s, p, &mut out);
    out.first().copied()
}

/// Every end of `_IN_U` at `p`: `"`, `″`, `”`, `''`, `′′`, then `inch(?:es)?|in\.?` not followed by a letter.
pub(crate) fn inch_ends(s: &[char], p: usize, out: &mut Vec<usize>) {
    out.clear();
    match (at(s, p), at(s, add(p, 1))) {
        (Some('"' | '\u{2033}' | '\u{201d}'), _) => out.push(add(p, 1)),
        (Some('\''), Some('\'')) | (Some('\u{2032}'), Some('\u{2032}')) => out.push(add(p, 2)),
        _ => {}
    }
    ends_with_word(s, p, &["inches", "inch", "in.", "in"], az_ci, out);
}

/// Every end of `_FT_U` at `p`: `'(?!')`, `′(?!′)`, `’`, then `ft\.?|feet|foot` not followed by a letter.
pub(crate) fn feet_ends(s: &[char], p: usize, out: &mut Vec<usize>) {
    out.clear();
    let c1 = at(s, add(p, 1));
    match at(s, p) {
        Some('\'') if c1 != Some('\'') => out.push(add(p, 1)),
        Some('\u{2032}') if c1 != Some('\u{2032}') => out.push(add(p, 1)),
        Some('\u{2019}') => out.push(add(p, 1)),
        _ => {}
    }
    ends_with_word(s, p, &["ft.", "ft", "feet", "foot"], az_ci, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(t: &str) -> Option<usize> {
        let s: Vec<char> = t.chars().collect();
        units_first(&s, 0)
    }

    #[test]
    fn units_like_v1() {
        assert_eq!(first("cm"), Some(2));
        assert_eq!(first("cms"), Some(3));
        assert_eq!(first("cmx"), None);
        assert_eq!(first("m\u{b2}"), None);
        assert_eq!(first("inches"), Some(6));
        assert_eq!(first("in."), Some(3));
        assert_eq!(first("''"), Some(2));
        assert_eq!(first("'x"), Some(1));
        assert_eq!(first("Metres"), Some(6));
        assert_eq!(unit_of("Inches"), Some(Unit::In));
        assert_eq!(unit_of("\u{2019}"), Some(Unit::Ft));
        assert_eq!(unit_of("cms"), Some(Unit::Cm));
        assert_eq!(unit_of("Metre."), Some(Unit::M));
        assert_eq!(unit_of("\u{130}nches"), None); // İ lowers to i + a dot, as in Python
        assert_eq!(unit_of(""), None);
    }
}
