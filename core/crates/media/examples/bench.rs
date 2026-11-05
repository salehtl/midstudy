//! Times the strip kernels natively: `bench <op> <file> [runs]`, op `jpeg`, `png`, `glb` (compact) or `glb-in-place`.
//! Prints the median and the fastest of `runs` (default 15) runs after one warm-up, in milliseconds. The file is read
//! once, outside the timing (as the server holds the upload in memory). Only for docs/notes/k-media.md.
//!
//! `cargo run --release --example bench -p midstudy-media -- jpeg evals/out/media-diff/corpus/big12mp-gps.jpg`

use std::time::Instant;

use midstudy_media::{glb, jpeg, png};

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let op = args
        .next()
        .ok_or("usage: bench <jpeg|png|glb|glb-in-place> <file> [runs]")?;
    let file = args.next().ok_or("no file")?;
    let runs: usize = args
        .next()
        .map_or(Ok(15), |r| r.parse().map_err(|e| format!("{e}")))?;
    let data = std::fs::read(&file).map_err(|e| format!("{file}: {e}"))?;
    let run = || -> Result<usize, String> {
        match op.as_str() {
            "jpeg" => jpeg::strip(&data)
                .map(|s| s.bytes.len())
                .map_err(|e| e.to_string()),
            "png" => png::strip(&data)
                .map(|s| s.bytes.len())
                .map_err(|e| e.to_string()),
            "glb" => glb::strip(&data, glb::Layout::Compact)
                .map(|s| s.bytes.len())
                .map_err(|e| e.to_string()),
            "glb-in-place" => glb::strip(&data, glb::Layout::InPlace)
                .map(|s| s.bytes.len())
                .map_err(|e| e.to_string()),
            _ => Err(format!("unknown op {op}")),
        }
    };
    let out_len = run()?;
    let mut times: Vec<f64> = (0..runs.max(1))
        .map(|_| {
            let t = Instant::now();
            let n = run();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            std::hint::black_box(n).map(|_| ms)
        })
        .collect::<Result<_, _>>()?;
    times.sort_by(f64::total_cmp);
    let median = times.get(times.len() / 2).copied().unwrap_or_default();
    let best = times.first().copied().unwrap_or_default();
    println!(
        r#"{{"op":"{op}","file":"{file}","bytes":{},"out_bytes":{out_len},"runs":{},"median_ms":{median:.3},"best_ms":{best:.3}}}"#,
        data.len(),
        times.len()
    );
    Ok(())
}
