//! One measurement and the sizes on a line: v1's `_ITEM`, `_ORDER_KEY`, `_JOIN`, `_TAIL_UNIT`, `_axis`, `_order_keys`,
//! `_items`, `_chains` and `_line_chains`.
//!
//! `_ITEM` and `_ORDER_KEY` use lookbehinds and lookaheads, which the regex crate has no room for, so they are matched
//! by hand: at each position the alternatives are tried in v1's order, and where `re` would backtrack into an earlier
//! choice, every end it would try is tried in the same order (the module comments say which choices can matter).
//! Each position costs a bounded number of steps plus the whitespace runs next to it, so a line is read in linear
//! time; `finditer`'s scan (a match ends where the next search starts) is kept as it is.
use crate::chars::{
    add, alnum_ci, at, az_ci, ci, digit_run, is, is_digit, is_space, lit_ci, lower, skip_ws, slice,
    strip, strip_str, text,
};
use crate::num::{fraction_value, num_ends, num_first, py_num};
use crate::units::{Unit, feet_ends, inch_ends, unit_of, units_first};
use crate::words::JOIN;

/// An axis label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Axis {
    W,
    D,
    H,
    L,
    Dia,
}

impl Axis {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::W => "w",
            Self::D => "d",
            Self::H => "h",
            Self::L => "l",
            Self::Dia => "dia",
        }
    }
}

/// v1's `_FOREIGN`: axis words in German, French, Spanish, Italian and Dutch.
const FOREIGN: [(&str, Axis); 19] = [
    ("breite", Axis::W),
    ("tiefe", Axis::D),
    ("h\u{f6}he", Axis::H),
    ("hoehe", Axis::H),
    ("largeur", Axis::W),
    ("profondeur", Axis::D),
    ("hauteur", Axis::H),
    ("ancho", Axis::W),
    ("anchura", Axis::W),
    ("fondo", Axis::D),
    ("profundidad", Axis::D),
    ("alto", Axis::H),
    ("altura", Axis::H),
    ("larghezza", Axis::W),
    ("profondit\u{e0}", Axis::D),
    ("altezza", Axis::H),
    ("breedte", Axis::W),
    ("diepte", Axis::D),
    ("hoogte", Axis::H),
];

/// v1's `_axis`: the axis a label names, or None.
pub(crate) fn axis_of(label: &str) -> Option<Axis> {
    if label.is_empty() {
        return None;
    }
    let mut low = lower(strip_str(label));
    if let Some(rest) = low.strip_prefix("overall")
        && rest.starts_with(is_space)
    {
        low = rest.trim_start_matches(is_space).to_owned();
    }
    let t = low.trim_end_matches('.');
    match t {
        "w" | "width" | "wide" => Some(Axis::W),
        "d" | "depth" | "deep" => Some(Axis::D),
        "h" | "height" | "high" | "tall" => Some(Axis::H),
        "l" | "length" | "long" => Some(Axis::L),
        "\u{f8}" | "dia" | "diam" | "diameter" => Some(Axis::Dia),
        _ => FOREIGN.iter().find(|(w, _)| *w == t).map(|(_, a)| *a),
    }
}

/// `_LABELS` after `overall\s+(…)`, in v1's order (the foreign words longest first, as v1 sorted them).
const LABELS: [&str; 33] = [
    "width",
    "depth",
    "height",
    "length",
    "diameter",
    "diam.",
    "diam",
    "dia.",
    "dia",
    "\u{f8}",
    "profundidad",
    "profondeur",
    "profondit\u{e0}",
    "larghezza",
    "largeur",
    "hauteur",
    "anchura",
    "altezza",
    "breedte",
    "breite",
    "altura",
    "diepte",
    "hoogte",
    "tiefe",
    "hoehe",
    "ancho",
    "fondo",
    "h\u{f6}he",
    "alto",
    "w",
    "d",
    "h",
    "l",
];

/// `_POST`, expanded in order.
const POSTS: [&str; 18] = [
    "width", "depth", "height", "length", "wide", "deep", "high", "tall", "long", "diameter",
    "diam.", "diam", "dia.", "dia", "w", "d", "h", "l",
];

const AXIS_WORDS: [&str; 4] = ["width", "depth", "height", "length"];

