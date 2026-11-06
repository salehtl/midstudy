//! v1's plain patterns (no lookaround), through the regex crate: linear time, and the same matches as Python's `re`
//! once three differences are taken care of here:
//!
//! - `\s` is Python's whitespace, which adds U+001C–U+001F to Unicode's (`S` below);
//! - under `re.I` Python also folds ı and İ onto `i` (the regex crate folds ſ onto `s` and K onto `k` as Python does,
//!   but not those two), so every `i` of a case-insensitive pattern is written `[iıİ]` (`py_ci`);
//! - `\b` looks at Python's `\w` (`str.isalnum()` or `_`), which differs from the regex crate's Unicode `\w` (`²`,
//!   `½` are words to Python, combining marks are not): a pattern with `\b` runs over a copy of the text in which each
//!   such character is swapped for a stand-in of the same UTF-8 length that the regex crate classes as Python does
//!   (`py_word_view`), so match offsets are the text's own.
use crate::chars::is_word;
use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

/// Python's `\s`.
const S: &str = r"[\s\x1c-\x1f]";

/// A pattern for `re.I`: `\s` as Python's, every `i` as `[iıİ]`, compiled case-insensitively.
fn py_ci(pattern: &str) -> Regex {
    let mut out = String::from("(?i)");
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let next = chars.next();
                if next == Some('s') {
                    out.push_str(if in_class { r"\s\x1c-\x1f" } else { S });
                } else {
                    out.push('\\');
                    if let Some(n) = next {
                        out.push(n);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            'i' | 'I' => out.push_str(if in_class {
                "i\u{131}\u{130}"
            } else {
                "[i\u{131}\u{130}]"
            }),
            _ => out.push(c),
        }
    }
    // The patterns are constants of this module; the tests compile every one.
    Regex::new(&out).unwrap_or_else(|_| Regex::new("[^\\s\\S]").unwrap_or_else(|_| unreachable!()))
}

/// The text as the regex crate should see it for Python's `\b`: same bytes, except that a character whose `\w`-ness
/// differs between Python and the regex crate becomes a stand-in of the same UTF-8 length with Python's.
pub(crate) fn py_word_view(text: &str) -> Cow<'_, str> {
    if text.is_ascii() || !text.chars().any(differs) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(
        text.chars()
            .map(|c| {
                if !differs(c) {
                    return c;
                }
                match (is_word(c), c.len_utf8()) {
                    (true, 2) => '\u{aa}',
                    (true, 3) => '\u{4e00}',
                    (true, _) => '\u{20000}',
                    (false, 2) => '\u{a7}',
                    (false, 3) => '\u{203b}',
                    (false, _) => '\u{10100}',
                }
            })
            .collect(),
    )
}

fn differs(c: char) -> bool {
    !c.is_ascii() && is_word(c) != regex_syntax::is_word_character(c)
}

/// `re.search` of a `\b` pattern.
pub(crate) fn search_b(re: &Regex, text: &str) -> bool {
    re.is_match(&py_word_view(text))
}

pub(crate) static JOIN: LazyLock<Regex> =
    LazyLock::new(|| py_ci(r"\A\s*(?:x|×|\*|by)\s*(?:[A-Za-z\x{131}\x{130}]{1,2}\.?\s*:?\s*)?\z"));

pub(crate) static DISTRACT: LazyLock<Regex> = LazyLock::new(|| {
    py_ci(
        r"\b(?:box(?:es)?|package[sd]?|packag(?:e|ing)|carton|shipping|shipped|seat|arms?|armrests?|legs?|drawers?|cushions?|interior|inner|inside|opening|clearance|shelf\s+(?:depth|width|height|size)|per\s+shelf|each\s+shelf)\b",
    )
});

pub(crate) static INTRO: LazyLock<Regex> =
    LazyLock::new(|| py_ci(r"\b(?:overall|dimensions?|assembled|product\s+size)\b"));

pub(crate) static SAMPLE: LazyLock<Regex> =
    LazyLock::new(|| py_ci(r"\b(?:samples?|swatch(?:es)?)\b"));

