//! Slugs and generated names (CLAUDE.md Conventions: "Ids, layout and scene names are slugs:
//! `^[a-z0-9][a-z0-9-]{0,63}$`"; contract §2.7: "a slug never ends in a newline: every slug check matches the whole
//! string"; §4.2 scene names `scene-YYYYMMDD-HHMMSS` with `-2`, `-3`… on collision; §2.6 render names).
//!
//! v1: `SLUG`, `RENDER_NAME` and `name_order` in `planner/serve.py`.

use core::cmp::Ordering;

/// The longest slug.
pub const MAX_SLUG_LEN: usize = 64;

/// `^[a-z0-9][a-z0-9-]{0,63}$` over the whole string (v1's `\Z`: no trailing newline).
#[must_use]
pub fn is_slug(s: &str) -> bool {
    let Some((first, rest)) = s.as_bytes().split_first() else {
        return false;
    };
    s.len() <= MAX_SLUG_LEN
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && rest
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn digits(s: &str, n: usize) -> Option<&str> {
    let (head, tail) = s.split_at_checked(n)?;
    head.bytes().all(|b| b.is_ascii_digit()).then_some(tail)
}

/// `<prefix>YYYYMMDD-HHMMSS` followed by nothing or `-<digits>`: the stamp part of a generated name.
fn stamped(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix) else {
        return false;
    };
    let Some(rest) = digits(rest, 8)
        .and_then(|r| r.strip_prefix('-'))
        .and_then(|r| digits(r, 6))
    else {
        return false;
    };
    match rest.strip_prefix('-') {
        None => rest.is_empty(),
        Some(n) => !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// A generated scene name, `scene-YYYYMMDD-HHMMSS` or `scene-YYYYMMDD-HHMMSS-N` (contract §4.2), that is also a slug.
#[must_use]
pub fn is_scene_name(s: &str) -> bool {
    is_slug(s) && stamped(s, "scene-")
}

/// A render name, `render-YYYYMMDD-HHMMSS` or with `-N` (contract §2.6; v1's `RENDER_NAME`, with ASCII digits only:
/// Python's `\d` also took other scripts' digits).
#[must_use]
pub fn is_render_name(s: &str) -> bool {
    stamped(s, "render-")
}

/// v1's `name_order(name)` sort key, `(base, n)`: `("scene-20261104-201500", 3)` for `scene-20261104-201500-3`,
/// `n = 1` without a suffix, and `(name, 0)` for a name that isn't `<anything>YYYYMMDD-HHMMSS[-N]`. The number is
/// kept as its digits, so it orders (and compares equal) as Python's unbounded `int` does: `-03` equals `-3`.
#[derive(Clone, Copy, Debug)]
pub struct NameOrder<'a> {
    /// The name up to and including the stamp (the whole name when it has no stamp).
    pub base: &'a str,
    /// The collision suffix's digits; `"1"` without a suffix, `"0"` without a stamp.
    pub number: &'a str,
}

/// `re.fullmatch(r"(.*?\d{8}-\d{6})(?:-(\d+))?", name)`: the shortest stamped prefix whose rest is empty or `-N`.
/// For slugs (ASCII digits; v1 only ever sorted slugs).
#[must_use]
pub fn name_order(name: &str) -> NameOrder<'_> {
    const STAMP: usize = 15; // "YYYYMMDD-HHMMSS"
    for end in STAMP..=name.len() {
        let Some((base, rest)) = name.split_at_checked(end) else {
            continue;
        };
        let Some(stamp) = base.get(base.len().saturating_sub(STAMP)..) else {
            continue;
        };
        if !stamped_tail(stamp) {
            continue;
        }
        if rest.is_empty() {
            return NameOrder { base, number: "1" };
        }
        if let Some(n) = rest.strip_prefix('-')
            && !n.is_empty()
            && n.bytes().all(|b| b.is_ascii_digit())
        {
            return NameOrder { base, number: n };
        }
    }
    NameOrder {
        base: name,
        number: "0",
    }
}

/// `YYYYMMDD-HHMMSS` exactly.
fn stamped_tail(s: &str) -> bool {
    digits(s, 8)
        .and_then(|r| r.strip_prefix('-'))
        .and_then(|r| digits(r, 6))
        .is_some_and(str::is_empty)
}

/// Compares two decimal digit strings as numbers (leading zeros ignored).
fn cmp_number(a: &str, b: &str) -> Ordering {
    let a = a.trim_start_matches('0');
    let b = b.trim_start_matches('0');
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

impl Ord for NameOrder<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.base
            .cmp(other.base)
            .then_with(|| cmp_number(self.number, other.number))
    }
}

impl PartialEq for NameOrder<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for NameOrder<'_> {}

impl PartialOrd for NameOrder<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Orders two names as v1 sorts scenes after `created`: by [`name_order`], so `-10` comes after `-9`.
#[must_use]
pub fn cmp_names(a: &str, b: &str) -> Ordering {
    name_order(a).cmp(&name_order(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert!(is_slug("a"));
        assert!(is_slug("scene-20261104-201500"));
        assert!(is_slug(&"a".repeat(64)));
        assert!(!is_slug(&"a".repeat(65)));
        assert!(!is_slug(""));
        assert!(!is_slug("-a"));
        assert!(!is_slug("evil\n"));
        assert!(!is_slug("Abc"));
        assert!(!is_slug("a_b"));
        assert!(!is_slug("é"));
    }

    #[test]
    fn generated_names() {
        assert!(is_scene_name("scene-20261104-201500"));
        assert!(is_scene_name("scene-20261104-201500-12"));
        assert!(!is_scene_name("scene-20261104-201500-"));
        assert!(!is_scene_name("scene-2026110-201500"));
        assert!(!is_scene_name("lounge"));
        assert!(is_render_name("render-20261104-201500-2"));
        assert!(!is_render_name("render-20261104-201500x"));
    }

    #[test]
    fn name_order_like_v1() {
        assert_eq!(
            name_order("scene-20261104-201500-3"),
            NameOrder {
                base: "scene-20261104-201500",
                number: "3"
            }
        );
        assert_eq!(
            name_order("scene-20261104-201500"),
            NameOrder {
                base: "scene-20261104-201500",
                number: "1"
            }
        );
        assert_eq!(
            name_order("lounge"),
            NameOrder {
                base: "lounge",
                number: "0"
            }
        );
        assert_eq!(
            name_order("x-12345678-123456-12345678-123456"),
            NameOrder {
                base: "x-12345678-123456-12345678-123456",
                number: "1"
            }
        );
        assert_eq!(
            cmp_names("scene-20261104-201500-10", "scene-20261104-201500-9"),
            Ordering::Greater
        );
        assert_eq!(
            cmp_names("scene-20261104-201500", "scene-20261104-201500-2"),
            Ordering::Less
        );
    }
}