/// Every end of `_LABELS` at `p`, in order.
fn label_ends(s: &[char], p: usize) -> Vec<usize> {
    let mut out = Vec::new();
    if let Some(q) = lit_ci(s, p, "overall") {
        let r = skip_ws(s, q);
        if r > q {
            out.extend(AXIS_WORDS.iter().filter_map(|w| lit_ci(s, r, w)));
        }
    }
    out.extend(LABELS.iter().filter_map(|w| lit_ci(s, p, w)));
    out
}

/// A span `[start, end)` of the line.
pub(crate) type Span = (usize, usize);

/// One `_ITEM` match: its span and groups.
#[derive(Clone, Debug, Default)]
struct ItemMatch {
    start: usize,
    end: usize,
    pre: Option<Span>,
    ft: Option<Span>,
    ftin: Option<Span>,
    num: Option<Span>,
    to: Option<Span>,
    unit: Option<Span>,
    post: Option<Span>,
}

/// `(?<![0-9A-WYZa-wyz_.,/…])` under `re.I`: the letters and digits (but x) and `_.,/`, plus `extra`.
fn behind_blocks(c: char, extra: &str) -> bool {
    c.is_ascii_digit()
        || (az_ci(c) && c != 'x' && c != 'X')
        || matches!(c, '_' | '.' | ',' | '/')
        || extra.contains(c)
}

/// `(?!\s*[:=]?\s*\d)` would fail at `x`: a digit follows, perhaps after `:` or `=`.
fn number_follows(s: &[char], x: usize) -> bool {
    let z = skip_ws(s, x);
    if is(at(s, z), is_digit) {
        return true;
    }
    is(at(s, z), |c| c == ':' || c == '=') && is(at(s, skip_ws(s, add(z, 1))), is_digit)
}

/// The post label group `(?:\s*\(?\s*(?P<post>…)\s*\)?(?![a-z0-9])(?!\s*[:=]?\s*\d))?` at `e`: (end, post span).
fn post_label(s: &[char], e: usize) -> (usize, Option<Span>) {
    let e1 = skip_ws(s, e);
    let e2 = if at(s, e1) == Some('(') {
        skip_ws(s, add(e1, 1))
    } else {
        e1
    };
    let passes = |x: usize| !is(at(s, x), alnum_ci) && !number_follows(s, x);
    for opt in POSTS {
        let Some(le) = lit_ci(s, e2, opt) else {
            continue;
        };
        let le1 = skip_ws(s, le);
        // `\s*\)?` tried longest first: after the bracket, before it, then one space less (any shorter run of spaces
        // behaves the same as that one).
        let mut tries = Vec::with_capacity(3);
        if at(s, le1) == Some(')') {
            tries.push(add(le1, 1));
        }
        tries.push(le1);
        if le1 > le {
            tries.push(le1.saturating_sub(1));
        }
        if let Some(x) = tries.into_iter().find(|x| passes(*x)) {
            return (x, Some((e2, le)));
        }
    }
    (e, None)
}

/// The body of `_ITEM` at `b`: feet and inches (`7' 6"`), else a number with an optional range and unit.
fn body(s: &[char], b: usize, m: &mut ItemMatch) -> Option<usize> {
    let mut feet = Vec::new();
    let mut nums = Vec::new();
    let mut inches = Vec::new();
    // (?P<ft>\d{1,4})\s*{_FT_U}\s*(?P<ftin>{NUM})\s*{_IN_U}: the feet must be the whole digit run (a digit can't start
    // a unit), and each whitespace run is taken whole (what follows it is never whitespace).
    let run = digit_run(s, b, 5);
    if (1..=4).contains(&run) {
        let ft_end = add(b, run);
        feet_ends(s, skip_ws(s, ft_end), &mut feet);
        for after_ft in feet.iter().copied() {
            let in_start = skip_ws(s, after_ft);
            num_ends(s, in_start, &mut nums);
            for in_end in nums.iter().copied() {
                inch_ends(s, skip_ws(s, in_end), &mut inches);
                if let Some(end) = inches.first().copied() {
                    m.ft = Some((b, ft_end));
                    m.ftin = Some((in_start, in_end));
                    return Some(end);
                }
            }
        }
    }
    // (?P<num>{NUM})(?:\s*(?:–|—|-|to)\s*(?P<to>\d{1,7}(?:[.,]\d{1,4})?)(?![\d/⁄]))?(?:\s*(?P<unit>{UNITS}))?
    // Everything after the number is optional, so its first end wins.
    let first = num_first(s, b)?;
    m.num = Some((b, first));
    let mut end = first;
    let dash_at = skip_ws(s, first);
    let dash = match at(s, dash_at) {
        Some('\u{2013}' | '\u{2014}' | '-') => Some(add(dash_at, 1)),
        _ => lit_ci(s, dash_at, "to"),
    };
    if let Some(after_dash) = dash {
        let to_start = skip_ws(s, after_dash);
        let to_run = digit_run(s, to_start, 8);
        if (1..=7).contains(&to_run) {
            let whole_end = add(to_start, to_run);
            let blocks = |c: char| is_digit(c) || c == '/' || c == '\u{2044}';
            let mut tries = Vec::new();
            if is(at(s, whole_end), |c| c == '.' || c == ',') {
                let dec = digit_run(s, add(whole_end, 1), 4);
                tries.extend((1..=dec).rev().map(|j| add(whole_end, add(1, j))));
            }
            tries.push(whole_end);
            if let Some(to_end) = tries.into_iter().find(|x| !is(at(s, *x), blocks)) {
                m.to = Some((to_start, to_end));
                end = to_end;
            }
        }
    }
    let u0 = skip_ws(s, end);
    if let Some(ue) = units_first(s, u0) {
        m.unit = Some((u0, ue));
        end = ue;
    }
    Some(end)
}

