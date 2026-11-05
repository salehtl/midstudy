//! `midstudy-proofs-diff jpeg|png LIST OUTDIR`: for each path in LIST, `midstudy_media::jpeg::strip` and `is_clean`
//! (or `png::strip`), printed exactly as `lake exe mediastrip` prints the Lean models' results:
//! `name<TAB>ok<TAB>length<TAB>clean` (and the stripped bytes in OUTDIR/name) or `name<TAB>err<TAB>Kind<TAB>clean`
//! (`clean` is `-` for PNG).
use std::io::Write;
use std::path::Path;

/// The variant's name of an error's `Debug` (`Truncated { at: 5 }` → `Truncated`).
fn kind(debug: &str) -> &str {
    debug.split([' ', '{']).next().unwrap_or(debug)
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, mode, list, out_dir] = args.as_slice() else {
        eprintln!("usage: midstudy-proofs-diff jpeg|png LIST OUTDIR");
        std::process::exit(2);
    };
    if mode != "jpeg" && mode != "png" {
        eprintln!("mode must be jpeg or png");
        std::process::exit(2);
    }
    let out_dir = Path::new(out_dir);
    std::fs::create_dir_all(out_dir)?;
    let mut out = std::io::stdout().lock();
    for path in std::fs::read_to_string(list)?.lines().filter(|l| !l.is_empty()) {
        let data = std::fs::read(path)?;
        let name = Path::new(path)
            .file_name()
            .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned());
        let (result, clean) = if mode == "jpeg" {
            (
                midstudy_media::jpeg::strip(&data)
                    .map(|s| s.bytes)
                    .map_err(|e| kind(&format!("{e:?}")).to_owned()),
                midstudy_media::jpeg::is_clean(&data).to_string(),
            )
        } else {
            (
                midstudy_media::png::strip(&data)
                    .map(|s| s.bytes)
                    .map_err(|e| kind(&format!("{e:?}")).to_owned()),
                "-".to_owned(),
            )
        };
        match result {
            Ok(bytes) => {
                std::fs::write(out_dir.join(&name), &bytes)?;
                writeln!(out, "{name}\tok\t{}\t{clean}", bytes.len())?;
            }
            Err(e) => writeln!(out, "{name}\terr\t{e}\t{clean}")?,
        }
    }
    Ok(())
}
