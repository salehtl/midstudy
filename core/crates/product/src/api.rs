//! The crate's face for the server (through crates/wasm-product) and for tests: plain values in and out, JSON for
//! anything structured, never a panic. Lines of page text travel as one string joined by `\n` (v1's lines never hold
//! one: they are squashed).
use crate::PyError;
use crate::chars::{add, at, digit_value, is_digit, prefix, strip};
use crate::item::{Item, axis_of, items, line_chains};
use crate::merge::{Finished, finish as finish_sizes};
use crate::num::{num_first, py_num};
use crate::pyfmt::fmt_num;
use crate::reading::{
    Ctx, Made, Part, Reading, first_item as first_of, make_reading as make,
    parse_size_text as parse_size,
};
use crate::text::{
    has_size as text_has_size, text_readings as readings, thickness as thick, unit_hint as hint_of,
};
use crate::units::{Unit, unit_of};
use crate::words::{
    DISTRACT, INTRO, ROBOT, SAMPLE, SIZE_OPT, SIZE_WORDS, category_of as category,
    neutralize as neutral, search_b,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

fn split_lines(lines: &str) -> Vec<Vec<char>> {
    if lines.is_empty() {
        return Vec::new();
    }
    lines.split('\n').map(|l| l.chars().collect()).collect()
}

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

/// v1's `_HAS_SIZE.search(text)`.
#[must_use]
pub fn has_size(text: &str) -> bool {
    text_has_size(&chars(text))
}

/// One of v1's word patterns on `text`: `distract`, `intro`, `sample`, `size_opt`, `size_words` (all with Python's
/// `\b`) or `robot`.
#[must_use]
pub fn matches(kind: &str, text: &str) -> bool {
    match kind {
        "distract" => search_b(&DISTRACT, text),
        "intro" => search_b(&INTRO, text),
        "sample" => search_b(&SAMPLE, text),
        "size_opt" => search_b(&SIZE_OPT, text),
        "size_words" => search_b(&SIZE_WORDS, text),
        "robot" => ROBOT.is_match(text),
        _ => false,
    }
}

/// v1's `_category_of`.
#[must_use]
pub fn category_of(text: &str) -> Option<&'static str> {
    category(text)
}

/// v1's `_neutralize`.
#[must_use]
pub fn neutralize(text: &str) -> String {
    neutral(text)
}

/// v1's `_unit_hint` over the page's lines.
#[must_use]
pub fn unit_hint(lines: &str) -> Option<Unit> {
    hint_of(&split_lines(lines))
}

/// v1's `_text_readings` over the page's lines.
///
/// # Errors
///
/// v1's `KeyError` (an order-key token `re.I` matched but `_KEY_AXIS` doesn't know).
pub fn text_readings(lines: &str, ctx: Ctx) -> Result<Vec<Reading>, PyError> {
    readings(&split_lines(lines), ctx)
}

/// A rug's thickness from the page's lines: (cm, the note).
#[must_use]
pub fn thickness(lines: &str, hint: Option<Unit>) -> Option<(f64, String)> {
    thick(&split_lines(lines), hint)
}

/// v1's `_llm_text`: at most 20,000 characters of page text for the model, the lines around size words first.
#[must_use]
pub fn llm_text(lines: &str) -> String {
    const MAX: usize = 20_000;
    let kept: Vec<String> = lines
        .split('\n')
        .filter(|l| !strip(&chars(l)).is_empty())
        .map(neutral)
        .collect();
    let n = kept.len();
    let mut picked: Vec<usize> = Vec::new();
    let mut seen = vec![false; n];
    for (i, ln) in kept.iter().enumerate() {
        if search_b(&SIZE_WORDS, ln) {
            for j in i.saturating_sub(2)..n.min(add(i, 3)) {
                if let Some(s) = seen.get_mut(j)
                    && !*s
                {
                    *s = true;
                    picked.push(j);
                }
            }
        }
    }
    let rest = (0..n).filter(|i| !seen.get(*i).copied().unwrap_or(true));
    let mut out: Vec<&str> = Vec::new();
    let mut total = 0usize;
    for i in picked.iter().copied().chain(rest) {
        let Some(line) = kept.get(i) else { continue };
        let mut ln = prefix(line, 2000);
        let len = ln.chars().count();
        if add(total, add(len, 1)) > MAX {
            if add(total, 1) >= MAX {
                break;
            }
            ln = prefix(ln, MAX.saturating_sub(total).saturating_sub(1));
        }
        total = add(total, add(ln.chars().count(), 1));
        out.push(ln);
    }
    prefix(&out.join("\n"), MAX).to_owned()
}

