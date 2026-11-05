//! Bounded exhaustive tests: every parser on **every** input up to a small bound, where Kani (src/proofs.rs) can't
//! finish (the string-heavy parsers: CBMC's models of `String` and `Vec` growth time out beyond 2–4 bytes). Each input
//! is checked for no panic and for the properties stated with it. Two kinds of bound: every byte string of up to 2
//! bytes (65,793 inputs) through every parser, and every string of up to 4 or 5 characters over an alphabet of the
//! characters each parser treats specially. Under Miri only the 1-byte inputs run (each case is interpreted).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use midstudy_media::{base64, datauri, glb, http, jpeg, meta, path, png, slug, sniff, zip};

/// Every byte string of length 0 to `max`.
fn all_bytes(max: usize) -> impl Iterator<Item = Vec<u8>> {
    (0..=max).flat_map(|len| {
        let count = 1usize << (8 * len);
        (0..count).map(move |n: usize| n.to_le_bytes()[..len].to_vec())
    })
}

/// Every string of length 0 to `max` over `alphabet` (strings, not bytes: multi-byte characters stay whole).
fn all_strings(alphabet: &[&str], max: usize) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut level = vec![String::new()];
    for _ in 0..max {
        level = level
            .iter()
            .flat_map(|s| alphabet.iter().map(move |c| format!("{s}{c}")))
            .collect();
        out.extend(level.iter().cloned());
    }
    out
}

const SHORT: usize = if cfg!(miri) { 1 } else { 2 };

/// Every byte string of up to 2 bytes through every byte parser: no panic, and the invariants of each.
#[test]
fn every_short_byte_string() {
    for data in all_bytes(SHORT) {
        let d = data.as_slice();
        let kind = sniff::sniff(d);
        assert_eq!(
            kind == sniff::Kind::Jpeg,
            d.starts_with(&[0xFF, 0xD8, 0xFF])
        );
        assert!(jpeg::strip(d).is_err() && jpeg::strip_plan(d).is_err() && !jpeg::is_clean(d));
        assert!(jpeg::frame_info(d).is_err() && jpeg::passthrough(d).is_err());
        assert!(png::strip(d).is_err() && png::size(d).is_none());
        assert!(glb::strip(d, glb::Layout::Compact).is_err());
        let strict = base64::decode_python(d, true);
        if let Ok(s) = &strict {
            assert_eq!(base64::decode_python(d, false).as_ref(), Ok(s));
        }
        let _ = base64::decode_forgiving(d);
        let entry = zip::Entry {
            name: d,
            utf8: d.first().is_some_and(|b| b & 1 == 1),
            size: 1,
            external_attr: 0,
        };
        let _ = zip::decide(&entry);
        let _ = zip::plan(&[entry]);
        if let Ok(text) = std::str::from_utf8(d) {
            every_string_parser(text);
        }
    }
}

/// The string parsers on one string: no panic, and their invariants.
fn every_string_parser(text: &str) {
    if let Ok(clean) = path::normalize(text) {
        assert!(clean.starts_with('/') && !clean.split('/').any(|s| s == "." || s == ".."));
        assert_eq!(path::resolve(&clean), clean);
    }
    let route = path::static_route(text);
    if !matches!(
        route,
        path::Route::NotFound | path::Route::RedirectToPlanner
    ) {
        let clean =
            path::normalize(path::reduce_leading_slashes(text)).expect("a routed path normalizes");
        assert!(!clean.split('/').any(|s| s.starts_with('.')));
    }
    if let Some(name) = http::host_name(text) {
        assert!(
            !name.is_empty() && name.is_ascii() && !name.bytes().any(|b| b.is_ascii_uppercase())
        );
        assert!(name.starts_with('[') || !name.contains(':'));
    }
    let _ = http::check_host(&[text], &["homeserver"]);
    if let Ok(Some(n)) = http::content_length(&[text]) {
        assert!(n < 1_000_000_000_000_000);
    }
    let _ = http::origin_ok(Some(text), Some(text), Some(text));
    if slug::is_slug(text) {
        assert!(!text.is_empty() && text.is_ascii() && !text.contains(['/', '.', '\\']));
    }
    if slug::is_scene_name(text) {
        assert!(slug::is_slug(text));
    }
    let _ = slug::is_render_name(text);
    assert_eq!(slug::cmp_names(text, text), core::cmp::Ordering::Equal);
    if let Ok(json) = meta::decode(text, meta::MAX_HEADER_LEN) {
        assert_eq!(
            base64::decode_python(text.as_bytes(), true).ok(),
            Some(json.into_bytes())
        );
    }
    for kind in [datauri::ImageType::Jpeg, datauri::ImageType::Png] {
        if datauri::decode_image(text, kind).is_ok() {
            assert!(text.starts_with("data:image/"));
        }
    }
    let _ = datauri::parse(text);
}

