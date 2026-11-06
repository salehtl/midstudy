//! The media crate's other parsers on arbitrary input; the first byte picks one (seeds.py writes seeds for each):
//! 0 base64 (CPython strict and lenient, WHATWG forgiving) and X-Midstudy-Meta; 1 image data URIs and the WHATWG data
//! URL reader; 2 slugs, generated names and v1's name order; 3 one zip entry (byte 1: bit 0 UTF-8, the rest the name)
//! and a plan over entries split at newlines; 4 sniff. Each checks invariants, not only "no panic".
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_media::{base64, datauri, meta, slug, sniff, zip};
use std::cmp::Ordering;

fuzz_target!(|data: &[u8]| {
    let Some((&which, rest)) = data.split_first() else {
        return;
    };
    match which % 5 {
        0 => {
            let strict = base64::decode_python(rest, true);
            let lenient = base64::decode_python(rest, false);
            if let Ok(s) = &strict {
                assert_eq!(
                    lenient.as_ref(),
                    Ok(s),
                    "strict-valid base64 decodes the same leniently"
                );
                assert_eq!(
                    base64::decode_python(base64::encode(s).as_bytes(), true).as_ref(),
                    Ok(s)
                );
            }
            if let Some(f) = base64::decode_forgiving(rest) {
                assert_eq!(
                    base64::decode_forgiving(base64::encode(&f).as_bytes()),
                    Some(f)
                );
            }
            if let Ok(text) = std::str::from_utf8(rest)
                && let Ok(json) = meta::decode(text, meta::MAX_HEADER_LEN)
            {
                assert!(text.is_ascii() && text.len() <= meta::MAX_HEADER_LEN);
                assert_eq!(
                    strict.ok().map(String::from_utf8).and_then(Result::ok),
                    Some(json)
                );
            }
        }
        1 => {
            let Ok(text) = std::str::from_utf8(rest) else {
                return;
            };
            for kind in [datauri::ImageType::Jpeg, datauri::ImageType::Png] {
                if datauri::decode_image(text, kind).is_ok() {
                    assert!(text.starts_with("data:image/"));
                }
            }
            if let Some(d) = datauri::parse(text) {
                let again = datauri::parse(&datauri::encode(&d.mime, &d.body))
                    .expect("an encoded data URL parses");
                assert_eq!(again.body, d.body);
                assert!(again.base64);
            }
        }
        2 => {
            let Ok(text) = std::str::from_utf8(rest) else {
                return;
            };
            if slug::is_slug(text) {
                assert!(!text.is_empty() && text.len() <= slug::MAX_SLUG_LEN && text.is_ascii());
                assert!(!text.contains(['/', '\\', '.', '\0', '\n', ' ']));
            }
            if slug::is_scene_name(text) {
                assert!(slug::is_slug(text));
            }
            let (a, b) = text.split_at(
                text.char_indices()
                    .map(|(i, _)| i)
                    .nth(text.chars().count() / 2)
                    .unwrap_or(0),
            );
            assert_eq!(slug::cmp_names(a, a), Ordering::Equal);
            assert_eq!(slug::cmp_names(a, b), slug::cmp_names(b, a).reverse());
        }
        3 => {
            let Some((&flags, name)) = rest.split_first() else {
                return;
            };
            let entry = zip::Entry {
                name,
                utf8: flags & 1 == 1,
                size: u64::from(flags),
                external_attr: u32::from(flags) << 24,
            };
            if let Ok(zip::Action::Extract { obj }) = zip::decide(&entry) {
                let text = String::from_utf8_lossy(name).to_ascii_lowercase();
                assert!(
                    !text.starts_with('/')
                        && !text.contains('\\')
                        && !text.split('/').any(|s| s == "..")
                );
                // PurePosixPath(name).suffix: of the last segment that isn't empty or `.`.
                let last = text
                    .split('/')
                    .rfind(|s| !s.is_empty() && *s != ".")
                    .unwrap_or_default();
                assert!(zip::ALLOWED.iter().any(|ext| last.ends_with(ext)));
                assert_eq!(obj, last.ends_with(".obj"));
            }
            let entries: Vec<zip::Entry<'_>> = name
                .split(|&b| b == b'\n')
                .map(|n| zip::Entry {
                    name: n,
                    utf8: flags & 2 == 2,
                    size: 1,
                    external_attr: 0,
                })
                .collect();
            if let Ok(plan) = zip::plan(&entries) {
                assert!(plan.extract.contains(&plan.obj));
                assert!(plan.total <= zip::MAX_UNPACKED);
            }
        }
        _ => {
            let kind = sniff::sniff(rest);
            assert_eq!(
                kind == sniff::Kind::Jpeg,
                rest.starts_with(&[0xFF, 0xD8, 0xFF])
            );
            assert_eq!(
                sniff::sniff(rest.get(..sniff::HEAD_LEN).unwrap_or(rest)),
                kind
            );
            assert_eq!(
                kind.photo_ext().is_some(),
                !matches!(
                    kind,
                    sniff::Kind::Glb | sniff::Kind::Zip | sniff::Kind::Unknown
                )
            );
        }
    }
});
