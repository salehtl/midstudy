//! `midstudy-proofs-diff MODE LIST OUTDIR`: for each path in LIST, the Rust that a proved Lean model describes, printed
//! exactly as `lake exe mediastrip MODE` prints the model's result (proofs/StripMain.lean has the line formats):
//! `jpeg` (`midstudy_media::jpeg::strip`, `is_clean`), `png` (`png::strip`), `slug` (`slug::is_slug`), `frame`
//! (`jpeg::frame_info`), `b64` (`base64::decode_python` strict and lenient, `base64::encode`), `meta` (`meta::decode`
//! with the 16 KiB cap and with 64), `sniff` (`sniff::sniff`, `Kind::photo_ext`, wasm-node's `api::sniff`) and `wire`
//! (wasm-node's `wire::Reader` read as `api.rs` `zip_plan` reads it, and whether `api::zip_plan` answers `bad-input`).
//!
//! wasm-node's `wire.rs` and `api.rs` are compiled here from their own source files (`#[path]`), so the harness runs
//! that code natively without wasm-bindgen; nothing is copied.
use std::fmt::Write as _;
use std::io::Write;
use std::path::Path;

use midstudy_media::base64::{Base64Error, decode_python, encode};
use midstudy_media::meta::{MAX_HEADER_LEN, MetaError};

#[allow(dead_code, unused_imports, clippy::all, clippy::pedantic)]
#[path = "../../../core/crates/wasm-node/src/wire.rs"]
mod wire;

#[allow(dead_code, unused_imports, clippy::all, clippy::pedantic)]
#[path = "../../../core/crates/wasm-node/src/api.rs"]
mod api;

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn b64_err(e: Base64Error) -> String {
    match e {
        Base64Error::LeadingPadding => "LeadingPadding".to_owned(),
        Base64Error::ExcessPadding => "ExcessPadding".to_owned(),
        Base64Error::NotBase64 { at } => format!("NotBase64@{at}"),
        Base64Error::DiscontinuousPadding { at } => format!("DiscontinuousPadding@{at}"),
        Base64Error::DataAfterPadding => "DataAfterPadding".to_owned(),
        Base64Error::OneExtraCharacter => "OneExtraCharacter".to_owned(),
        Base64Error::IncorrectPadding => "IncorrectPadding".to_owned(),
    }
}

fn b64_res(r: Result<Vec<u8>, Base64Error>) -> String {
    match r {
        Ok(b) => format!("ok:{}", hex(&b)),
        Err(e) => format!("err:{}", b64_err(e)),
    }
}

fn meta_res(r: Result<String, MetaError>) -> String {
    match r {
        Ok(text) => format!("ok:{}", hex(text.as_bytes())),
        Err(MetaError::TooLong { len, max }) => format!("err:TooLong:{len}:{max}"),
        Err(MetaError::NotAscii) => "err:NotAscii".to_owned(),
        Err(MetaError::Base64(e)) => format!("err:Base64:{}", b64_err(e)),
        Err(MetaError::NotUtf8) => "err:NotUtf8".to_owned(),
    }
}

/// `zip_plan`'s input loop on wire.rs's `Reader` (the reads of api.rs `read_entry`), rendered as the Lean model's.
fn wire_entries(packed: &[u8]) -> Option<String> {
    let mut r = wire::Reader::new(packed);
    let mut out = String::new();
    let mut n = 0usize;
    while !r.done() {
        let name = r.bytes()?;
        let flags = r.u32()?;
        let low = r.u32()?;
        let high = r.u32()?;
        let attr = r.u32()?;
        let size = u64::from(low) | u64::from(high).wrapping_shl(32);
        let utf8 = u8::from(flags & 0x0800 != 0);
        let _ = write!(out, ";{},{flags},{low},{high},{attr},{utf8},{size}", hex(name));
        n += 1;
    }
    Some(format!("n={n}{out}"))
}

/// The result columns of the `b64`, `meta`, `sniff` and `wire` lines.
fn misc(mode: &str, data: &[u8]) -> (String, String) {
    match mode {
        "b64" => (
            format!(
                "{}|{}|{}",
                b64_res(decode_python(data, true)),
                b64_res(decode_python(data, false)),
                encode(data)
            ),
            "-".to_owned(),
        ),
        "meta" => match std::str::from_utf8(data) {
            Ok(header) => (
                format!(
                    "{}|{}",
                    meta_res(midstudy_media::meta::decode(header, MAX_HEADER_LEN)),
                    meta_res(midstudy_media::meta::decode(header, 64))
                ),
                "-".to_owned(),
            ),
            Err(_) => ("not-utf8-input".to_owned(), "-".to_owned()),
        },
        "sniff" => {
            let k = midstudy_media::sniff::sniff(data);
            (
                format!("{},{},{}", k.name(), k.photo_ext().unwrap_or("-"), api::sniff(data)),
                "-".to_owned(),
            )
        }
        _ => {
            // api::zip_plan's envelope: 01, offset (u32), code length (u8), code, message
            let env = api::zip_plan(data);
            let bad = env.first() == Some(&1)
                && env.get(5).is_some_and(|&n| env.get(6..6 + usize::from(n)) == Some(b"bad-input".as_slice()));
            (
                wire_entries(data).unwrap_or_else(|| "bad-input".to_owned()),
                if bad { "bad" } else { "ok" }.to_owned(),
            )
        }
    }
}

/// The variant's name of an error's `Debug` (`Truncated { at: 5 }` → `Truncated`).
fn kind(debug: &str) -> &str {
    debug.split([' ', '{']).next().unwrap_or(debug)
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, mode, list, out_dir] = args.as_slice() else {
        eprintln!("usage: midstudy-proofs-diff jpeg|png|slug|frame|b64|meta|sniff|wire LIST OUTDIR");
        std::process::exit(2);
    };
    let modes = ["jpeg", "png", "slug", "frame", "b64", "meta", "sniff", "wire"];
    if !modes.contains(&mode.as_str()) {
        eprintln!("mode must be one of {modes:?}");
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
        if ["b64", "meta", "sniff", "wire"].contains(&mode.as_str()) {
            let (res, last) = misc(mode, &data);
            writeln!(out, "{name}\tres\t{res}\t{last}")?;
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
