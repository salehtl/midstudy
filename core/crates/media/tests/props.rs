//! Property tests (proptest) for the media kernels: model-based generators for JPEG and PNG (the generator knows which
//! parts v1's rules keep, so the expected output is computed independently of the code under test), regex oracles for
//! the string rules, and "never panics" on arbitrary bytes and text for every public function.
#![allow(
    clippy::trivially_copy_pass_by_ref,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]

use midstudy_media::{base64, datauri, glb, http, jpeg, meta, path, png, slug, sniff, zip};
use proptest::prelude::*;
use regex::Regex;

// --- JPEG ------------------------------------------------------------------------------------------------------------

/// One part of a generated JPEG, with what `strip` must make of it.
#[derive(Clone, Debug)]
enum Part {
    /// APP0 JFIF with a thumbnail (`extra` bytes after the 16-byte header): kept as the plain 16-byte header.
    Jfif {
        head: [u8; 7],
        thumb: (u8, u8),
        extra: Vec<u8>,
    },
    /// APP0 that isn't a JFIF header of at least 16 bytes (JFXX, AVI1, a short JFIF): dropped.
    OtherApp0(Vec<u8>),
    /// APP1–APP15: dropped.
    App(u8, Vec<u8>),
    /// COM: dropped.
    Com(Vec<u8>),
    /// A coding segment (DQT, DHT, `SOFn`, DRI, `JPGn`, …): kept byte for byte.
    Table(u8, Vec<u8>),
    /// Fill bytes before the next marker: dropped.
    Fill(usize),
    /// RST0–7 or TEM: kept.
    Standalone(u8),
    /// SOS header and entropy-coded data (stuffed, with restart markers): kept byte for byte.
    Scan(Vec<u8>, Vec<u8>),
}

fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![0xFF, marker];
    v.extend_from_slice(&u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
    v.extend_from_slice(payload);
    v
}

impl Part {
    /// (the bytes in the file, the bytes `strip` must write)
    fn bytes(&self) -> (Vec<u8>, Vec<u8>) {
        match self {
            Part::Jfif { head, thumb, extra } => {
                let mut p = b"JFIF\0".to_vec();
                p.extend_from_slice(head);
                p.extend_from_slice(&[thumb.0, thumb.1]);
                p.extend_from_slice(extra);
                let mut kept = vec![0xFF, 0xE0, 0x00, 0x10];
                kept.extend_from_slice(&p[..12]);
                kept.extend_from_slice(&[0, 0]);
                (segment(0xE0, &p), kept)
            }
            Part::OtherApp0(p) => (segment(0xE0, p), Vec::new()),
            Part::App(n, p) => (segment(0xE0 + n, p), Vec::new()),
            Part::Com(p) => (segment(0xFE, p), Vec::new()),
            Part::Table(m, p) => (segment(*m, p), segment(*m, p)),
            Part::Fill(n) => (vec![0xFF; *n], Vec::new()),
            Part::Standalone(m) => (vec![0xFF, *m], vec![0xFF, *m]),
            Part::Scan(header, data) => {
                let mut v = segment(0xDA, header);
                v.extend_from_slice(data);
                (v.clone(), v)
            }
        }
    }
}

fn entropy() -> impl Strategy<Value = Vec<u8>> {
    // Random bytes with every FF stuffed, and restart markers here and there.
    prop::collection::vec(
        (any::<u8>(), prop::option::weighted(0.05, 0xD0u8..=0xD7)),
        0..200,
    )
    .prop_map(|v| {
        let mut out = Vec::new();
        for (b, rst) in v {
            out.push(b);
            if b == 0xFF {
                out.push(0x00);
            }
            if let Some(m) = rst {
                out.extend_from_slice(&[0xFF, m]);
            }
        }
        out
    })
}

