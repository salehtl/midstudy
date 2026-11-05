//! `midstudy-proofs-diff LIST OUTDIR`: for each path in LIST, `midstudy_media::jpeg::strip` and `is_clean`, printed
//! exactly as `lake exe jpegstrip` prints the Lean model's results: `name<TAB>ok<TAB>length<TAB>clean` (and the
//! stripped bytes in OUTDIR/name) or `name<TAB>err<TAB>Kind<TAB>clean`.
use std::io::Write;
use std::path::Path;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, list, out_dir] = args.as_slice() else {
        eprintln!("usage: midstudy-proofs-diff LIST OUTDIR");
        std::process::exit(2);
    };
    let out_dir = Path::new(out_dir);
    std::fs::create_dir_all(out_dir)?;
    let mut out = std::io::stdout().lock();
    for path in std::fs::read_to_string(list)?.lines().filter(|l| !l.is_empty()) {
        let data = std::fs::read(path)?;
        let name = Path::new(path)
            .file_name()
            .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned());
        let clean = midstudy_media::jpeg::is_clean(&data);
        match midstudy_media::jpeg::strip(&data) {
            Ok(s) => {
                std::fs::write(out_dir.join(&name), &s.bytes)?;
                writeln!(out, "{name}\tok\t{}\t{clean}", s.bytes.len())?;
            }
            Err(e) => {
                let debug = format!("{e:?}");
                let kind = debug.split([' ', '{']).next().unwrap_or(&debug);
                writeln!(out, "{name}\terr\t{kind}\t{clean}")?;
            }
        }
    }
    Ok(())
}