/// `_ITEM` matched at `p` (None when it doesn't match there).
fn item_at(s: &[char], p: usize) -> Option<ItemMatch> {
    let c0 = at(s, p)?;
    let prev = p.checked_sub(1).and_then(|i| at(s, i));
    let mut m = ItemMatch {
        start: p,
        ..ItemMatch::default()
    };
    let body_end = if is_digit(c0) || fraction_value(c0).is_some() {
        // the label-free alternative (a label never starts with a digit, and the body always does)
        if is(prev, |c| behind_blocks(c, "\\-")) {
            return None;
        }
        body(s, p, &mut m)?
    } else {
        if is(prev, |c| behind_blocks(c, "'\"\u{2019}")) {
            return None;
        }
        // (?P<pre>{_LABELS})\s*[:.=]?\s*: a body can only start after the whole separator, and a shorter label
        // alternative leads to the same place or a letter, so the first label that leads to a body wins.
        let mut found = None;
        for q in label_ends(s, p) {
            let mut r = skip_ws(s, q);
            if is(at(s, r), |c| c == ':' || c == '.' || c == '=') {
                r = skip_ws(s, add(r, 1));
            }
            let mut trial = ItemMatch {
                start: p,
                pre: Some((p, q)),
                ..ItemMatch::default()
            };
            if let Some(e) = body(s, r, &mut trial) {
                m = trial;
                found = Some(e);
                break;
            }
        }
        found?
    };
    let (end, post) = post_label(s, body_end);
    m.end = end;
    m.post = post;
    Some(m)
}

/// `_ITEM.finditer(line)`.
fn find_items(s: &[char]) -> Vec<ItemMatch> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < s.len() {
        match item_at(s, pos) {
            Some(m) => {
                pos = m.end.max(add(pos, 1));
                out.push(m);
            }
            None => pos = add(pos, 1),
        }
    }
    out
}

/// One measurement on a line (v1's `_Item`): its value in the page's unit (unit None: no unit), axis and text.
#[derive(Clone, Debug)]
pub(crate) struct Item {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) value: f64,
    pub(crate) unit: Option<Unit>,
    pub(crate) axis: Option<Axis>,
    pub(crate) num_text: String,
    pub(crate) to: Option<f64>,
}

fn group(s: &[char], span: Option<Span>) -> Option<String> {
    span.map(|(a, b)| text(slice(s, a, b)))
}

fn digits_number(digits: &str) -> Option<f64> {
    let ascii: Option<String> = digits
        .chars()
        .map(|c| crate::chars::digit_value(c).and_then(|d| char::from_digit(d, 10)))
        .collect();
    ascii?.parse::<f64>().ok()
}

