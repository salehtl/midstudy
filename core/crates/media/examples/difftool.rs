//! The Rust side of `tests/diff_v1.py` (the differential test against v1's Python): reads cases from stdin, one per
//! line, `<op>\t<arg>[\t<arg>…]`, each argument hex-encoded bytes (or `@<path>` for a file), and prints one JSON
//! object per case. Byte outputs are hex too, or written to `<out-dir>/<case>.bin` when `out-dir` is given and the
//! output is large. Only for tests: it reads files and stdin, which the library never does.
//!
//! `cargo run --release --example difftool -p midstudy-media -- [out-dir]`

use std::fmt::Write as _;
use std::io::{BufRead, Write as _};

use midstudy_media::{base64, datauri, glb, http, jpeg, meta, path, png, slug, sniff, zip};

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            s.get(i..i.checked_add(2)?)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len().saturating_mul(2));
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn arg(a: &str) -> Result<Vec<u8>, String> {
    match a.strip_prefix('@') {
        Some(p) => std::fs::read(p).map_err(|e| format!("{p}: {e}")),
        None => unhex(a).ok_or_else(|| format!("bad hex: {a}")),
    }
}

fn text(a: &[u8]) -> Result<String, String> {
    String::from_utf8(a.to_vec()).map_err(|e| e.to_string())
}

