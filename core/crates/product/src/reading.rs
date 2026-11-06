//! Size readings: v1's `Reading`, `_Ctx`, `_plausible`, `_make_reading`, `_map_axes`, `_parts` and `_parse_size_text`
//! (contract §2.11 Mapping and Units).
use crate::chars::{prefix, strip_str};
use crate::item::{Item, line_chains};
use crate::pyfmt::fmt_num;
use crate::units::Unit;
use serde::{Deserialize, Serialize};

/// What the size rules know about the page (v1's `_Ctx`; the warnings stay with the caller, which is told when a
/// size without a unit was left out).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Ctx {
    /// The page sells a rug.
    pub is_rug: bool,
    /// The unit the page measures in elsewhere.
    pub hint: Option<Unit>,
    /// The page sells a bed.
    #[serde(default)]
    pub is_bed: bool,
}

/// One size reading, in cm (v1's `Reading`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    /// Width (cm).
    pub w: f64,
    /// Depth (cm).
    pub d: f64,
    /// Height (cm), None when the page gives none.
    pub h: Option<f64>,
    /// The unit the page used.
    pub unit: Unit,
    /// The size's label.
    pub label: Option<String>,
    /// How it was converted, when the page didn't use cm.
    pub unit_note: Option<String>,
    /// How labels were mapped.
    pub notes: Vec<String>,
    /// The text it came from.
    pub quote: String,
    /// The layer it came from.
    pub source: String,
}

impl Reading {
    /// v1's `Reading.same`: within 0.5 cm, or 1 %, on every axis (no height on both counts as the same).
    pub(crate) fn same(&self, o: &Self) -> bool {
        fn near(a: f64, b: f64) -> bool {
            (a - b).abs() <= f64::max(0.5, 0.01 * f64::max(a, b))
        }
        let h = match (self.h, o.h) {
            (None, None) => true,
            (Some(a), Some(b)) => near(a, b),
            _ => false,
        };
        near(self.w, o.w) && near(self.d, o.d) && h
    }
}

/// One part of a size: (axis label, value in its unit, unit, the number as written, the far end of a range).
#[derive(Clone, Debug, Deserialize)]
pub struct Part {
    /// `w`, `d`, `h`, `l` or `dia`, or None.
    pub axis: Option<String>,
    /// The value, in `unit`.
    pub value: f64,
    /// The unit, or None when the page gave none.
    pub unit: Option<Unit>,
    /// The number as the page wrote it.
    pub text: String,
    /// The far end of a range (`180–220`), if any.
    #[serde(default)]
    pub to: Option<f64>,
}

/// v1's `_parts(chain)`.
pub(crate) fn parts_of(chain: &[Item]) -> Vec<Part> {
    chain
        .iter()
        .map(|it| Part {
            axis: it.axis.map(|a| a.name().to_owned()),
            value: it.value,
            unit: it.unit,
            text: it.num_text.clone(),
            to: it.to,
        })
        .collect()
}

/// v1's `_plausible`.
fn plausible(w: Option<f64>, d: Option<f64>, h: Option<f64>, is_rug: bool) -> bool {
    let (Some(w), Some(d)) = (w, d) else {
        return false;
    };
    if !((1.0..=2000.0).contains(&w) && (1.0..=2000.0).contains(&d)) {
        return false;
    }
    match h {
        None => true,
        Some(h) if is_rug => (0.1..=30.0).contains(&h),
        Some(h) => (1.0..=2000.0).contains(&h),
    }
}

/// The result of v1's `_map_axes`: its `out` dict ({w, d, h} in cm, plus any other key v1 stored, such as a second
/// `l`), the axis each part got, the notes.
struct Mapped {
    out: Vec<(char, f64)>,
    axis_of: Vec<char>,
    notes: Vec<String>,
}

impl Mapped {
    fn get(&self, k: char) -> Option<f64> {
        self.out.iter().find(|(key, _)| *key == k).map(|(_, v)| *v)
    }

    fn set(&mut self, k: char, v: f64) {
        match self.out.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = v,
            None => self.out.push((k, v)),
        }
    }
}

/// An axis label as v1 compared it (`"w"`, `"dia"`, …): `l` is `'l'`, `dia` is `'x'`, an unknown label `'?'`.
fn axis_code(a: Option<&str>) -> Option<char> {
    match a? {
        "w" => Some('w'),
        "d" => Some('d'),
        "h" => Some('h'),
        "l" => Some('l'),
        "dia" => Some('x'),
        _ => Some('?'),
    }
}