/// v1's `_Item(m)`, or None when v1's `_items` would drop it (no value, or not above 0).
fn make_item(s: &[char], m: &ItemMatch) -> Option<Item> {
    let axis = group(s, m.pre)
        .as_deref()
        .and_then(axis_of)
        .or_else(|| group(s, m.post).as_deref().and_then(axis_of));
    let (value, unit, num_text, to) =
        if let (Some(ft), Some(ftin)) = (group(s, m.ft), group(s, m.ftin)) {
            let inches = digits_number(&ft)? * 12.0 + py_num(&ftin).unwrap_or(0.0);
            let ftin_text = text(strip(&ftin.chars().collect::<Vec<_>>()));
            (
                Some(inches / 12.0),
                Some(Unit::Ft),
                format!("{ft}' {ftin_text}\""),
                None,
            )
        } else {
            let num = group(s, m.num).unwrap_or_default();
            let value = py_num(&num);
            let unit = group(s, m.unit).as_deref().and_then(unit_of);
            let to = group(s, m.to).as_deref().and_then(py_num);
            (value, unit, strip_str(&num).to_owned(), to)
        };
    let value = value.filter(|v| *v > 0.0)?;
    Some(Item {
        start: m.start,
        end: m.end,
        value,
        unit,
        axis,
        num_text,
        to,
    })
}

/// v1's `_items(line)`.
pub(crate) fn items(s: &[char]) -> Vec<Item> {
    find_items(s)
        .iter()
        .filter_map(|m| make_item(s, m))
        .collect()
}

/// v1's `_KEY_TOK`, in order.
const KEY_TOKENS: [&str; 11] = [
    "width", "depth", "height", "length", "w", "d", "h", "l", "b", "t", "p",
];

fn key_token(s: &[char], p: usize) -> Option<Span> {
    KEY_TOKENS
        .iter()
        .find_map(|w| lit_ci(s, p, w))
        .map(|e| (p, e))
}

fn is_times(c: char) -> bool {
    ci(c, 'x') || c == '\u{d7}' || c == '*'
}

/// `\s*\)?(?![A-Za-z0-9])` at `x`: the end it takes.
fn key_tail(s: &[char], x: usize) -> Option<usize> {
    let x1 = skip_ws(s, x);
    let mut tries = Vec::with_capacity(3);
    if at(s, x1) == Some(')') {
        tries.push(add(x1, 1));
    }
    tries.push(x1);
    if x1 > x {
        tries.push(x1.saturating_sub(1));
    }
    tries.into_iter().find(|y| !is(at(s, *y), alnum_ci))
}

/// One `_ORDER_KEY` match at `p`: (start, end, its tokens).
fn order_key_at(s: &[char], p: usize) -> Option<(usize, usize, Vec<Span>)> {
    if is(p.checked_sub(1).and_then(|i| at(s, i)), alnum_ci) {
        return None;
    }
    let open = if at(s, p) == Some('(') { add(p, 1) } else { p };
    let tok_a = key_token(s, skip_ws(s, open))?;
    let sep1 = skip_ws(s, tok_a.1);
    if !is(at(s, sep1), is_times) {
        return None;
    }
    let tok_b = key_token(s, skip_ws(s, add(sep1, 1)))?;
    let sep2 = skip_ws(s, tok_b.1);
    if is(at(s, sep2), is_times)
        && let Some(tok_c) = key_token(s, skip_ws(s, add(sep2, 1)))
        && let Some(end) = key_tail(s, tok_c.1)
    {
        return Some((p, end, vec![tok_a, tok_b, tok_c]));
    }
    key_tail(s, tok_b.1).map(|end| (p, end, vec![tok_a, tok_b]))
}

/// The axis an order-key token names (`_KEY_AXIS[tok.lower()]`); an unknown spelling is v1's `KeyError`.
fn key_axis(tok: &str) -> Result<Axis, crate::PyError> {
    match lower(tok).as_str() {
        "w" | "width" | "b" => Ok(Axis::W),
        "d" | "depth" | "t" | "p" => Ok(Axis::D),
        "h" | "height" => Ok(Axis::H),
        "l" | "length" => Ok(Axis::L),
        _ => Err(crate::PyError::KeyError),
    }
}

/// An order key: (start, end, axes).
pub(crate) type OrderKey = (usize, usize, Vec<Axis>);

/// v1's `_order_keys`: the line with its order keys blanked out, and the keys whose axes are all different.
fn order_keys(s: &[char]) -> Result<(Vec<char>, Vec<OrderKey>), crate::PyError> {
    let mut keys = Vec::new();
    let mut pos = 0;
    while pos < s.len() {
        match order_key_at(s, pos) {
            Some((start, end, toks)) => {
                let axes = toks
                    .iter()
                    .map(|t| key_axis(&text(slice(s, t.0, t.1))))
                    .collect::<Result<Vec<_>, _>>()?;
                let distinct = axes
                    .iter()
                    .enumerate()
                    .all(|(i, a)| !axes.iter().take(i).any(|b| b == a));
                if distinct {
                    keys.push((start, end, axes));
                }
                pos = end.max(add(pos, 1));
            }
            None => pos = add(pos, 1),
        }
    }
    if keys.is_empty() {
        return Ok((s.to_vec(), keys));
    }
    let mut blanked = s.to_vec();
    for (a, b, _) in &keys {
        for c in blanked.iter_mut().take(*b).skip(*a) {
            *c = ' ';
        }
    }
    Ok((blanked, keys))
}

