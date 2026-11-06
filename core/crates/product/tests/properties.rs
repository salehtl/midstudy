//! Properties of the size reader on arbitrary text (proptest): nothing panics, every answer is well formed (sizes in
//! range, spans inside the line and in order, JSON that parses), and the formatting helpers round-trip. Exact
//! agreement with v1 is the differential test's job (server/test/product/sizes.test.ts against v1's own Python).
use midstudy_product::api;
use proptest::prelude::*;
use serde_json::Value;

/// Text built from the pieces shops write sizes with, plus anything at all.
fn size_text() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        Just("80".to_owned()),
        Just("31 1/2".to_owned()),
        Just("\u{be}".to_owned()),
        Just("80,5".to_owned()),
        Just(" x ".to_owned()),
        Just("\u{d7}".to_owned()),
        Just("cm".to_owned()),
        Just("\"".to_owned()),
        Just("'".to_owned()),
        Just("W".to_owned()),
        Just("H\u{f6}he".to_owned()),
        Just("(W x D x H)".to_owned()),
        Just("Box".to_owned()),
        Just("Thickness: ".to_owned()),
        Just("\u{2013}".to_owned()),
        Just("\u{131}".to_owned()),
        Just("\u{b2}".to_owned()),
        Just("\u{663}".to_owned()),
        Just("\t".to_owned()),
        Just("\n".to_owned()),
        "[0-9]{1,12}",
        "[ a-zA-Z:.=()]{1,6}",
        any::<String>(),
    ];
    proptest::collection::vec(piece, 0..24).prop_map(|v| v.concat())
}

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::Null)
}

fn in_range(reading: &Value) -> bool {
    let num = |k: &str| reading.get(k).and_then(Value::as_f64);
    let (Some(width), Some(depth)) = (num("w"), num("d")) else {
        return false;
    };
    let height_ok = match reading.get("h") {
        Some(Value::Null) | None => true,
        Some(h) => h.as_f64().is_some_and(|h| (0.1..=2000.0).contains(&h)),
    };
    (1.0..=2000.0).contains(&width) && (1.0..=2000.0).contains(&depth) && height_ok
}

proptest! {
    #![proptest_config(ProptestConfig { cases: if cfg!(miri) { 4 } else { 512 }, ..ProptestConfig::default() })]

    #[test]
    fn items_are_spans_in_order(text in size_text()) {
        let out = json(&api::call("items", &serde_json::json!({ "text": text }).to_string()));
        let items = out.as_array().cloned().unwrap_or_default();
        let len = text.chars().count();
        let mut last = 0;
        for it in items {
            let start = it.get("start").and_then(Value::as_u64).unwrap_or(u64::MAX);
            let end = it.get("end").and_then(Value::as_u64).unwrap_or(0);
            prop_assert!(start >= last && end > start && end <= len as u64, "{it}");
            prop_assert!(it.get("value").and_then(Value::as_f64).is_some_and(|v| v > 0.0), "{it}");
            last = end;
        }
    }

    #[test]
    fn chains_and_readings_are_well_formed(text in size_text(), rug in any::<bool>(), hint in prop_oneof![Just(None), Just(Some("m")), Just(Some("in"))]) {
        let chains = json(&api::call("line_chains", &serde_json::json!({ "text": text }).to_string()));
        if let Some(cs) = chains.get("chains").and_then(Value::as_array) {
            for c in cs {
                let n = c.as_array().map_or(0, Vec::len);
                prop_assert!((1..=3).contains(&n), "a chain of {n}");
            }
        } else {
            prop_assert_eq!(chains.get("error").and_then(Value::as_str), Some("KeyError"));
        }
        let ctx = serde_json::json!({ "is_rug": rug, "hint": hint });
        let made = json(&api::call("parse_size_text", &serde_json::json!({ "text": text, "ctx": ctx, "source": "jsonld", "label": null, "pair_ok": true, "warn_unitless": true }).to_string()));
        if let Some(r) = made.get("reading").filter(|r| !r.is_null()) {
            prop_assert!(in_range(r), "{r}");
        }
        let lines = text.replace('\r', " ");
        let rs = json(&api::call("text_readings", &serde_json::json!({ "lines": lines, "ctx": ctx }).to_string()));
        for r in rs.get("readings").and_then(Value::as_array).cloned().unwrap_or_default() {
            prop_assert!(in_range(&r), "{r}");
        }
    }

    #[test]
    fn nothing_panics(text in any::<String>()) {
        let _ = api::has_size(&text);
        for kind in ["distract", "intro", "sample", "size_opt", "size_words", "robot"] {
            let _ = api::matches(kind, &text);
        }
        let _ = api::category_of(&text);
        let _ = api::unit_hint(&text);
        let _ = api::thickness(&text, None);
        let _ = api::llm_text(&text);
        let _ = api::quote_numbers(&text);
        for op in ["num", "unit", "axis", "first_item", "quote_numbers", "items", "line_chains"] {
            let out = api::call(op, &serde_json::json!({ "text": text }).to_string());
            prop_assert!(!out.is_empty(), "{op}: no answer");
        }
        // and JSON that isn't the right shape is refused, not a panic
        let refused = api::call("finish", &text);
        prop_assert!(refused.starts_with('{'), "finish answered {refused}");
    }

    #[test]
    fn llm_text_is_bounded(text in size_text()) {
        let n = api::llm_text(&text).chars().count();
        prop_assert!(n <= 20_000, "{n} characters");
    }

    #[test]
    fn fmt_round_trips(v in -1e9f64..1e9f64) {
        let s = json(&api::call("fmt", &serde_json::json!({ "value": v }).to_string()));
        let text = s.as_str().unwrap_or("x").to_owned();
        let back: f64 = text.parse().unwrap_or(f64::NAN);
        prop_assert!((back - v).abs() <= 1e-5 * v.abs().max(1.0), "{v} -> {text}");
    }
}