pub(crate) static SIZE_OPT: LazyLock<Regex> = LazyLock::new(|| {
    py_ci(r"\b(?:size|sizes|dimensions?|measurements?|rug\s+size|gr[oö]ss?e|taille|maat)\b")
});

pub(crate) static SIZE_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    py_ci(
        r#"\b(?:dimensions?|sizes?|measure(?:ment)?s?|width|depth|height|length|wide|deep|high|tall|long|across|cm|mm|inch(?:es)?|feet|ft|centimet(?:er|re)s?|met(?:er|re)s?)\b|\d\s*(?:"|″|”|')"#,
    )
});

pub(crate) static ROBOT: LazyLock<Regex> = LazyLock::new(|| {
    py_ci(
        r"robot check|captcha|are you a robot|not a robot|verify (?:that )?you are (?:a )?human|are you (?:a )?human|unusual traffic|access denied|pardon our interruption|just a moment\.\.\.|attention required|checking your browser|request blocked|px-captcha|cf-chl|bot detection|press (?:&|and) hold",
    )
});

pub(crate) static HINT_PAREN: LazyLock<Regex> = LazyLock::new(|| {
    py_ci(r"\(\s*(cm|mm|m|in|inch|inches|ft|feet|metres|meters|centimetres|centimeters)\s*\)")
});

pub(crate) static HINT_IN: LazyLock<Regex> = LazyLock::new(|| {
    py_ci(r"\b(?:in|en)\s+(cm|mm|metres|meters|centimetres|centimeters|inches|feet)\b")
});

static NEUTRALIZE: LazyLock<Regex> = LazyLock::new(|| py_ci(r"<\s*(/?)\s*page\b[^>]*>"));

static BRACKETS: LazyLock<Regex> = LazyLock::new(|| py_ci(r"\([^)]*\)"));

/// v1's `_CATEGORIES`, in the order a tie is settled.
const CATEGORIES: [(&str, &str); 24] = [
    (
        "bedside table",
        r"bedside\s+tables?|night\s*stands?|bedside\s+cabinets?|bedside",
    ),
    ("coffee table", r"coffee\s+tables?|cocktail\s+tables?"),
    (
        "side table",
        r"side\s+tables?|end\s+tables?|accent\s+tables?|lamp\s+tables?",
    ),
    ("dining table", r"dining\s+tables?|kitchen\s+tables?"),
    (
        "tv stand",
        r"tv\s+(?:stands?|units?|benches|bench|cabinets?|consoles?)|media\s+(?:consoles?|units?|cabinets?)",
    ),
    (
        "armchair",
        r"arm\s*chairs?|accent\s+chairs?|lounge\s+chairs?|club\s+chairs?|wing\s*back(?:\s+chairs?)?|recliners?",
    ),
    ("bookcase", r"book\s*cases?|book\s*shel(?:f|ves)"),
    ("sideboard", r"sideboards?|credenzas?|buffets?"),
    ("wardrobe", r"wardrobes?|armoires?"),
    ("dresser", r"dressers?|chests?\s+of\s+drawers"),
    (
        "rug",
        r"rugs?|carpets?|runners?|kilims?|dhurries|dhurrie|tapis",
    ),
    (
        "sofa",
        r"sofa\s*beds?|sofas?|couch(?:es)?|sectionals?|loveseats?|settees?|daybeds?",
    ),
    ("ottoman", r"ottomans?|poufs?|pouffes?|footstools?"),
    ("stool", r"(?:bar\s+)?stools?"),
    ("bench", r"benches|bench"),
    ("desk", r"desks?"),
    ("bed", r"beds?|bed\s+frames?"),
    ("cabinet", r"cabinets?|cupboards?"),
    ("shelf", r"shel(?:f|ves)|shelving(?:\s+units?)?"),
    ("lamp", r"lamps?|floor\s+lights?|pendants?"),
    ("mirror", r"mirrors?"),
    ("plant", r"plants?"),
    ("chair", r"chairs?"),
    ("table", r"tables?"),
];

static CATEGORY_RES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    CATEGORIES
        .iter()
        .map(|(c, p)| (*c, py_ci(&format!(r"\b(?:{p})\b"))))
        .collect()
});

