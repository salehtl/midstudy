//! Sizes in page text (contract §2.11 layer 3): v1's `_text_readings`, `_context`, `_window`, `_unit_hint`,
//! `_thickness`, `_HAS_SIZE` and `_THICK`.
use crate::chars::{
    add, at, collapse_ws, is, is_digit, is_space, is_word, lit_ci, prefix, skip_ws, slice, strip,
    text,
};
use crate::item::{Axis, line_chains};
use crate::num::{num_ends, py_num};
use crate::reading::{Ctx, Part, Reading, make_reading, parts_of};
use crate::units::{Unit, unit_of, units_ends};
use crate::words::{DISTRACT, HINT_IN, HINT_PAREN, INTRO, py_word_view, search_b};

/// `_HAS_SIZE.search(s)`: a number with a unit (not right after an ASCII digit), or the word `dimension`.
pub(crate) fn has_size(s: &[char]) -> bool {
    let mut ends = Vec::new();
    let mut units = Vec::new();
    for p in 0..s.len() {
        if lit_ci(s, p, "dimension").is_some() {
            return true;
        }
        if is(p.checked_sub(1).and_then(|i| at(s, i)), |c| {
            c.is_ascii_digit()
        }) {
            continue;
        }
        num_ends(s, p, &mut ends);
        for e in ends.iter().copied() {
            units_ends(s, skip_ws(s, e), &mut units);
            if !units.is_empty() {
                return true;
            }
        }
    }
    false
}

/// v1's `_context`: the words before a size on its line (from the last sentence break), or the line before when the
/// size starts its line with no words before it.
fn context(line: &[char], start: usize, prev_end: usize, prev_line: Option<&[char]>) -> Vec<char> {
    let ctx = slice(line, prev_end, start);
    let cut = (0..ctx.len())
        .filter(|i| {
            is(at(ctx, *i), |c| {
                matches!(c, '.' | ';' | '!' | '?' | '\u{2022}' | '\u{b7}')
            }) && is(at(ctx, add(*i, 1)), is_space)
        })
        .map(|i| add(i, 1))
        .next_back()
        .unwrap_or(0);
    let ctx = slice(ctx, cut, ctx.len());
    if !ctx.iter().any(char::is_ascii_alphabetic)
        && prev_end == 0
        && let Some(prev) = prev_line.filter(|p| !p.is_empty())
    {
        let tail = slice(prev, prev.len().saturating_sub(120), prev.len());
        let mut out = tail.to_vec();
        out.push(' ');
        out.extend_from_slice(ctx);
        return out;
    }
    ctx.to_vec()
}

/// v1's `_window`: at most `n` characters of the line around `[start, end)`, cut at word boundaries.
fn window(line: &[char], start: usize, end: usize, n: usize) -> String {
    if line.len() <= n {
        return text(strip(line));
    }
    let span = end.saturating_sub(start);
    let mut q0 = start.saturating_sub(n.saturating_sub(span) / 2);
    let mut q1 = line.len().min(add(q0, n));
    if q0 > 0
        && let Some(sp) = slice(line, q0, start).iter().position(|c| *c == ' ')
    {
        q0 = add(q0, add(sp, 1));
    }
    if q1 < line.len()
        && let Some(sp) = slice(line, end, q1).iter().rposition(|c| *c == ' ')
    {
        q1 = add(end, sp);
    }
    text(strip(slice(line, q0, q1)))
}

fn distract(s: &[char]) -> bool {
    search_b(&DISTRACT, &text(s))
}

fn intro(s: &[char]) -> bool {
    search_b(&INTRO, &text(s))
}

/// v1's `len((line[:start] + line[end:]).strip(" \t:-–—|").split())`, in constant time per chain after a linear pass
/// over the line (v1 rebuilt the rest of the line for every chain, quadratic on a line of many sizes).
struct RestIndex {
    ws: Vec<bool>,
    /// `starts[k]`: how many j < k (j ≥ 1) start a word after whitespace.
    starts: Vec<usize>,
    /// `next_non_s[i]`: the first j ≥ i not in the strip set (len when none).
    next_non_s: Vec<usize>,
    /// `prev_non_s[i]`: the last j ≤ i not in the strip set.
    prev_non_s: Vec<Option<usize>>,
}