/// v1's `_map_axes`: None when the reading isn't a plausible size.
fn map_axes(parts: &[Part], units: &[Unit], ctx: Ctx, pair_ok: bool) -> Option<Mapped> {
    let mut notes = Vec::new();
    let cm: Vec<f64> = parts
        .iter()
        .zip(units)
        .map(|(p, u)| p.value * u.cm())
        .collect();
    let mut axes: Vec<Option<char>> = parts.iter().map(|p| axis_code(p.axis.as_deref())).collect();
    let li = axes.iter().position(|a| *a == Some('l'));
    let wi = axes.iter().position(|a| *a == Some('w'));
    match (li, wi) {
        (Some(li), Some(wi)) => {
            let (lv, wv) = (
                cm.get(li).copied().unwrap_or(0.0),
                cm.get(wi).copied().unwrap_or(0.0),
            );
            if ctx.is_bed {
                if let Some(a) = axes.get_mut(li) {
                    *a = Some('d');
                }
                notes.push("length read as depth (a bed's length runs head to foot)".to_owned());
            } else if lv > wv {
                if let Some(a) = axes.get_mut(li) {
                    *a = Some('w');
                }
                if let Some(a) = axes.get_mut(wi) {
                    *a = Some('d');
                }
                notes.push(
                    "length read as width and width as depth (the longer side is the width)"
                        .to_owned(),
                );
            } else {
                if let Some(a) = axes.get_mut(li) {
                    *a = Some('d');
                }
                notes.push("length read as depth (the page gives a longer width)".to_owned());
            }
        }
        (Some(_), None) => {
            for a in &mut axes {
                if *a == Some('l') {
                    *a = Some('w');
                }
            }
            notes.push("length read as width".to_owned());
        }
        _ => {}
    }
    let mut out = Mapped {
        out: Vec::new(),
        axis_of: axes.iter().map(|a| a.unwrap_or(' ')).collect(),
        notes: Vec::new(),
    };
    for (i, (a, v)) in axes.iter().zip(&cm).enumerate() {
        match a {
            Some('x') => {
                if out.get('w').is_some() || out.get('d').is_some() {
                    return None;
                }
                out.set('w', *v);
                out.set('d', *v);
                notes.push("diameter read as width and depth".to_owned());
                if let Some(slot) = out.axis_of.get_mut(i) {
                    *slot = 'w';
                }
            }
            // w, d, h, or a key v1 stored but never read (a second `l` when the first became w or d)
            Some(k) => {
                if out.get(*k).is_some() {
                    return None;
                }
                out.set(*k, *v);
            }
            None => {}
        }
    }
    let free: Vec<usize> = axes
        .iter()
        .enumerate()
        .filter(|(_, a)| a.is_none())
        .map(|(i, _)| i)
        .collect();
    if !free.is_empty() {
        let order: Vec<char> = ['w', 'd', 'h']
            .into_iter()
            .filter(|k| out.get(*k).is_none())
            .collect();
        if free.len() > order.len() {
            return None;
        }
        if parts.len() == 3 && free.len() == 3 {
            notes.push("read as W \u{d7} D \u{d7} H".to_owned());
        } else if parts.len() == 2 && free.len() == 2 {
            if !(ctx.is_rug || pair_ok) {
                return None;
            }
            if !ctx.is_rug {
                notes.push("read as W \u{d7} D".to_owned());
            }
        }
        for (k, i) in order.into_iter().zip(free) {
            let v = cm.get(i).copied().unwrap_or(0.0);
            out.set(k, v);
            if let Some(slot) = out.axis_of.get_mut(i) {
                *slot = k;
            }
        }
    }
    if !plausible(out.get('w'), out.get('d'), out.get('h'), ctx.is_rug) {
        return None;
    }
    out.notes = notes;
    Some(out)
}

/// What a reading attempt gave, and whether v1 would have warned about a size without a unit (`ctx.drop_unitless()`).
#[derive(Debug, Default)]
pub struct Made {
    /// The reading, if the parts make a plausible size.
    pub reading: Option<Reading>,
    /// A size without a unit was left out, and the caller asked to be told (v1's warning).
    pub dropped_unitless: bool,
}

