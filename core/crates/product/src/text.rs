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

/// `str.split()`'s word count.
fn words(s: &[char]) -> usize {
    s.split(|c| is_space(*c)).filter(|w| !w.is_empty()).count()
}

/// v1's `_text_readings` (§2.11 layer 3): sizes with units (or the page's unit hint) in text lines, labelled
/// singles in neighbouring lines grouped (tables), distractors left out; introduced sizes first.
pub(crate) fn text_readings(lines: &[Vec<char>], ctx: Ctx) -> Result<Vec<Reading>, crate::PyError> {
    let mut found: Vec<(u8, usize, Reading)> = Vec::new();
    let mut singles: Vec<(usize, Axis, Part, String)> = Vec::new();
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
        for chain in line_chains(line)? {
            let (Some(first), Some(last)) = (chain.first(), chain.last()) else {
                continue;
            };
            let (start, end) = (first.start, last.end);
            let ctx_text = context(
                line,
                start,
                prev_end,
                if chain.len() >= 2 { prev_line } else { None },
            );
            if chain.len() >= 2 {
                prev_end = end;
                let mut probe = ctx_text.clone();
                probe.push(' ');
                probe.extend_from_slice(slice(line, start, end));
                if distract(&probe) {
                    continue;
                }
                if chain.iter().all(|it| it.unit.is_none()) {
                    let mut rest: Vec<char> = slice(line, 0, start).to_vec();
                    rest.extend_from_slice(slice(line, end, line.len()));
                    let rest_text = text(&rest);
                    let trimmed: Vec<char> = rest_text
                        .trim_matches(|c| " \t:-\u{2013}\u{2014}|".contains(c))
                        .chars()
                        .collect();
                    if words(&trimmed) > 2 || ctx.hint.is_none() {
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
    // singles in a block of lines (a table, "Width: 80 cm / Depth: 40 cm …") make one reading
    let mut group: Vec<(usize, Axis, Part, String)> = Vec::new();
    let mut flush = |group: &mut Vec<(usize, Axis, Part, String)>,
                     found: &mut Vec<(u8, usize, Reading)>| {
        let dia = group.first().is_some_and(|g| g.1 == Axis::Dia);
        if group.len() >= 2 || dia {
            let quote = prefix(
                &group
                    .iter()
                    .map(|g| g.3.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
                200,
            )
            .to_owned();
            let parts: Vec<Part> = group.iter().map(|g| g.2.clone()).collect();
            if let Some(r) = make_reading(&parts, ctx, "text", &quote, None, true, false).reading {
                found.push((0, order, r));
                order = add(order, 1);
            }
        }
        group.clear();
    };
    for s in singles {
        let breaks = group
            .last()
            .is_some_and(|last| group.iter().any(|g| g.1 == s.1) || s.0.saturating_sub(last.0) > 2);
        if breaks {
            flush(&mut group, &mut found);
        }
        group.push(s);
    }
    flush(&mut group, &mut found);
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

fn thick_at(s: &[char], p: usize) -> Option<ThickMatch> {
    let mut nums = Vec::new();
    let mut units = Vec::new();
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
        num_ends(s, q, &mut nums);
        for n in nums.iter().copied() {
            let u0 = skip_ws(s, n);
            units_ends(s, u0, &mut units);
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
    num_ends(s, p, &mut nums);
    for n in nums.iter().copied() {
        let u0 = skip_ws(s, n);
        units_ends(s, u0, &mut units);
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
    for line in lines {
        let mut pos = 0;
        while pos < line.len() {
            let Some(m) = thick_at(line, pos) else {
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