fn in_strip_set(c: char) -> bool {
    matches!(c, ' ' | '\t' | ':' | '-' | '\u{2013}' | '\u{2014}' | '|')
}

impl RestIndex {
    fn new(line: &[char]) -> Self {
        let n = line.len();
        let ws: Vec<bool> = line.iter().map(|c| is_space(*c)).collect();
        let mut starts = Vec::with_capacity(add(n, 1));
        starts.push(0usize);
        let mut acc = 0usize;
        for j in 0..n {
            let begins = j > 0
                && !ws.get(j).copied().unwrap_or(true)
                && ws.get(j.saturating_sub(1)).copied().unwrap_or(false);
            if begins {
                acc = add(acc, 1);
            }
            starts.push(acc);
        }
        let mut next_non_s = vec![n; add(n, 1)];
        for i in (0..n).rev() {
            let next = if is(at(line, i), in_strip_set) {
                next_non_s.get(add(i, 1)).copied().unwrap_or(n)
            } else {
                i
            };
            if let Some(slot) = next_non_s.get_mut(i) {
                *slot = next;
            }
        }
        let mut prev_non_s = Vec::with_capacity(n);
        let mut last = None;
        for (i, c) in line.iter().enumerate() {
            if !in_strip_set(*c) {
                last = Some(i);
            }
            prev_non_s.push(last);
        }
        Self {
            ws,
            starts,
            next_non_s,
            prev_non_s,
        }
    }

    fn is_ws(&self, i: usize) -> bool {
        self.ws.get(i).copied().unwrap_or(true)
    }

    /// `len(line[x:y].split())`.
    fn words(&self, x: usize, y: usize) -> usize {
        if x >= y {
            return 0;
        }
        let first = usize::from(!self.is_ws(x));
        let inner = self
            .starts
            .get(y)
            .copied()
            .unwrap_or(0)
            .saturating_sub(self.starts.get(add(x, 1)).copied().unwrap_or(0));
        add(first, inner)
    }

    fn rest_words(&self, start: usize, end: usize) -> usize {
        let n = self.ws.len();
        let first_non_s = self.next_non_s.first().copied().unwrap_or(n);
        let last_non_s = n
            .checked_sub(1)
            .and_then(|i| self.prev_non_s.get(i).copied().flatten());
        let (mut a_lo, mut a_hi) = (0, start);
        let (mut b_lo, mut b_hi) = (end, n);
        // the leading strip: through A when A is all strip characters, into B
        if first_non_s >= start {
            a_lo = start;
            b_lo = self.next_non_s.get(end).copied().unwrap_or(n);
        } else {
            a_lo = a_lo.max(first_non_s);
        }
        // the trailing strip: through B when B is all strip characters, into A
        match last_non_s {
            Some(r) if r >= end => b_hi = add(r, 1),
            _ => {
                b_lo = b_hi;
                a_hi = match start
                    .checked_sub(1)
                    .and_then(|i| self.prev_non_s.get(i).copied().flatten())
                {
                    Some(j) if j >= a_lo && a_hi > a_lo => add(j, 1),
                    _ => a_lo,
                };
            }
        }
        let a = self.words(a_lo, a_hi);
        let b = self.words(b_lo, b_hi.max(b_lo));
        let joined =
            a_hi > a_lo && b_hi > b_lo && !self.is_ws(a_hi.saturating_sub(1)) && !self.is_ws(b_lo);
        a.saturating_add(b).saturating_sub(usize::from(joined))
    }
}

/// A labelled single on a line: (line index, axis, part, the text before it).
type Single = (usize, Axis, Part, String);
/// A reading found in text: (0 when introduced by "overall", "dimensions"…, else 1; its order; the reading).
type Found = (u8, usize, Reading);