/// v1's `_make_reading` (§2.11 Mapping and Units).
pub(crate) fn make_reading(
    parts: &[Part],
    ctx: Ctx,
    source: &str,
    quote: &str,
    label: Option<String>,
    pair_ok: bool,
    warn_unitless: bool,
) -> Made {
    let mut units: Vec<Option<Unit>> = parts.iter().map(|p| p.unit).collect();
    let mut tries: Vec<Option<Unit>> = vec![None];
    if units.iter().all(Option::is_none) {
        let Some(hint) = ctx.hint else {
            return Made {
                reading: None,
                dropped_unitless: warn_unitless,
            };
        };
        tries = vec![Some(hint)];
        if hint != Unit::Cm {
            tries.push(Some(Unit::Cm));
        }
    }
    let mut unit_note: Option<String> = None;
    let mut got = None;
    let mut used_units: Vec<Unit> = Vec::new();
    for hinted in tries {
        if let Some(h) = hinted {
            units = vec![Some(h); parts.len()];
            unit_note = Some(if Some(h) == ctx.hint {
                format!(
                    "no unit on the page: read as {}, as the page's other sizes",
                    h.name()
                )
            } else {
                format!(
                    "no unit on the page: read as cm (in {} it would be far too big)",
                    ctx.hint.map_or("None", Unit::name)
                )
            });
        } else {
            let fill = units.iter().rev().find_map(|u| *u);
            units = units.iter().map(|u| u.or(fill)).collect();
        }
        let filled: Vec<Unit> = units.iter().map(|u| u.unwrap_or(Unit::Cm)).collect();
        if let Some(m) = map_axes(parts, &filled, ctx, pair_ok) {
            got = Some(m);
            used_units = filled;
            break;
        }
    }
    let Some(mapped) = got else {
        return Made::default();
    };
    let mut notes = mapped.notes.clone();
    let main = used_units.first().copied().unwrap_or(Unit::Cm);
    if unit_note.is_none() && used_units.iter().any(|u| *u != Unit::Cm) {
        let rank = |a: char| match a {
            'w' => 0,
            'd' => 1,
            'h' => 2,
            _ => 3,
        };
        let mut order: Vec<usize> = (0..parts.len()).collect();
        order.sort_by_key(|i| rank(mapped.axis_of.get(*i).copied().unwrap_or(' ')));
        let ps: Vec<(&Part, Unit)> = order
            .iter()
            .filter_map(|i| Some((parts.get(*i)?, *used_units.get(*i)?)))
            .collect();
        if ps
            .iter()
            .any(|(p, _)| p.unit == Some(Unit::Ft) && p.text.contains('\''))
        {
            let shown: Vec<String> = ps
                .iter()
                .map(|(p, u)| {
                    if p.text.contains('\'') {
                        p.text.clone()
                    } else {
                        let mark = match u {
                            Unit::Ft => "'".to_owned(),
                            Unit::In => "\"".to_owned(),
                            u => format!(" {}", u.name()),
                        };
                        format!("{}{mark}", p.text)
                    }
                })
                .collect();
            unit_note = Some(format!("from feet and inches: {}", shown.join(" \u{d7} ")));
        } else if used_units.iter().all(|u| *u == main) {
            let nums: Vec<&str> = ps.iter().map(|(p, _)| p.text.as_str()).collect();
            unit_note = Some(format!(
                "from {}: {} {}",
                main.word(),
                nums.join(" \u{d7} "),
                main.name()
            ));
        } else {
            let shown: Vec<String> = ps
                .iter()
                .map(|(p, u)| format!("{} {}", p.text, u.name()))
                .collect();
            unit_note = Some(format!("from {}", shown.join(" \u{d7} ")));
        }
    }
    for ((p, u), a) in parts.iter().zip(&used_units).zip(&mapped.axis_of) {
        if let Some(to) = p.to.filter(|t| *t != 0.0) {
            let word = match a {
                'w' => "width",
                'd' => "depth",
                'h' => "height",
                _ => continue,
            };
            notes.push(format!(
                "{word} extends to {} {} (the smaller size is used)",
                fmt_num(to),
                u.name()
            ));
        }
    }
    let (Some(w), Some(d)) = (mapped.get('w'), mapped.get('d')) else {
        return Made::default();
    };
    Made {
        reading: Some(Reading {
            w,
            d,
            h: mapped.get('h'),
            unit: main,
            label,
            unit_note,
            notes,
            quote: quote.to_owned(),
            source: source.to_owned(),
        }),
        dropped_unitless: false,
    }
}

/// v1's `_parse_size_text` on text the caller already unescaped, cut to 2000 characters and squashed: the first
/// chain of 2 or 3 that makes a size.
pub(crate) fn parse_size_text(
    text_in: &str,
    ctx: Ctx,
    source: &str,
    label: Option<&str>,
    pair_ok: bool,
    warn_unitless: bool,
) -> Result<Made, crate::PyError> {
    let s: Vec<char> = text_in.chars().collect();
    let stripped = strip_str(text_in);
    let quote = prefix(stripped, 200);
    let mut dropped = false;
    for chain in line_chains(&s)? {
        if (2..=3).contains(&chain.len()) {
            let lab = label.map_or_else(|| prefix(stripped, 80).to_owned(), str::to_owned);
            let made = make_reading(
                &parts_of(&chain),
                ctx,
                source,
                quote,
                Some(lab),
                pair_ok,
                warn_unitless,
            );
            dropped |= made.dropped_unitless;
            if made.reading.is_some() {
                return Ok(Made {
                    reading: made.reading,
                    dropped_unitless: dropped,
                });
            }
        }
    }
    Ok(Made {
        reading: None,
        dropped_unitless: dropped,
    })
}

/// The first measurement of a squashed structured value (v1's `_single` on a string): (value, unit, the number as
/// written).
pub(crate) fn first_item(text_in: &str) -> Option<(f64, Option<Unit>, String)> {
    let s: Vec<char> = text_in.chars().collect();
    let it = crate::item::items(&s).into_iter().next()?;
    Some((it.value, it.unit, it.num_text))
}
