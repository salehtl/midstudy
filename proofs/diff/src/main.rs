//! `midstudy-proofs-diff jpeg|png|slug LIST OUTDIR`: for each path in LIST, `midstudy_media::jpeg::strip` and
//! `is_clean` (or `png::strip`, or `slug::is_slug` of the file as a string), printed exactly as `lake exe mediastrip`
//! prints the Lean models' results: `name<TAB>ok<TAB>length<TAB>clean` (and the stripped bytes in OUTDIR/name) or
//! `name<TAB>err<TAB>Kind<TAB>clean` (`clean` is `-` for PNG); `name<TAB>res<TAB>true|false<TAB>-` for slugs;
//! `name<TAB>res<TAB>width,height,components,precision,marker<TAB>-` or `name<TAB>err<TAB>Kind<TAB>-` for `frame`
//! (`jpeg::frame_info`).
use std::io::Write;
use std::path::Path;

/// The variant's name of an error's `Debug` (`Truncated { at: 5 }` → `Truncated`).
fn kind(debug: &str) -> &str {
    debug.split([' ', '{']).next().unwrap_or(debug)
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, mode, list, out_dir] = args.as_slice() else {
        eprintln!("usage: midstudy-proofs-diff jpeg|png|slug|frame LIST OUTDIR");
        std::process::exit(2);
    };
    if !["jpeg", "png", "slug", "frame"].contains(&mode.as_str()) {
        eprintln!("mode must be jpeg, png, slug or frame");
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
        if mode == "slug" {
            // the generator writes valid UTF-8 only; anything else would be a harness bug
            let text = std::str::from_utf8(&data).map_err(std::io::Error::other)?;
            writeln!(out, "{name}\tres\t{}\t-", midstudy_media::slug::is_slug(text))?;
            continue;
        }
        if mode == "frame" {
            match midstudy_media::jpeg::frame_info(&data) {
                Ok(f) => writeln!(
                    out,
                    "{name}\tres\t{},{},{},{},{}\t-",
                    f.width, f.height, f.components, f.precision, f.marker
                )?,
                Err(e) => writeln!(out, "{name}\terr\t{}\t-", kind(&format!("{e:?}")))?,
            }
            continue;
        }
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