fn other_app0() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        prop::collection::vec(any::<u8>(), 0..30)
            .prop_map(|t| [b"JFXX\0\x10".as_slice(), &t].concat()),
        prop::collection::vec(any::<u8>(), 0..9).prop_map(|t| [b"JFIF\0".as_slice(), &t].concat()),
        prop::collection::vec(any::<u8>(), 0..30).prop_map(|t| [b"AVI1\0".as_slice(), &t].concat()),
    ]
}

fn part() -> impl Strategy<Value = Part> {
    let payload = || prop::collection::vec(any::<u8>(), 0..64);
    let table = prop::sample::select(vec![
        0xC0u8, 0xC1, 0xC2, 0xC4, 0xC8, 0xCC, 0xDB, 0xDD, 0xF0, 0xFD, 0x02, 0xBF,
    ]);
    prop_oneof![
        (
            any::<[u8; 7]>(),
            any::<(u8, u8)>(),
            prop::collection::vec(any::<u8>(), 0..40)
        )
            .prop_map(|(head, thumb, extra)| Part::Jfif { head, thumb, extra }),
        other_app0().prop_map(Part::OtherApp0),
        (1u8..=15, payload()).prop_map(|(n, p)| Part::App(n, p)),
        payload().prop_map(Part::Com),
        (table, payload()).prop_map(|(m, p)| Part::Table(m, p)),
        (1usize..4).prop_map(Part::Fill),
        prop::sample::select(vec![0xD0u8, 0xD3, 0xD7, 0x01]).prop_map(Part::Standalone),
        (prop::collection::vec(any::<u8>(), 0..12), entropy()).prop_map(|(h, d)| Part::Scan(h, d)),
    ]
}

/// A generated JPEG, the output `strip` must produce, and the trailing bytes.
fn jpeg_model() -> impl Strategy<Value = (Vec<u8>, Vec<u8>)> {
    (
        prop::collection::vec(part(), 0..14),
        prop::collection::vec(any::<u8>(), 0..20),
    )
        .prop_map(|(parts, trailing)| {
            let mut file = vec![0xFF, 0xD8];
            let mut want = vec![0xFF, 0xD8];
            for p in &parts {
                let (f, w) = p.bytes();
                file.extend(f);
                want.extend(w);
            }
            file.extend_from_slice(&[0xFF, 0xD9]);
            want.extend_from_slice(&[0xFF, 0xD9]);
            file.extend(trailing);
            (file, want)
        })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]

    /// The model: strip keeps exactly the coding segments, scans (entropy-coded data included), RST/TEM and a plain
    /// JFIF header, in order, and drops everything else.
    #[test]
    fn jpeg_strip_matches_the_model((file, want) in jpeg_model()) {
        let s = jpeg::strip(&file).unwrap();
        prop_assert_eq!(&s.bytes, &want);
        // Idempotent, and what it writes is clean (no APPn≥1, COM, JFXX, thumbnail or byte after EOI anywhere).
        let again = jpeg::strip(&s.bytes).unwrap();
        prop_assert_eq!(&again.bytes, &s.bytes);
        prop_assert_eq!(again.removed, jpeg::Removed::default());
        prop_assert!(jpeg::is_clean(&s.bytes));
    }

    /// is_clean is exactly "strip removes nothing but fill bytes".
    #[test]
    fn jpeg_is_clean_iff_strip_removes_nothing((file, _) in jpeg_model()) {
        let nothing = jpeg::strip(&file).is_ok_and(|s| {
            jpeg::Removed { fill_bytes: 0, ..s.removed } == jpeg::Removed::default()
        });
        prop_assert_eq!(jpeg::is_clean(&file), nothing);
    }

    /// Arbitrary bytes after SOI: never a panic; when strip succeeds, its output is clean and strips to itself.
    #[test]
    fn jpeg_arbitrary(tail in prop::collection::vec(any::<u8>(), 0..400)) {
        let file = [&[0xFF, 0xD8][..], &tail].concat();
        if let Ok(s) = jpeg::strip(&file) {
            prop_assert!(jpeg::is_clean(&s.bytes));
            prop_assert_eq!(jpeg::strip(&s.bytes).unwrap().bytes, s.bytes);
        }
        if let Ok(f) = jpeg::frame_info(&file) {
            prop_assert!(f.width > 0 && f.height > 0);
        }
        let _ = jpeg::passthrough(&file);
        let _ = jpeg::strip(&tail);
    }

    /// Mutations of a model JPEG: never a panic, and a successful strip is still clean.
    #[test]
    fn jpeg_mutated((file, _) in jpeg_model(), at in any::<prop::sample::Index>(), byte in any::<u8>(), cut in any::<prop::sample::Index>()) {
        let mut m = file.clone();
        let i = at.index(m.len());
        m[i] = byte;
        m.truncate(cut.index(m.len() + 1).max(i));
        if let Ok(s) = jpeg::strip(&m) {
            prop_assert!(jpeg::is_clean(&s.bytes));
        }
        let _ = jpeg::frame_info(&m);
    }
}