/// Writes `bytes` as a JSON field value: inline hex, or a file for large outputs.
fn bytes_field(out_dir: Option<&str>, case: usize, bytes: &[u8]) -> Result<String, String> {
    match out_dir {
        Some(dir) if bytes.len() > 4096 => {
            let p = format!("{dir}/{case}.bin");
            std::fs::write(&p, bytes).map_err(|e| format!("{p}: {e}"))?;
            Ok(format!(r#""file":"{p}""#))
        }
        _ => Ok(format!(r#""hex":"{}""#, hex(bytes))),
    }
}

fn glb_kind(k: glb::ImageKind) -> &'static str {
    match k {
        glb::ImageKind::Jpeg => "jpeg",
        glb::ImageKind::Png => "png",
        glb::ImageKind::Other => "other",
        glb::ImageKind::External => "external",
    }
}

fn glb_error_name(e: &glb::GlbError) -> &'static str {
    match e {
        glb::GlbError::NotGlb => "NotGlb",
        glb::GlbError::Version(_) => "Version",
        glb::GlbError::Length { .. } => "Length",
        glb::GlbError::ChunkTruncated { .. } => "ChunkTruncated",
        glb::GlbError::FirstChunkNotJson => "FirstChunkNotJson",
        glb::GlbError::DuplicateChunk { .. } => "DuplicateChunk",
        glb::GlbError::Json(_) => "Json",
        glb::GlbError::NotObject => "NotObject",
        glb::GlbError::NotGltf2 => "NotGltf2",
        glb::GlbError::Field { .. } => "Field",
        glb::GlbError::BinMissing => "BinMissing",
        glb::GlbError::BinShort { .. } => "BinShort",
        glb::GlbError::ImageOutsideBin { .. } => "ImageOutsideBin",
        glb::GlbError::ImageSource { .. } => "ImageSource",
        glb::GlbError::BadImage { .. } => "BadImage",
        glb::GlbError::Overlap { .. } => "Overlap",
        glb::GlbError::TooLarge => "TooLarge",
    }
}

#[allow(clippy::too_many_lines)]
fn run(op: &str, args: &[Vec<u8>], out_dir: Option<&str>, case: usize) -> Result<String, String> {
    let first = args.first().ok_or("no argument")?;
    Ok(match op {
        "sniff" => format!(r#"{{"kind":"{}"}}"#, sniff::sniff(first).name()),
        "jpeg-strip" => match jpeg::strip(first) {
            Ok(s) => {
                let r = s.removed;
                format!(
                    r#"{{"ok":true,{},"removed":[{},{},{},{},{},{}]}}"#,
                    bytes_field(out_dir, case, &s.bytes)?,
                    r.app_segments,
                    r.app0_segments,
                    r.jfif_trimmed,
                    r.comments,
                    r.fill_bytes,
                    r.trailing_bytes
                )
            }
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "jpeg-size" => match jpeg::frame_info(first) {
            Ok(f) => format!(
                r#"{{"ok":true,"w":{},"h":{},"c":{}}}"#,
                f.width, f.height, f.components
            ),
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "jpeg-clean" => format!(r#"{{"clean":{}}}"#, jpeg::is_clean(first)),
        "jpeg-pass" => match jpeg::passthrough(first) {
            Ok(_) => r#"{"ok":true}"#.to_owned(),
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "png-strip" => match png::strip(first) {
            Ok(s) => {
                let r = s.removed;
                format!(
                    r#"{{"ok":true,{},"removed":[{},{},{},{}]}}"#,
                    bytes_field(out_dir, case, &s.bytes)?,
                    r.exif,
                    r.text,
                    r.time,
                    r.trailing_bytes
                )
            }
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "png-size" => match png::size(first) {
            Some((w, h)) => format!(r#"{{"ok":true,"w":{w},"h":{h}}}"#),
            None => r#"{"ok":false}"#.to_owned(),
        },
        "glb-inplace" | "glb-compact" => {
            let layout = if op == "glb-inplace" {
                glb::Layout::InPlace
            } else {
                glb::Layout::Compact
            };
            match glb::strip(first, layout) {
                Ok(s) => {
                    let images: Vec<String> = s
                        .report
                        .images
                        .iter()
                        .map(|i| {
                            let source: i64 = match i.source {
                                glb::ImageSource::BufferView(v) => {
                                    i64::try_from(v).unwrap_or(i64::MAX)
                                }
                                glb::ImageSource::DataUri => -1,
                                glb::ImageSource::Uri => -2,
                            };
                            format!(
                                r#"[{},"{}",{},{},{},{source}]"#,
                                i.image,
                                glb_kind(i.kind),
                                i.bytes_before,
                                i.bytes_after,
                                i.changed
                            )
                        })
                        .collect();
                    format!(
                        r#"{{"ok":true,{},"layout":"{:?}","images":[{}],"changed":{}}}"#,
                        bytes_field(out_dir, case, &s.bytes)?,
                        s.report.layout,
                        images.join(","),
                        s.report.changed
                    )
                }
                Err(e) => format!(
                    r#"{{"ok":false,"error":"{}","message":"{}"}}"#,
                    glb_error_name(&e),
                    hex(e.to_string().as_bytes())
                ),
            }
        }
        "normalize" => match path::normalize(&text(first)?) {
            Ok(p) => format!(r#"{{"ok":true,"path":"{}"}}"#, hex(p.as_bytes())),
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "route" => {
            let r = match path::static_route(&text(first)?) {
                path::Route::RedirectToPlanner => "redirect".to_owned(),
                path::Route::Planner {
                    rel,
                    trailing_slash,
                } => format!("planner:{rel}:{trailing_slash}"),
                path::Route::LibraryJson => "library-json".to_owned(),
                path::Route::Library { id, file } => format!("library:{id}/{}", file.name()),
                path::Route::Scene { name, file } => format!("scene:{name}/{}", file.name()),
                path::Route::Render { file } => format!("render:{file}"),
                path::Route::NotFound => "not-found".to_owned(),
            };
            format!(r#"{{"route":"{}"}}"#, hex(r.as_bytes()))
        }
        "host" => match http::host_name(&text(first)?) {
            Some(n) => format!(r#"{{"name":"{}"}}"#, hex(n.as_bytes())),
            None => r#"{"name":null}"#.to_owned(),
        },
        "clen" => match http::content_length(&[&text(first)?]) {
            Ok(n) => format!(r#"{{"ok":true,"n":{}}}"#, n.unwrap_or(0)),
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "origin" => {
            let opt = |i: usize| -> Result<Option<String>, String> {
                match args.get(i).map(Vec::as_slice) {
                    Some([0xFF]) | None => Ok(None),
                    Some(b) => text(b).map(Some),
                }
            };
            let (x, o, h) = (opt(0)?, opt(1)?, opt(2)?);
            format!(
                r#"{{"ok":{}}}"#,
                http::origin_ok(x.as_deref(), o.as_deref(), h.as_deref())
            )
        }
        "slug" => format!(r#"{{"slug":{}}}"#, slug::is_slug(&text(first)?)),
        "order" => {
            let name = text(first)?;
            let o = slug::name_order(&name);
            format!(
                r#"{{"base":"{}","number":"{}"}}"#,
                hex(o.base.as_bytes()),
                o.number
            )
        }
        "b64-strict" | "b64-lenient" => match base64::decode_python(first, op == "b64-strict") {
            Ok(b) => format!(r#"{{"ok":true,"hex":"{}"}}"#, hex(&b)),
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "meta" => match meta::decode(&text(first)?, meta::MAX_HEADER_LEN) {
            Ok(t) => format!(r#"{{"ok":true,"hex":"{}"}}"#, hex(t.as_bytes())),
            Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
        },
        "datauri-jpeg" | "datauri-png" => {
            let kind = if op == "datauri-png" {
                datauri::ImageType::Png
            } else {
                datauri::ImageType::Jpeg
            };
            match datauri::decode_image(&text(first)?, kind) {
                Ok(b) => format!(r#"{{"ok":true,"hex":"{}"}}"#, hex(&b)),
                Err(e) => format!(r#"{{"ok":false,"error":"{e:?}"}}"#),
            }
        }
        "cp437" => format!(
            r#"{{"text":"{}"}}"#,
            hex(zip::decode_cp437(first).as_bytes())
        ),
        "zip" => {
            // args: per entry, a hex name; the entry's flags, size and attributes ride in a second arg list,
            // `flags:size:attr` per entry, comma-separated.
            let meta_arg = text(args.get(1).ok_or("no entry fields")?)?;
            let fields: Vec<&str> = if meta_arg.is_empty() {
                Vec::new()
            } else {
                meta_arg.split(',').collect()
            };
            let names: Vec<Vec<u8>> = if first.is_empty() {
                Vec::new()
            } else {
                text(first)?
                    .split(',')
                    .map(|h| h.strip_prefix('n').and_then(unhex).ok_or("bad name hex"))
                    .collect::<Result<_, _>>()?
            };
            let mut entries = Vec::new();
            for (name, f) in names.iter().zip(&fields) {
                let mut parts = f.split(':').map(str::parse::<u64>);
                let (Some(Ok(flags)), Some(Ok(size)), Some(Ok(attr))) =
                    (parts.next(), parts.next(), parts.next())
                else {
                    return Err(format!("bad entry fields {f}"));
                };
                let external_attr = u32::try_from(attr).map_err(|e| e.to_string())?;
                entries.push(zip::Entry {
                    name,
                    utf8: flags & 0x800 != 0,
                    size,
                    external_attr,
                });
            }
            match zip::plan(&entries) {
                Ok(p) => format!(
                    r#"{{"ok":true,"extract":{:?},"skip":{:?}}}"#,
                    p.extract, p.skip
                ),
                Err(e) => format!(
                    r#"{{"ok":false,"message":"{}"}}"#,
                    hex(e.to_string().as_bytes())
                ),
            }
        }
        _ => return Err(format!("unknown op {op}")),
    })
}

fn main() -> Result<(), String> {
    let out_dir = std::env::args().nth(1);
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    for (case, line) in stdin.lock().lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        let mut parts = line.split('\t');
        let op = parts.next().unwrap_or_default().to_owned();
        let args: Vec<Vec<u8>> = parts.map(arg).collect::<Result<_, _>>()?;
        let result = run(&op, &args, out_dir.as_deref(), case)?;
        writeln!(stdout, "{result}").map_err(|e| e.to_string())?;
    }
    stdout.flush().map_err(|e| e.to_string())
}