/// v1's singles grouping: labelled singles in a block of lines (a table, "Width: 80 cm / Depth: 40 cm …") make one
/// reading; a repeated axis or a gap of more than two lines starts the next block.
fn group_singles(singles: Vec<Single>, ctx: Ctx, found: &mut Vec<Found>, order: &mut usize) {
    let mut group: Vec<Single> = Vec::new();
    let mut flush = |group: &mut Vec<Single>, found: &mut Vec<Found>| {
        let dia = group.first().is_some_and(|g| g.1 == Axis::Dia);
        if group.len() >= 2 || dia {
            let joined = group
                .iter()
                .map(|g| g.3.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let quote = prefix(&joined, 200).to_owned();
            let parts: Vec<Part> = group.iter().map(|g| g.2.clone()).collect();
            if let Some(r) = make_reading(&parts, ctx, "text", &quote, None, true, false).reading {
                found.push((0, *order, r));
                *order = add(*order, 1);
            }
        }
        group.clear();
    };
    for s in singles {
        let breaks = group
            .last()
            .is_some_and(|last| group.iter().any(|g| g.1 == s.1) || s.0.saturating_sub(last.0) > 2);
        if breaks {
            flush(&mut group, found);
        }
        group.push(s);
    }
    flush(&mut group, found);
}

/// v1's `_text_readings` (§2.11 layer 3): sizes with units (or the page's unit hint) in text lines, labelled
/// singles in neighbouring lines grouped (tables), distractors left out; introduced sizes first.
pub(crate) fn text_readings(lines: &[Vec<char>], ctx: Ctx) -> Result<Vec<Reading>, crate::PyError> {
    let mut found: Vec<Found> = Vec::new();
    let mut singles: Vec<Single> = Vec::new();
    let mut order = 0usize;
    let mut prev_line: Option<&[char]> = None;
    for (li, line) in lines.iter().enumerate() {
        let line = line.as_slice();
        if !line.iter().any(|c| is_digit(*c)) {
            if !strip(line).is_empty() {
                prev_line = Some(line);
            }
            continue;
        }
        let mut prev_end = 0;
        let mut rest_index: Option<RestIndex> = None;
        for chain in line_chains(line)? {
            let (Some(first), Some(last)) = (chain.first(), chain.last()) else {
                continue;
            };
            let (start, end) = (first.start, last.end);
            // v1 computed the context for every chain; it is only read for chains of 2 or 3 and labelled singles, so
            // it is computed for those alone (the same text, in linear time: prev_end only moves past those).
            if chain.len() >= 2 {
                let ctx_text = context(line, start, prev_end, prev_line);
                prev_end = end;
                let mut probe = ctx_text.clone();
                probe.push(' ');
                probe.extend_from_slice(slice(line, start, end));
                if distract(&probe) {
                    continue;
                }
                if chain.iter().all(|it| it.unit.is_none()) {
                    if ctx.hint.is_none() {
                        continue;
                    }
                    let index = rest_index.get_or_insert_with(|| RestIndex::new(line));
                    if index.rest_words(start, end) > 2 {
                        continue;
                    }
                }
                let quote = window(line, start, end, 200);
                let label = prefix(&text(strip(slice(line, start, end))), 80).to_owned();
                let made = make_reading(
                    &parts_of(&chain),
                    ctx,
                    "text",
                    &quote,
                    Some(label),
                    false,
                    false,
                );
                if let Some(r) = made.reading {
                    found.push((u8::from(!intro(&ctx_text)), order, r));
                    order = add(order, 1);
                }
            } else if let Some(axis) = first.axis {
                let ctx_text = context(line, start, prev_end, None);
                prev_end = end;
                if distract(slice(line, start.saturating_sub(ctx_text.len()), end)) {
                    continue;
                }
                let part = Part {
                    axis: Some(axis.name().to_owned()),
                    value: first.value,
                    unit: first.unit,
                    text: first.num_text.clone(),
                    to: None,
                };
                singles.push((
                    li,
                    axis,
                    part,
                    text(strip(slice(line, start.saturating_sub(40), end))),
                ));
            }
        }
        if !strip(line).is_empty() {
            prev_line = Some(line);
        }
    }
    group_singles(singles, ctx, &mut found, &mut order);
    found.sort_by_key(|t| (t.0, t.1));
    Ok(found.into_iter().map(|t| t.2).collect())
}

/// v1's `_unit_hint`: the unit the page measures in elsewhere (`(m)`, `in cm`, or its sizes written with a unit),
/// by votes; a tie goes to the unit voted for first.
pub(crate) fn unit_hint(lines: &[Vec<char>]) -> Option<Unit> {
    let mut votes: Vec<(Unit, u64)> = Vec::new();
    let mut vote = |u: Unit, n: u64| match votes.iter_mut().find(|(v, _)| *v == u) {
        Some(slot) => slot.1 = slot.1.saturating_add(n),
        None => votes.push((u, n)),
    };
    for line in lines {
        let s = text(line);
        for caps in HINT_PAREN.captures_iter(&s) {
            if let Some(u) = caps.get(1).and_then(|g| unit_of(g.as_str())) {
                vote(u, 3);
            }
        }
        let view = py_word_view(&s);
        for caps in HINT_IN.captures_iter(&view) {
            if let Some(u) = caps.get(1).and_then(|g| s.get(g.range())).and_then(unit_of) {
                vote(u, 3);
            }
        }
        if has_size(line) {
            for it in crate::item::items(line) {
                match it.unit {
                    Some(u @ (Unit::Cm | Unit::Mm | Unit::M)) => vote(u, 1),
                    Some(u @ (Unit::In | Unit::Ft)) if it.axis.is_some() => vote(u, 1),
                    _ => {}
                }
            }
        }
    }
    let best = votes.iter().map(|(_, n)| *n).max()?;
    votes.iter().find(|(_, n)| *n == best).map(|(u, _)| *u)
}

/// `_THICK`'s first alternative's keywords, in order.
const THICK_KEYS: [&[&str]; 7] = [
    &["thickness"],
    &["pile", "height"],
    &["pile", "depth"],
    &["pile"],
    &["total", "height"],
    &["rug", "height"],
    &["height"],
];

/// One `_THICK` match: (start, end, k text, v text, u text).
struct ThickMatch {
    start: usize,
    end: usize,
    k: Option<String>,
    v: String,
    u: Option<String>,
    second: bool,
}

/// The keyword at `p` (`pile\s+height` and the like): its end.
fn thick_key(s: &[char], p: usize, words: &[&str]) -> Option<usize> {
    let mut q = p;
    for (i, w) in words.iter().enumerate() {
        if i > 0 {
            let r = skip_ws(s, q);
            if r == q {
                return None;
            }
            q = r;
        }
        q = lit_ci(s, q, w)?;
    }
    Some(q)
}

fn thick_at(
    s: &[char],
    p: usize,
    nums: &mut Vec<usize>,
    units: &mut Vec<usize>,
) -> Option<ThickMatch> {
    let stop = |c: char| is_digit(c) || c == '.' || c == ',';
    // (?P<k>…)\s*[:\-–]?\s*(?:approx\.?\s*)?(?P<v>{NUM})(?:\s*(?P<u>{UNITS}))?(?![\d.,])
    for words in THICK_KEYS {
        let Some(ke) = thick_key(s, p, words) else {
            continue;
        };
        let mut q = skip_ws(s, ke);
        if is(at(s, q), |c| c == ':' || c == '-' || c == '\u{2013}') {
            q = skip_ws(s, add(q, 1));
        }
        if let Some(a) = lit_ci(s, q, "approx") {
            q = if at(s, a) == Some('.') {
                skip_ws(s, add(a, 1))
            } else {
                skip_ws(s, a)
            };
        }
        num_ends(s, q, nums);
        for n in nums.iter().copied() {
            let u0 = skip_ws(s, n);
            units_ends(s, u0, units);
            let with_unit = units.iter().copied().find(|ue| !is(at(s, *ue), stop));
            let (end, u) = match with_unit {
                Some(ue) => (ue, Some(text(slice(s, u0, ue)))),
                None if !is(at(s, n), stop) => (n, None),
                None => continue,
            };
            return Some(ThickMatch {
                start: p,
                end,
                k: Some(text(slice(s, p, ke))),
                v: text(slice(s, q, n)),
                u,
                second: false,
            });
        }
    }
    // (?P<v2>{NUM})\s*(?P<u2>{UNITS})\s+(?:thick|in\s+thickness)\b
    num_ends(s, p, nums);
    for n in nums.iter().copied() {
        let u0 = skip_ws(s, n);
        units_ends(s, u0, units);
        for ue in units.iter().copied() {
            let w = skip_ws(s, ue);
            if w == ue {
                continue;
            }
            let word_end = lit_ci(s, w, "thick").or_else(|| thick_key(s, w, &["in", "thickness"]));
            if let Some(e) = word_end.filter(|e| !is(at(s, *e), is_word)) {
                return Some(ThickMatch {
                    start: p,
                    end: e,
                    k: None,
                    v: text(slice(s, p, n)),
                    u: Some(text(slice(s, u0, ue))),
                    second: true,
                });
            }
        }
    }
    None
}

/// A rug's thickness or pile height: (cm, the note v1 added: "thickness from the page: …").
pub(crate) fn thickness(lines: &[Vec<char>], hint: Option<Unit>) -> Option<(f64, String)> {
    let mut thick: Option<(f64, String)> = None;
    let mut pile: Option<(f64, String)> = None;
    let mut nums = Vec::new();
    let mut units = Vec::new();
    for line in lines {
        let mut pos = 0;
        while pos < line.len() {
            let Some(m) = thick_at(line, pos, &mut nums, &mut units) else {
                pos = add(pos, 1);
                continue;
            };
            pos = m.end.max(add(pos, 1));
            let Some(v) = py_num(&m.v) else { continue };
            let k = m.k.as_deref().map(crate::chars::lower).unwrap_or_default();
            let mut assumed = false;
            let unit = if let Some(u) = m.u.as_deref().and_then(unit_of) {
                u
            } else {
                if m.second || k == "height" {
                    continue;
                }
                assumed = true;
                if matches!(hint, Some(Unit::In | Unit::Ft)) {
                    Unit::In
                } else {
                    Unit::Cm
                }
            };
            let cm = v * unit.cm();
            let top = if k == "height" { 5.0 } else { 10.0 };
            if !(0.1..=top).contains(&cm) {
                continue;
            }
            let whole = text(strip(slice(line, m.start, m.end)));
            let quote = if assumed {
                format!("{whole} (read as {})", unit.word())
            } else {
                whole
            };
            let slot = if k.starts_with("pile") {
                &mut pile
            } else {
                &mut thick
            };
            if slot.is_none() {
                *slot = Some((cm, quote));
            }
        }
    }
    thick.or(pile).map(|(cm, q)| {
        (
            cm,
            format!("thickness from the page: {}", prefix(&collapse_ws(&q), 60)),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(ls: &[&str]) -> Vec<Vec<char>> {
        ls.iter().map(|l| l.chars().collect()).collect()
    }

    #[test]
    fn readings_and_hints() {
        let ctx = Ctx::default();
        let rs = text_readings(&lines(&["Dimensions: 200 x 90 x 85 cm"]), ctx).unwrap_or_default();
        assert_eq!(rs.len(), 1);
        assert_eq!(
            rs.first().map(|r| (r.w, r.d, r.h)),
            Some((200.0, 90.0, Some(85.0)))
        );
        let boxed =
            text_readings(&lines(&["Box dimensions: 210 x 40 x 30 cm"]), ctx).unwrap_or_default();
        assert!(boxed.is_empty());
        assert_eq!(unit_hint(&lines(&["Length (m)", "3*4"])), Some(Unit::M));
        assert!(has_size(&"About 80 cm".chars().collect::<Vec<_>>()));
        assert!(!has_size(&"Model 80".chars().collect::<Vec<_>>()));
    }

    #[test]
    fn thickness_like_v1() {
        let t = thickness(&lines(&["Pile height: 0.5\""]), Some(Unit::In));
        assert_eq!(t.map(|t| t.0), Some(1.27));
        assert_eq!(
            thickness(&lines(&["Thickness: 0.25"]), Some(Unit::In)).map(|t| t.1),
            Some("thickness from the page: Thickness: 0.25 (read as inches)".to_owned())
        );
        assert!(thickness(&lines(&["Height: 75 cm"]), None).is_none());
    }
}