// --- PNG -------------------------------------------------------------------------------------------------------------

fn png_chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
    v
}

fn png_model() -> impl Strategy<Value = (Vec<u8>, Vec<u8>)> {
    let kinds = prop::sample::select(vec![
        *b"eXIf", *b"tEXt", *b"iTXt", *b"zTXt", *b"tIME", *b"IDAT", *b"iCCP", *b"gAMA", *b"EXIF",
        *b"teXt", *b"abcd",
    ]);
    (
        prop::collection::vec((kinds, prop::collection::vec(any::<u8>(), 0..40)), 0..10),
        prop::collection::vec(any::<u8>(), 0..20),
    )
        .prop_map(|(chunks, trailing)| {
            let mut file = png::SIGNATURE.to_vec();
            let ihdr = png_chunk(b"IHDR", &[0, 0, 0, 7, 0, 0, 0, 5, 8, 2, 0, 0, 0]);
            file.extend_from_slice(&ihdr);
            let mut want = file.clone();
            for (kind, body) in &chunks {
                let c = png_chunk(kind, body);
                file.extend_from_slice(&c);
                if ![*b"eXIf", *b"tEXt", *b"iTXt", *b"zTXt", *b"tIME"].contains(kind) {
                    want.extend_from_slice(&c);
                }
            }
            let iend = png_chunk(b"IEND", &[]);
            file.extend_from_slice(&iend);
            want.extend_from_slice(&iend);
            file.extend(trailing);
            (file, want)
        })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]

    #[test]
    fn png_strip_matches_the_model((file, want) in png_model()) {
        let s = png::strip(&file).unwrap();
        prop_assert_eq!(&s.bytes, &want);
        prop_assert_eq!(png::strip(&s.bytes).unwrap().bytes, s.bytes.clone());
        prop_assert_eq!(png::size(&s.bytes), Some((7, 5)));
    }

    #[test]
    fn png_arbitrary(tail in prop::collection::vec(any::<u8>(), 0..300)) {
        let file = [&png::SIGNATURE[..], &tail].concat();
        if let Ok(s) = png::strip(&file) {
            prop_assert_eq!(png::strip(&s.bytes).unwrap().bytes, s.bytes);
        }
        let _ = png::size(&file);
        let _ = png::strip(&tail);
    }
}

// --- strings: paths, slugs, hosts, lengths, base64 ---------------------------------------------------------------------