/// Every path of up to 4 pieces over the characters normalisation and routing treat specially (or 5 for the shortest
/// ones), through normalize, resolve and the static route.
#[test]
fn every_short_path() {
    let alphabet = [
        "/", ".", "%", "2", "e", "E", "f", "5", "c", "0", "?", "#", "\\", "a", "é", ":", " ", "\0",
    ];
    for s in all_strings(&alphabet, if cfg!(miri) { 1 } else { 4 }) {
        every_string_parser(&s);
    }
    for s in all_strings(
        &["/", ".", "%2e", "%2f", "x"],
        if cfg!(miri) { 1 } else { 6 },
    ) {
        let clean = path::normalize(&s).expect("no NUL or backslash here");
        assert!(clean.starts_with('/') && !clean.split('/').any(|seg| seg == ".." || seg == "."));
    }
}

/// Every host value of up to 5 pieces over the characters the Host rule treats specially.
#[test]
fn every_short_host() {
    let alphabet = [
        "[", "]", ":", "1", "a", "A", ".", "-", "@", " ", "\u{a0}", "/", "é", "f",
    ];
    for s in all_strings(&alphabet, if cfg!(miri) { 1 } else { 5 }) {
        every_string_parser(&s);
        if http::check_host(&[s.as_str()], &[]) == http::HostDecision::Allowed {
            assert!(http::LOOPBACK.contains(&http::host_name(&s).unwrap().as_str()));
        }
    }
}

/// Every base64 text of up to 5 characters over the characters the three dialects treat differently.
#[test]
fn every_short_base64() {
    let alphabet = [
        "Q", "U", "J", "w", "+", "/", "=", " ", "\n", "-", "_", "é", "A",
    ];
    for s in all_strings(&alphabet, if cfg!(miri) { 1 } else { 5 }) {
        let b = s.as_bytes();
        let strict = base64::decode_python(b, true);
        if let Ok(v) = &strict {
            assert_eq!(base64::decode_python(b, false).as_ref(), Ok(v));
            assert_eq!(
                base64::decode_python(base64::encode(v).as_bytes(), true).as_ref(),
                Ok(v)
            );
        }
        if let Some(v) = base64::decode_forgiving(b) {
            assert_eq!(
                base64::decode_forgiving(base64::encode(&v).as_bytes()),
                Some(v)
            );
        }
        let _ = meta::decode(&s, meta::MAX_HEADER_LEN);
        let _ = datauri::decode_image(
            &format!("data:image/png;base64,{s}"),
            datauri::ImageType::Png,
        );
        let _ = datauri::parse(&format!("data:;base64,{s}"));
    }
}