/// v1's `_quote_numbers`: every number in a quote (as `NUM` reads it, then as `\d+(?:\.\d+)?`).
#[must_use]
pub fn quote_numbers(quote: &str) -> Vec<f64> {
    let s = chars(quote);
    let mut vals = Vec::new();
    let mut p = 0;
    while p < s.len() {
        match num_first(&s, p) {
            Some(e) => {
                if let Some(v) = py_num(&s.get(p..e).unwrap_or_default().iter().collect::<String>())
                {
                    vals.push(v);
                }
                p = e.max(add(p, 1));
            }
            None => p = add(p, 1),
        }
    }
    let mut p = 0;
    while p < s.len() {
        if !at(&s, p).is_some_and(is_digit) {
            p = add(p, 1);
            continue;
        }
        let mut e = p;
        while at(&s, e).is_some_and(is_digit) {
            e = add(e, 1);
        }
        if at(&s, e) == Some('.') && at(&s, add(e, 1)).is_some_and(is_digit) {
            e = add(e, 1);
            while at(&s, e).is_some_and(is_digit) {
                e = add(e, 1);
            }
        }
        let ascii: String = s
            .get(p..e)
            .unwrap_or_default()
            .iter()
            .map(|c| {
                digit_value(*c)
                    .and_then(|d| char::from_digit(d, 10))
                    .unwrap_or(*c)
            })
            .collect();
        if let Ok(v) = ascii.parse::<f64>() {
            vals.push(v);
        }
        p = e;
    }
    vals
}

/// An item as the differential tests compare it.
#[derive(Serialize)]
struct ItemView {
    start: usize,
    end: usize,
    value: f64,
    unit: Option<Unit>,
    axis: Option<&'static str>,
    num_text: String,
    to: Option<f64>,
}

fn view(it: &Item) -> ItemView {
    ItemView {
        start: it.start,
        end: it.end,
        value: it.value,
        unit: it.unit,
        axis: it.axis.map(crate::item::Axis::name),
        num_text: it.num_text.clone(),
        to: it.to,
    }
}

#[derive(Deserialize)]
struct SizeTextIn {
    text: String,
    ctx: Ctx,
    source: String,
    label: Option<String>,
    pair_ok: bool,
    warn_unitless: bool,
}

#[derive(Deserialize)]
struct MakeIn {
    parts: Vec<Part>,
    ctx: Ctx,
    source: String,
    quote: String,
    label: Option<String>,
    pair_ok: bool,
    warn_unitless: bool,
}

#[derive(Deserialize)]
struct FinishIn {
    variants: Vec<Option<Reading>>,
    cands: Vec<Reading>,
    is_rug: bool,
    thick: Option<(f64, String)>,
}

#[derive(Deserialize)]
struct TextIn {
    text: String,
}

#[derive(Deserialize)]
struct LinesIn {
    lines: String,
    #[serde(default)]
    ctx: Ctx,
    #[serde(default)]
    hint: Option<Unit>,
}

#[derive(Deserialize)]
struct ValueIn {
    value: f64,
}

#[allow(clippy::needless_pass_by_value)] // consumed by json!
fn made(m: Made) -> Value {
    json!({ "reading": m.reading, "dropped_unitless": m.dropped_unitless })
}

fn error(e: PyError) -> Value {
    json!({ "error": format!("{e:?}") })
}

fn input<T: for<'de> Deserialize<'de>>(json_in: &str) -> Result<T, Value> {
    serde_json::from_str(json_in).map_err(|e| json!({ "error": format!("bad input: {e}") }))
}