fn path_text() -> impl Strategy<Value = String> {
    let pieces = vec![
        "/", "/", ".", "..", "%2e", "%2E", "%2f", "%25", "%3F", "%23", "%00", "%5c", "a",
        "planner", "library", "scenes", "renders", "x.jpg", "é", "%C3%A9", "%C3", "?", "#", "%",
        "%%", "~", "...",
    ];
    prop::collection::vec(prop::sample::select(pieces), 0..12).prop_map(|v| v.concat())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 4000, ..ProptestConfig::default() })]

    /// normalize's output starts with `/`, has no `.`, `..` or empty segment (but a final slash), is a fixed point of
    /// resolve, and normalizes to itself when it holds nothing a decoder or the query split would read again.
    #[test]
    fn normalize_is_canonical(raw in path_text()) {
        if let Ok(clean) = path::normalize(&raw) {
            prop_assert!(clean.starts_with('/'));
            let inner = clean.trim_start_matches('/').trim_end_matches('/');
            prop_assert!(inner.is_empty() || inner.split('/').all(|s| !s.is_empty() && s != "." && s != ".."), "{}", clean);
            prop_assert_eq!(path::resolve(&clean), clean.clone());
            if !clean.contains(['%', '?', '#']) {
                prop_assert_eq!(path::normalize(&clean), Ok(clean.clone()));
            }
            prop_assert_eq!(path::route(&clean), path::route(&path::resolve(&clean)));
        }
        let _ = path::static_route(&raw);
    }

    #[test]
    fn resolve_is_idempotent(raw in path_text()) {
        let once = path::resolve(&raw);
        prop_assert_eq!(path::resolve(&once), once);
    }

    /// The routes match v1's regexes (SCENE_ASSET, LIBRARY_ASSET) and never serve a dot segment.
    #[test]
    fn routes_match_the_regexes(raw in path_text(), id in "[a-z0-9][a-z0-9-]{0,3}|[A-Z_.-]{1,3}", file in "(photo|depth|thumb|model|splat|source)\\.(jpg|png|glb|ply|spz|JPG)") {
        let scene = Regex::new(r"\A([a-z0-9][a-z0-9-]{0,63})/(photo\.jpg|depth\.png|thumb\.jpg)\z").unwrap();
        let library = Regex::new(r"\A[a-z0-9][a-z0-9-]{0,63}/(model\.glb|splat\.ply|splat\.spz|thumb\.jpg)\z").unwrap();
        let rel = format!("{id}/{file}");
        let s = path::route(&format!("/scenes/{rel}"));
        prop_assert_eq!(matches!(s, path::Route::Scene { .. }), scene.is_match(&rel) && !id.starts_with('.'));
        let l = path::route(&format!("/library/{rel}"));
        prop_assert_eq!(matches!(l, path::Route::Library { .. }), library.is_match(&rel) && !id.starts_with('.'));
        if let Ok(clean) = path::normalize(&raw) {
            let served = !matches!(path::route(&clean), path::Route::NotFound);
            prop_assert!(!served || !clean.split('/').any(|s| s.starts_with('.')));
        }
    }

    /// is_slug is the regex `^[a-z0-9][a-z0-9-]{0,63}$` over the whole string (no trailing newline).
    #[test]
    fn slug_equals_the_regex(s in "[a-z0-9_A.\\n -]{0,70}|[a-z0-9][a-z0-9-]{0,66}") {
        let re = Regex::new(r"\A[a-z0-9][a-z0-9-]{0,63}\z").unwrap();
        prop_assert_eq!(slug::is_slug(&s), re.is_match(&s));
        let scene = Regex::new(r"\Ascene-[0-9]{8}-[0-9]{6}(-[0-9]+)?\z").unwrap();
        prop_assert_eq!(slug::is_scene_name(&s), scene.is_match(&s) && re.is_match(&s));
    }

    #[test]
    fn scene_names(n in "scene-[0-9]{8}-[0-9]{6}(-[0-9]{1,5})?x?") {
        let scene = Regex::new(r"\Ascene-[0-9]{8}-[0-9]{6}(-[0-9]+)?\z").unwrap();
        prop_assert_eq!(slug::is_scene_name(&n), scene.is_match(&n));
    }

    /// host_name is v1's HOST_RE on the stripped, lowercased value.
    #[test]
    fn host_name_equals_the_regex(s in "[ \t]?(\\[[0-9a-fA-F:.g]{0,6}\\]?|[a-zA-Z0-9._@/-]{0,12})(:[0-9]{0,7})?[a-z@]?[ \t]?") {
        let re = Regex::new(r"\A(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?\z").unwrap();
        let t = s.trim_matches([' ', '\t']).to_ascii_lowercase();
        let want = re.captures(&t).map(|c| c[1].to_owned());
        prop_assert_eq!(http::host_name(&s), want);
    }

    #[test]
    fn content_length_equals_the_regex(s in "[ \t]?[0-9+ -]{0,17}[ \t]?") {
        let re = Regex::new(r"\A[0-9]{1,15}\z").unwrap();
        let t = s.trim_matches([' ', '\t']);
        let want = re.is_match(t).then(|| t.parse::<u64>().unwrap());
        prop_assert_eq!(http::content_length(&[&s]).ok().flatten(), want);
    }

    #[test]
    fn base64_round_trips(data in prop::collection::vec(any::<u8>(), 0..200)) {
        let e = base64::encode(&data);
        prop_assert_eq!(base64::decode_python(e.as_bytes(), true).unwrap(), data.clone());
        prop_assert_eq!(base64::decode_python(e.as_bytes(), false).unwrap(), data.clone());
        prop_assert_eq!(base64::decode_forgiving(e.as_bytes()).unwrap(), data.clone());
        prop_assert_eq!(meta::decode(&e, usize::MAX).is_ok(), std::str::from_utf8(&data).is_ok());
    }

    /// Never a panic on arbitrary text or bytes, for every remaining public function.
    #[test]
    fn nothing_panics(text in ".{0,80}", bytes in prop::collection::vec(any::<u8>(), 0..120), flag in any::<bool>(), attr in any::<u32>(), size in any::<u64>()) {
        let _ = base64::decode_python(&bytes, flag);
        let _ = base64::decode_forgiving(&bytes);
        let _ = meta::decode(&text, 64);
        let _ = datauri::decode_image(&text, datauri::ImageType::Jpeg);
        let _ = datauri::parse(&text);
        let _ = http::host_name(&text);
        let _ = http::check_host(&[&text], &["homeserver"]);
        let _ = http::origin_ok(Some(&text), Some(&text), Some(&text));
        let _ = http::content_length(&[&text, &text]);
        let _ = slug::name_order(&text);
        let _ = slug::cmp_names(&text, "scene-20261104-201500-2");
        let _ = path::static_route(&text);
        let _ = sniff::sniff(&bytes);
        let _ = glb::strip(&bytes, if flag { glb::Layout::Compact } else { glb::Layout::InPlace });
        let glb_like = [b"glTF\x02\0\0\0".as_slice(), &u32::try_from(bytes.len() + 12).unwrap().to_le_bytes(), &bytes].concat();
        let _ = glb::strip(&glb_like, glb::Layout::Compact);
        let entry = zip::Entry { name: &bytes, utf8: flag, size, external_attr: attr };
        let _ = zip::decide(&entry);
        let _ = zip::plan(&[entry, entry]);
    }

    /// An extracted zip entry never has an absolute path, a `..` segment, a backslash or a disallowed extension.
    #[test]
    fn zip_extracts_only_safe_names(names in prop::collection::vec("[a-z./\\\\:_.]{0,10}(\\.(obj|mtl|png|jpg|jpeg|exe|OBJ))?/?", 1..6)) {
        let entries: Vec<zip::Entry<'_>> = names.iter().map(|n| zip::Entry { name: n.as_bytes(), utf8: true, size: 1, external_attr: 0o100_644 << 16 }).collect();
        if let Ok(plan) = zip::plan(&entries) {
            for &i in &plan.extract {
                let n = &names[i];
                prop_assert!(!n.starts_with('/') && !n.contains('\\') && !n.split('/').any(|s| s == ".."));
                prop_assert!(n.chars().nth(1) != Some(':'));
                let lower = n.to_ascii_lowercase();
                let last = lower.split('/').rfind(|s| !s.is_empty() && *s != ".").unwrap_or_default();
                prop_assert!(zip::ALLOWED.iter().any(|ext| last.ends_with(ext) && last.len() > ext.len()), "{}", n);
            }
        }
    }
}