/// Every zip entry name of up to 5 pieces over the characters the entry rules treat specially, in both encodings and
/// with a file, a directory and a link mode: an extracted entry is relative, doesn't climb and isn't a link.
#[test]
fn every_short_zip_name() {
    let alphabet = [
        "/",
        "\\",
        ".",
        "..",
        "a",
        "o",
        "obj",
        ".obj",
        ".png",
        ":",
        "\0",
        "é",
        "__MACOSX/",
    ];
    for s in all_strings(&alphabet, if cfg!(miri) { 1 } else { 5 }) {
        for (utf8, attr) in [
            (true, 0o100_644_u32 << 16),
            (false, 0o040_755 << 16),
            (true, 0o120_777 << 16),
        ] {
            let entry = zip::Entry {
                name: s.as_bytes(),
                utf8,
                size: 3,
                external_attr: attr,
            };
            if let Ok(zip::Action::Extract { .. }) = zip::decide(&entry) {
                assert!(
                    !s.starts_with('/')
                        && !s.contains(['\\', '\0'])
                        && !s.split('/').any(|p| p == "..")
                );
                assert_ne!(attr >> 16 & 0o170_000, 0o120_000);
            }
        }
    }
}

/// A GLB around `json` (padded) with an empty binary chunk.
fn glb_of(json: &str) -> Vec<u8> {
    let mut j = json.as_bytes().to_vec();
    j.resize(j.len().next_multiple_of(4), b' ');
    let total = u32::try_from(12 + 8 + j.len() + 8).unwrap();
    let mut out = b"glTF".to_vec();
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&total.to_le_bytes());
    out.extend_from_slice(&u32::try_from(j.len()).unwrap().to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&j);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out
}

/// The glTF JSON reader, through `glb::strip`: every text of up to 4 characters over JSON's own characters, and every
/// sequence of up to 3 glTF fragments; both layouts accept and refuse alike, and an accepted GLB rewrites to itself.
#[test]
fn every_short_gltf_json() {
    let json_chars = [
        "{", "}", "[", "]", "\"", ":", ",", "0", "-", "1", "e", ".", "n", "\\", "u", " ",
    ];
    let fragments = [
        "{\"asset\":{\"version\":\"2.0\"}",
        ",\"images\":[",
        "{\"bufferView\":0}",
        "{\"uri\":\"data:image/png;base64,\"}",
        ",\"bufferViews\":[{\"buffer\":0,\"byteLength\":0}]",
        ",\"buffers\":[{\"byteLength\":0}]",
        "]",
        "}",
        ",",
    ];
    let texts = all_strings(&json_chars, if cfg!(miri) { 1 } else { 4 })
        .into_iter()
        .chain(all_strings(&fragments, if cfg!(miri) { 1 } else { 3 }));
    for text in texts {
        let file = glb_of(&text);
        let compact = glb::strip(&file, glb::Layout::Compact);
        let in_place = glb::strip(&file, glb::Layout::InPlace);
        assert_eq!(compact.is_ok(), in_place.is_ok(), "{text:?}");
        if let Ok(c) = compact {
            let again = glb::strip(&c.bytes, glb::Layout::Compact).unwrap();
            assert!(!again.report.changed, "{text:?}");
        }
    }
}

