//! The answer's sizes (the end of v1's `_extract`): a rug's thickness, readings within 0.5 cm made one, at most 16,
//! each size option pointed at its candidate, and v1's `Reading.out()`.
use crate::chars::prefix;
use crate::pyfmt::py_round;
use crate::reading::Reading;
use crate::units::Unit;
use crate::words::{INTRO, search_b};
use serde::Serialize;

/// v1's `MAX_CANDIDATES`.
const MAX_CANDIDATES: usize = 16;

/// One `dims_candidates` entry of the answer (v1's `Reading.out()`).
#[derive(Debug, Serialize)]
pub struct ReadingOut {
    w: f64,
    d: f64,
    h: Option<f64>,
    unit: Unit,
    label: Option<String>,
    unit_note: Option<String>,
    notes: Vec<String>,
    quote: String,
    source: String,
}

fn out(r: &Reading) -> ReadingOut {
    let round = |v: f64| py_round(v + 1e-9, 1);
    ReadingOut {
        w: round(r.w),
        d: round(r.d),
        h: r.h.map(round),
        unit: r.unit,
        label: r.label.clone(),
        unit_note: r.unit_note.clone(),
        notes: r.notes.clone(),
        quote: prefix(&r.quote, 200).to_owned(),
        source: r.source.clone(),
    }
}

/// What `finish` answers.
#[derive(Debug, Serialize)]
pub struct Finished {
    /// `dims_candidates`.
    pub dims_candidates: Vec<ReadingOut>,
    /// Each size option's `dims_index` (only when there are several options, as v1 answered `variants`).
    pub variant_index: Vec<Option<usize>>,
    /// The rug's thickness came from the page text (v1 then listed the `text` layer).
    pub thickness_used: bool,
}

/// The end of v1's `_extract`: `variants` are the shop's size options (their readings, None when unreadable), `cands`
/// the other readings in layer order; a rug's missing heights become its thickness (`thick`: cm and the note) or 1 cm.
pub(crate) fn finish(
    variants: Vec<Option<Reading>>,
    cands: Vec<Reading>,
    is_rug: bool,
    thick: Option<&(f64, String)>,
) -> Finished {
    let mut thickness_used = false;
    // the shop's sizes first (each kept in its slot, so the options can find their candidate), then the layers
    let mut options = variants;
    let mut rest = cands;
    if is_rug {
        for r in options.iter_mut().flatten().chain(rest.iter_mut()) {
            if r.h.is_none() {
                if let Some((cm, note)) = thick {
                    r.h = Some(*cm);
                    r.notes.push(note.clone());
                    thickness_used = true;
                } else {
                    r.h = Some(1.0);
                    r.notes
                        .push("thickness not on the page: 1 cm assumed".to_owned());
                }
            }
        }
    }
    let mut merged: Vec<Reading> = Vec::new();
    for r in options.iter().flatten().chain(rest.iter()) {
        let Some(twin) = merged.iter().position(|c| c.same(r)) else {
            merged.push(r.clone());
            continue;
        };
        let Some(c) = merged.get_mut(twin) else {
            continue;
        };
        if c.source == r.source
            && matches!(c.unit, Unit::In | Unit::Ft)
            && matches!(r.unit, Unit::Cm | Unit::Mm | Unit::M)
        {
            *c = r.clone(); // "6'7\" x 9'10\" (200 x 300 cm)": the metric reading
        } else if c.source == r.source
            && !r.quote.is_empty()
            && !search_b(&INTRO, &c.quote)
            && search_b(&INTRO, &r.quote)
        {
            c.quote.clone_from(&r.quote);
            c.label.clone_from(&r.label);
        }
    }
    merged.truncate(MAX_CANDIDATES);
    let variant_index = if options.len() > 1 {
        options
            .iter()
            .map(|r| {
                r.as_ref()
                    .and_then(|r| merged.iter().position(|c| c.same(r)))
            })
            .collect()
    } else {
        Vec::new()
    };
    Finished {
        dims_candidates: merged.iter().map(out).collect(),
        variant_index,
        thickness_used,
    }
}
