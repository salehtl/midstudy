//! Every size reader on arbitrary text (any bytes, read as UTF-8 with replacement): nothing panics, items are spans in
//! order inside the text, every reading is in range (1–2000 cm, a height from 0.1), the model's text stays under its
//! 20,000-character cap, and v1's one exception (KeyError) is the only error.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_product::{Ctx, Unit, api};
use serde_json::Value;

fn in_range(r: &Value) -> bool {
    let num = |k: &str| r.get(k).and_then(Value::as_f64);
    let (Some(w), Some(d)) = (num("w"), num("d")) else { return false };
    let h_ok = match r.get("h") {
        Some(Value::Null) | None => true,
        Some(h) => h.as_f64().is_some_and(|h| (0.1..=2000.0).contains(&h)),
    };
    (1.0..=2000.0).contains(&w) && (1.0..=2000.0).contains(&d) && h_ok
}

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let len = text.chars().count() as u64;
    let items: Value = serde_json::from_str(&api::call("items", &serde_json::json!({ "text": text }).to_string())).expect("items answer JSON");
    let mut last = 0;
    for it in items.as_array().expect("a list") {
        let (start, end) = (it["start"].as_u64().expect("start"), it["end"].as_u64().expect("end"));
        assert!(start >= last && end > start && end <= len, "{it}");
        last = end;
    }
    let hint = match data.first().map(|b| b % 4) {
        Some(1) => Some(Unit::M),
        Some(2) => Some(Unit::In),
        Some(3) => Some(Unit::Cm),
        _ => None,
    };
    let ctx = Ctx { is_rug: data.len() % 2 == 0, hint, is_bed: data.len() % 3 == 0 };
    match api::text_readings(&text, ctx) {
        Ok(rs) => {
            for r in rs {
                let v = serde_json::to_value(&r).expect("a reading serializes");
                assert!(in_range(&v), "{v}");
            }
        }
        Err(e) => assert_eq!(format!("{e:?}"), "KeyError"),
    }
    let made: Value = serde_json::from_str(&api::call(
        "parse_size_text",
        &serde_json::json!({ "text": text, "ctx": { "is_rug": ctx.is_rug, "hint": hint, "is_bed": ctx.is_bed }, "source": "jsonld", "label": null, "pair_ok": true, "warn_unitless": true }).to_string(),
    ))
    .expect("parse_size_text answers JSON");
    if let Some(r) = made.get("reading").filter(|r| !r.is_null()) {
        assert!(in_range(r), "{r}");
    }
    let _ = api::has_size(&text);
    let _ = api::unit_hint(&text);
    if let Some((cm, note)) = api::thickness(&text, hint) {
        assert!((0.1..=10.0).contains(&cm) && note.starts_with("thickness from the page: "));
    }
    assert!(api::llm_text(&text).chars().count() <= 20_000);
    let _ = api::quote_numbers(&text);
    let _ = api::category_of(&text);
    for kind in ["distract", "intro", "sample", "size_opt", "size_words", "robot"] {
        let _ = api::matches(kind, &text);
    }
});
