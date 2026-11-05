//! Generates the contract's serde types with typify from `schema.json` (every named type of the contract, written by
//! `scripts/gen-contract.mjs`; never edited by hand), and `roundtrip.rs`, which the examples test uses to parse any
//! named type by its name.
use std::{env, error::Error, fmt::Write as _, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let schema_path = manifest.join("schema.json");
    println!("cargo::rerun-if-changed={}", schema_path.display());
    let root: schemars::schema::RootSchema =
        serde_json::from_str(&fs::read_to_string(&schema_path)?)?;
    let names: Vec<String> = root.definitions.keys().cloned().collect();

    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_struct_builder(false);
    let mut space = typify::TypeSpace::new(&settings);
    space.add_root_schema(root)?;
    let out = PathBuf::from(env::var("OUT_DIR")?);
    fs::write(out.join("types.rs"), space.to_stream().to_string())?;

    // roundtrip(name, json): parse json as the named type and write it back, or say why it didn't parse.
    let mut rt = String::from(
        "/// Parses `value` as the contract type called `name` and serializes it back.\n\
         fn roundtrip(name: &str, value: &serde_json::Value) -> Result<serde_json::Value, String> {\n    match name {\n",
    );
    for name in &names {
        writeln!(
            rt,
            "        {name:?} => serde_json::from_value::<midstudy_contract::{name}>(value.clone())\
             .map_err(|e| e.to_string())\
             .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),"
        )?;
    }
    rt.push_str("        other => Err(format!(\"no contract type named {other}\")),\n    }\n}\n");
    writeln!(
        rt,
        "/// Every contract type's name.\nconst TYPE_NAMES: &[&str] = &{names:?};"
    )?;
    fs::write(out.join("roundtrip.rs"), rt)?;
    Ok(())
}