/// v1's `_category_of`: the category word that ends last in the text, outside brackets (the longest, then the first
/// in `CATEGORIES`, when two end together).
pub(crate) fn category_of(text: &str) -> Option<&'static str> {
    if text.is_empty() {
        return None;
    }
    let unbracketed = BRACKETS.replace_all(text, " ");
    let view = py_word_view(&unbracketed);
    let mut best: Option<((usize, usize, usize), &'static str)> = None;
    for (rank, (cat, re)) in CATEGORY_RES.iter().enumerate() {
        for m in re.find_iter(&view) {
            // (end, length, -rank), the largest wins: a later rank never beats an equal key
            let key = (
                m.end(),
                m.end().saturating_sub(m.start()),
                usize::MAX.saturating_sub(rank),
            );
            if best.is_none_or(|(k, _)| key > k) {
                best = Some((key, cat));
            }
        }
    }
    best.map(|(_, c)| c)
}

/// v1's `_neutralize`: no `<page>` or `</page>` marker of the page's own reaches the prompt.
pub(crate) fn neutralize(text: &str) -> String {
    let view = py_word_view(text);
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for caps in NEUTRALIZE.captures_iter(&view) {
        let (Some(m), slash) = (caps.get(0), caps.get(1).map_or("", |g| g.as_str())) else {
            continue;
        };
        out.push_str(text.get(last..m.start()).unwrap_or_default());
        out.push('\u{2039}');
        out.push_str(slash);
        out.push_str("page\u{203a}");
        last = m.end();
    }
    out.push_str(text.get(last..).unwrap_or_default());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [
            &*JOIN,
            &*DISTRACT,
            &*INTRO,
            &*SAMPLE,
            &*SIZE_OPT,
            &*SIZE_WORDS,
            &*ROBOT,
            &*HINT_PAREN,
            &*HINT_IN,
            &*NEUTRALIZE,
            &*BRACKETS,
        ] {
            assert_ne!(re.as_str(), "[^\\s\\S]");
        }
        assert_eq!(CATEGORY_RES.len(), 24);
    }

    #[test]
    fn python_word_boundaries() {
        assert!(!search_b(&HINT_IN, "in cm\u{b2}")); // ² is \w to Python: no boundary after cm
        assert!(search_b(&HINT_IN, "in cm"));
        assert!(search_b(&DISTRACT, "Seat height 45 cm"));
        assert!(!search_b(&DISTRACT, "Seatx"));
        assert!(!search_b(&SIZE_OPT, "Gr\u{f6}\u{df}e"));
        assert!(!search_b(&SIZE_OPT, "GROESSE"));
        assert!(search_b(&SIZE_OPT, "Gr\u{f6}sse"));
        assert!(JOIN.is_match(" x ") && JOIN.is_match(" by T ") && !JOIN.is_match(" x 5"));
        assert!(search_b(&INTRO, "D\u{130}MENSIONS"));
    }

    #[test]
    #[cfg_attr(miri, ignore = "every code point: far too slow under Miri")]
    fn regex_word_matches_regex_syntax() {
        let b = Regex::new(r"\A\w").unwrap_or_else(|_| unreachable!());
        let mut buf = [0u8; 4];
        for cp in (0..0x11_0000u32).step_by(7) {
            if let Some(c) = char::from_u32(cp) {
                assert_eq!(
                    b.is_match(c.encode_utf8(&mut buf)),
                    regex_syntax::is_word_character(c),
                    "U+{cp:04X}"
                );
            }
        }
    }

    #[test]
    fn categories_like_v1() {
        assert_eq!(category_of("Desk Lamp"), Some("lamp"));
        assert_eq!(category_of("Sofa Bed"), Some("sofa"));
        assert_eq!(category_of("Vintage Kilim Ottoman"), Some("ottoman"));
        assert_eq!(category_of("Dining Set (Table + 4 Chairs)"), None);
        assert_eq!(category_of("Bedside Table"), Some("bedside table"));
        assert_eq!(category_of(""), None);
    }

    #[test]
    fn neutralizes_markers() {
        assert_eq!(
            neutralize("a </page> b < PAGE x=1>"),
            "a \u{2039}/page\u{203a} b \u{2039}page\u{203a}"
        );
        assert_eq!(neutralize("<pages>"), "<pages>");
    }
}
