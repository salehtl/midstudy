//! The JSON face (what the server calls through wasm) on arbitrary input: every op answers JSON, never panics, whatever
//! the input's shape; a `finish` of readings that parse keeps at most 16 candidates.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_product::api;

const OPS: [&str; 15] = [
    "parse_size_text", "make_reading", "first_item", "text_readings", "unit_hint", "thickness", "llm_text", "finish", "num",
    "unit", "axis", "fmt", "quote_numbers", "items", "line_chains",
];

fuzz_target!(|data: &[u8]| {
    let Some((&pick, rest)) = data.split_first() else { return };
    let op = OPS[usize::from(pick) % OPS.len()];
    let input = String::from_utf8_lossy(rest);
    let out = api::call(op, &input);
    let v: serde_json::Value = serde_json::from_str(&out).expect("every answer is JSON");
    if op == "finish" {
        if let Some(c) = v.get("dims_candidates").and_then(|c| c.as_array()) {
            assert!(c.len() <= 16);
        }
    }
});
