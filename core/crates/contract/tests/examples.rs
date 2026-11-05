//! Every recorded example in `contract/examples/*.json` parses as the type its schema names and serializes back to
//! the same JSON (numbers compared by value): nothing invented, nothing lost, unknown keys of open objects included
//! (calib.json, lighting.json diagnostics). The one allowed difference: an optional key whose value is `null` may come
//! back absent, because typify maps an optional nullable key to `Option<T>` (see `contract/api/README.md`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp,
    reason = "a test; numbers must come back exactly"
)]

use std::{fs, path::PathBuf};

use serde_json::Value;

include!(concat!(env!("OUT_DIR"), "/roundtrip.rs"));

/// Every key and value of `got` is in `want` (numbers by value); returns the keys of `want` that `got` dropped.
fn subset(got: &Value, want: &Value, at: &str, dropped: &mut Vec<String>) -> Result<(), String> {
    match (got, want) {
        (Value::Object(g), Value::Object(w)) => {
            for (k, gv) in g {
                let Some(wv) = w.get(k) else {
                    return Err(format!("{at}/{k}: invented ({gv})"));
                };
                subset(gv, wv, &format!("{at}/{k}"), dropped)?;
            }
            dropped.extend(
                w.keys()
                    .filter(|k| !g.contains_key(*k))
                    .map(|k| format!("{at}/{k}")),
            );
            Ok(())
        }
        (Value::Array(g), Value::Array(w)) => {
            if g.len() != w.len() {
                return Err(format!("{at}: {} items, not {}", g.len(), w.len()));
            }
            g.iter()
                .zip(w)
                .enumerate()
                .try_for_each(|(i, (gv, wv))| subset(gv, wv, &format!("{at}/{i}"), dropped))
        }
        (Value::Number(g), Value::Number(w)) => {
            let (a, b) = (
                g.as_f64().unwrap_or(f64::NAN),
                w.as_f64().unwrap_or(f64::NAN),
            );
            if a == b {
                Ok(())
            } else {
                Err(format!("{at}: {g} is not {w}"))
            }
        }
        _ if got == want => Ok(()),
        _ => Err(format!("{at}: {got} is not {want}")),
    }
}

#[test]
fn every_example_round_trips() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contract/examples");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .expect("contract/examples")
        .map(|e| e.unwrap().path())
        .collect();
    files.retain(|p| p.extension().is_some_and(|x| x == "json"));
    files.sort();
    assert!(!files.is_empty(), "no examples in {}", dir.display());
    let (mut checked, mut failures, mut dropped_total) = (0, Vec::new(), 0);
    for file in &files {
        let doc: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        for (i, ex) in doc["examples"]
            .as_array()
            .expect("examples")
            .iter()
            .enumerate()
        {
            let ty = ex["type"].as_str().expect("type");
            let body = &ex["body"];
            checked += 1;
            match roundtrip(ty, body) {
                Err(e) => failures.push(format!("{name} #{i} ({ty}): does not parse: {e}")),
                Ok(back) => {
                    let mut dropped = Vec::new();
                    if let Err(e) = subset(&back, body, "", &mut dropped) {
                        failures.push(format!("{name} #{i} ({ty}): {e}"));
                    } else if roundtrip(ty, &back).as_ref() != Ok(&back) {
                        failures.push(format!(
                            "{name} #{i} ({ty}): a second round trip changes it"
                        ));
                    }
                    for d in &dropped {
                        if body.pointer(d) != Some(&Value::Null) {
                            failures.push(format!("{name} #{i} ({ty}): {d} is lost"));
                        }
                    }
                    dropped_total += dropped.len();
                }
            }
        }
    }
    println!(
        "{checked} examples in {} files round-trip; {dropped_total} optional nulls came back absent",
        files.len()
    );
    assert!(
        failures.is_empty(),
        "{} of {checked} examples fail:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn names_are_unique_and_unknown_names_are_refused() {
    let mut sorted = TYPE_NAMES.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), TYPE_NAMES.len());
    assert!(roundtrip("NoSuchType", &Value::Null).is_err());
}
