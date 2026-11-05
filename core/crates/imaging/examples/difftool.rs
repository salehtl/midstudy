//! The native side of `tests/diff_pillow.py` (the differential test against v1's Pillow): reads a job file of
//! commands, one per line, and writes each result next to it.
//!
//! ```text
//! decode IN OUT          OUT = "w h mode\n" + pixels
//! encode IN W H Q OUT    IN = raw RGB
//! engine IN OUT          OUT = the engine input (jpg or png)
//! thumb IN OUT
//! rug IN W_CM D_CM OUT   OUT = texture JPEG; OUT.json = crop, turned, have, want, edge
//! mask IN OUT            OUT = mask PNG; OUT.json = kind, share
//! ```
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::print_stdout
)]

use std::fs;

use midstudy_imaging::formats::read;
use midstudy_imaging::image::Mode;
use midstudy_imaging::jpeg::encode::encode_rgb;
use midstudy_imaging::ops::{MaskKind, engine_input, foreground_mask, rug_texture, thumb};

fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::One => "1",
        Mode::L => "L",
        Mode::La => "LA",
        Mode::P => "P",
        Mode::Rgb => "RGB",
        Mode::Rgba => "RGBA",
        Mode::Cmyk => "CMYK",
        Mode::I16 => "I;16",
    }
}

fn main() {
    let job = std::env::args().nth(1).expect("usage: difftool JOBFILE");
    let text = fs::read_to_string(&job).expect("job file");
    let mut failed = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let a: Vec<&str> = line.split('\t').collect();
        let run = || -> Result<(), String> {
            match a[0] {
                "decode" => {
                    let im = read(&fs::read(a[1]).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("{e:?}"))?;
                    let mut out =
                        format!("{} {} {}\n", im.width, im.height, mode_name(im.mode)).into_bytes();
                    out.extend_from_slice(&im.data);
                    fs::write(a[2], out).map_err(|e| e.to_string())
                }
                "encode" => {
                    let raw = fs::read(a[1]).map_err(|e| e.to_string())?;
                    let (w, h, q): (usize, usize, u8) = (
                        a[2].parse().unwrap(),
                        a[3].parse().unwrap(),
                        a[4].parse().unwrap(),
                    );
                    fs::write(a[5], encode_rgb(w, h, &raw, q, None)).map_err(|e| e.to_string())
                }
                "engine" => {
                    let im = read(&fs::read(a[1]).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("{e:?}"))?;
                    fs::write(a[2], engine_input(im, true).bytes).map_err(|e| e.to_string())
                }
                "thumb" => {
                    let im = read(&fs::read(a[1]).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("{e:?}"))?;
                    fs::write(a[2], thumb(im)).map_err(|e| e.to_string())
                }
                "rug" => {
                    let im = read(&fs::read(a[1]).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("{e:?}"))?;
                    let t = rug_texture(im, a[2].parse().unwrap(), a[3].parse().unwrap())
                        .map_err(|e| format!("{e:?}"))?;
                    fs::write(a[4], &t.jpeg).map_err(|e| e.to_string())?;
                    let crop = t.crop.map_or("null".to_string(), |b| {
                        format!("[{},{},{},{}]", b[0], b[1], b[2], b[3])
                    });
                    let json = format!(
                        "{{\"crop\":{crop},\"turned\":{},\"have\":{:?},\"want\":{:?},\"edge\":[{:?},{:?},{:?}]}}",
                        t.turned, t.have, t.want, t.edge[0], t.edge[1], t.edge[2]
                    );
                    fs::write(format!("{}.json", a[4]), json).map_err(|e| e.to_string())
                }
                "mask" => {
                    let im = read(&fs::read(a[1]).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("{e:?}"))?;
                    let (kind, share, png) = foreground_mask(im);
                    fs::write(a[2], png).map_err(|e| e.to_string())?;
                    let k = match kind {
                        MaskKind::NoMargin => "no-margin",
                        MaskKind::NoPiece => "no-piece",
                        MaskKind::Piece => "piece",
                    };
                    fs::write(
                        format!("{}.json", a[2]),
                        format!("{{\"kind\":\"{k}\",\"share\":{share:?}}}"),
                    )
                    .map_err(|e| e.to_string())
                }
                other => Err(format!("unknown command {other}")),
            }
        };
        if let Err(e) = run() {
            failed += 1;
            println!("ERROR {line}: {e}");
        }
    }
    println!("difftool: {failed} failed");
}