/// v1's `_chains`: the line's items joined into sizes of up to three (`x`, `×`, `*`, `by` between them), a unit after
/// the last number applied to all, and an order key next to unlabelled numbers setting their axes.
fn chains(found: Vec<Item>, s: &[char], keys: &[OrderKey]) -> Vec<Vec<Item>> {
    let mut out: Vec<Vec<Item>> = Vec::new();
    let mut cur: Vec<Item> = Vec::new();
    for it in found {
        let joins = cur.last().is_some_and(|last| {
            cur.len() < 3 && JOIN.is_match(&text(slice(s, last.end, it.start)))
        });
        if joins {
            cur.push(it);
        } else {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(it);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    for chain in &mut out {
        if chain.len() >= 2
            && chain.iter().all(|it| it.unit.is_none())
            && let Some(last_end) = chain.last().map(|it| it.end)
        {
            let unit_start = skip_ws(s, last_end);
            if let Some(unit_end) = units_first(s, unit_start)
                && let Some(u) = unit_of(&text(slice(s, unit_start, unit_end)))
                    .filter(|_| !is(at(s, unit_end), |c| c.is_ascii_alphabetic()))
            {
                for it in chain.iter_mut() {
                    it.unit = Some(u);
                }
                if let Some(last) = chain.last_mut() {
                    last.end = unit_end;
                }
            }
        }
        if !keys.is_empty() && chain.len() >= 2 && chain.iter().all(|it| it.axis.is_none()) {
            let first = chain.first().map_or(0, |it| it.start);
            let last = chain.last().map_or(0, |it| it.end);
            for (ks, ke, axes) in keys {
                let near = first.checked_sub(*ke).is_some_and(|d| d <= 16)
                    || ks.checked_sub(last).is_some_and(|d| d <= 16);
                if near && axes.len() == chain.len() {
                    for (it, a) in chain.iter_mut().zip(axes) {
                        it.axis = Some(*a);
                    }
                    break;
                }
            }
        }
    }
    out
}

/// v1's `_line_chains(line)`.
pub(crate) fn line_chains(s: &[char]) -> Result<Vec<Vec<Item>>, crate::PyError> {
    let (blanked, keys) = order_keys(s)?;
    let found = items(&blanked);
    Ok(chains(found, &blanked, &keys))
}

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = (f64, Option<&'static str>, Option<&'static str>);

    fn chain_text(t: &str) -> Vec<Vec<Seen>> {
        let s: Vec<char> = t.chars().collect();
        line_chains(&s)
            .unwrap_or_default()
            .iter()
            .map(|c| {
                c.iter()
                    .map(|it| (it.value, it.unit.map(Unit::name), it.axis.map(Axis::name)))
                    .collect()
            })
            .collect()
    }

    #[test]
    fn reads_v1_lines() {
        assert_eq!(
            chain_text("200W x 90D x 85H cm"),
            vec![vec![
                (200.0, Some("cm"), Some("w")),
                (90.0, Some("cm"), Some("d")),
                (85.0, Some("cm"), Some("h"))
            ]]
        );
        // v1: the unit stays on the last number (the reading fills the others in)
        assert_eq!(
            chain_text("200 x 90 x 85 cm (W x D x H)"),
            vec![vec![
                (200.0, None, Some("w")),
                (90.0, None, Some("d")),
                (85.0, Some("cm"), Some("h"))
            ]]
        );
        assert_eq!(chain_text("7' 6\" x 9' 6\"").first().map(Vec::len), Some(2));
        assert_eq!(
            chain_text("W 180\u{2013}220 cm")
                .first()
                .and_then(|c| c.first())
                .map(|i| i.0),
            Some(180.0)
        );
    }

    #[test]
    fn axes() {
        assert_eq!(axis_of("Overall  Width"), Some(Axis::W));
        assert_eq!(axis_of("DIA."), Some(Axis::Dia));
        assert_eq!(axis_of("H\u{d6}HE"), Some(Axis::H));
        assert_eq!(axis_of(""), None);
    }
}