/// Every JPEG of up to 5 tokens after SOI, over its structural pieces (markers with and without lengths, fill bytes,
/// stuffed bytes, segments of every kind including a short and a full JFIF header, a frame header, scan data):
/// strip, its plan, `is_clean`, `frame_info` and pass-through on each, and the invariants that tie them together.
#[test]
fn every_short_jpeg() {
    let tokens: [&[u8]; 14] = [
        &[0xFF, 0xD9],
        &[0xFF, 0xDA, 0x00, 0x02],
        &[0xFF, 0xE1, 0x00, 0x03, 0x47],
        &[
            0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        ],
        &[
            0xFF, 0xE0, 0x00, 0x11, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 9,
        ],
        &[0xFF, 0xFE, 0x00, 0x02],
        &[0xFF, 0xC0, 0x00, 0x0B, 8, 0, 2, 0, 3, 1, 1, 0x11, 0],
        &[0xFF, 0xDB, 0x00, 0x03, 0x00],
        &[0xFF, 0xD0],
        &[0xFF, 0x01],
        &[0xFF],
        &[0xFF, 0x00],
        &[0x12],
        &[0xFF, 0xD8],
    ];
    let mut seqs: Vec<Vec<u8>> = vec![vec![0xFF, 0xD8]];
    let mut level = seqs.clone();
    for _ in 0..if cfg!(miri) { 1 } else { 5 } {
        level = level
            .iter()
            .flat_map(|s| tokens.iter().map(move |t| [s.as_slice(), t].concat()))
            .collect();
        seqs.extend(level.iter().cloned());
    }
    for d in &seqs {
        let stripped = jpeg::strip(d);
        let plan = jpeg::strip_plan(d);
        assert_eq!(stripped.as_ref().err(), plan.as_ref().err());
        if let (Ok(s), Ok((p, removed))) = (&stripped, &plan) {
            assert_eq!(*removed, s.removed);
            assert_eq!(p.apply(d), s.bytes);
            assert_eq!(p.is_identity(d), !s.removed.any());
            assert_eq!(s.removed.any(), s.bytes != *d);
            assert!(jpeg::is_clean(&s.bytes));
            assert_eq!(jpeg::strip(&s.bytes).unwrap().bytes, s.bytes);
        }
        let nothing = stripped.is_ok_and(|s| {
            jpeg::Removed {
                fill_bytes: 0,
                ..s.removed
            } == jpeg::Removed::default()
        });
        assert_eq!(jpeg::is_clean(d), nothing);
        if let Ok(f) = jpeg::passthrough(d) {
            assert_eq!(jpeg::frame_info(d), Ok(f));
        }
        if let Ok(f) = jpeg::frame_info(d) {
            assert!(f.width > 0 && f.height > 0);
        }
    }
}

/// Every PNG of up to 4 chunks after the signature, over the chunk kinds the strip treats differently (and a
/// truncated chunk, trailing bytes): the strip, its plan and the IHDR size.
#[test]
fn every_short_png() {
    fn chunk(kind: [u8; 4], body: &[u8]) -> Vec<u8> {
        let mut c = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
        c.extend_from_slice(&kind);
        c.extend_from_slice(body);
        c.extend_from_slice(&[0, 0, 0, 0]);
        c
    }
    let tokens = [
        chunk(*b"IHDR", &[0, 0, 0, 2, 0, 0, 0, 3, 8, 0, 0, 0, 0]),
        chunk(*b"IHDR", &[]),
        chunk(*b"eXIf", b"MM"),
        chunk(*b"tEXt", b"a\0b"),
        chunk(*b"iTXt", b""),
        chunk(*b"zTXt", b"z"),
        chunk(*b"tIME", &[0; 7]),
        chunk(*b"IDAT", &[1, 2]),
        chunk(*b"IEND", &[]),
        vec![0, 0, 0, 9, b'I', b'D'],
        b"after".to_vec(),
    ];
    let mut seqs: Vec<Vec<u8>> = vec![png::SIGNATURE.to_vec()];
    let mut level = seqs.clone();
    for _ in 0..if cfg!(miri) { 1 } else { 4 } {
        level = level
            .iter()
            .flat_map(|s| tokens.iter().map(move |t| [s.as_slice(), t].concat()))
            .collect();
        seqs.extend(level.iter().cloned());
    }
    for d in &seqs {
        let stripped = png::strip(d);
        if let Ok(s) = &stripped {
            let (p, removed) = png::strip_plan(d).unwrap();
            assert_eq!(removed, s.removed);
            assert_eq!(p.apply(d), s.bytes);
            assert_eq!(s.removed.any(), s.bytes != *d);
            assert_eq!(png::strip(&s.bytes).unwrap().bytes, s.bytes);
        } else {
            assert!(png::strip_plan(d).is_err());
        }
        let _ = png::size(d);
    }
}