fn run(op: &str, json_in: &str) -> Result<Value, Value> {
    Ok(match op {
        "parse_size_text" => {
            let a: SizeTextIn = input(json_in)?;
            parse_size(
                &a.text,
                a.ctx,
                &a.source,
                a.label.as_deref(),
                a.pair_ok,
                a.warn_unitless,
            )
            .map_or_else(error, made)
        }
        "make_reading" => {
            let a: MakeIn = input(json_in)?;
            made(make(
                &a.parts,
                a.ctx,
                &a.source,
                &a.quote,
                a.label,
                a.pair_ok,
                a.warn_unitless,
            ))
        }
        "first_item" => {
            let a: TextIn = input(json_in)?;
            json!(first_of(&a.text))
        }
        "text_readings" => {
            let a: LinesIn = input(json_in)?;
            text_readings(&a.lines, a.ctx).map_or_else(error, |rs| json!({ "readings": rs }))
        }
        "unit_hint" => json!(unit_hint(&input::<LinesIn>(json_in)?.lines)),
        "thickness" => {
            let a: LinesIn = input(json_in)?;
            json!(thickness(&a.lines, a.hint))
        }
        "llm_text" => json!(llm_text(&input::<LinesIn>(json_in)?.lines)),
        "finish" => {
            let a: FinishIn = input(json_in)?;
            let f: Finished = finish_sizes(a.variants, a.cands, a.is_rug, a.thick.as_ref());
            json!(f)
        }
        "num" => json!(py_num(&input::<TextIn>(json_in)?.text)),
        "unit" => json!(unit_of(&input::<TextIn>(json_in)?.text)),
        "axis" => json!(axis_of(&input::<TextIn>(json_in)?.text).map(crate::item::Axis::name)),
        "fmt" => json!(fmt_num(input::<ValueIn>(json_in)?.value)),
        "quote_numbers" => json!(quote_numbers(&input::<TextIn>(json_in)?.text)),
        "items" => {
            let s = chars(&input::<TextIn>(json_in)?.text);
            json!(items(&s).iter().map(view).collect::<Vec<_>>())
        }
        "line_chains" => {
            let s = chars(&input::<TextIn>(json_in)?.text);
            match line_chains(&s) {
                Ok(cs) => {
                    json!({ "chains": cs.iter().map(|c| c.iter().map(view).collect::<Vec<_>>()).collect::<Vec<_>>() })
                }
                Err(e) => error(e),
            }
        }
        _ => return Err(json!({ "error": format!("unknown op {op}") })),
    })
}

/// The JSON entry point: `op` with its input; the answer, or `{"error": …}`.
#[must_use]
pub fn call(op: &str, json_in: &str) -> String {
    run(op, json_in).unwrap_or_else(|e| e).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_text_puts_size_words_first() {
        let mut lines: Vec<String> = (0..10).map(|i| format!("story line {i}")).collect();
        lines.push("Dimensions on request".to_owned());
        let t = llm_text(&lines.join("\n"));
        assert!(t.starts_with("story line 8\nstory line 9\nDimensions on request"));
    }

    #[test]
    fn quote_numbers_like_v1() {
        assert_eq!(
            quote_numbers("90 x 40 x 120 cm"),
            vec![90.0, 40.0, 120.0, 90.0, 40.0, 120.0]
        );
        assert_eq!(quote_numbers("31 1/2 wide"), vec![31.5, 31.0, 1.0, 2.0]);
    }

    #[test]
    fn json_face() {
        let out = call(
            "parse_size_text",
            r#"{"text":"200 x 90 cm","ctx":{"is_rug":false,"hint":null},"source":"jsonld","label":null,"pair_ok":true,"warn_unitless":true}"#,
        );
        let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
        assert_eq!(v.pointer("/reading/w"), Some(&json!(200.0)));
        assert_eq!(
            v.pointer("/reading/notes/0"),
            Some(&json!("read as W \u{d7} D"))
        );
        assert!(call("nope", "{}").contains("unknown op"));
        assert!(call("num", "not json").contains("bad input"));
    }
}
