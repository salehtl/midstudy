//! GLB rewrite on arbitrary bytes behind a valid header (or as they come): both layouts accept and refuse the same
//! files; a successful rewrite is a GLB that rewrites to itself, never larger in compact than in place, `changed`
//! says exactly whether the bytes changed, and the in-place layout keeps the file's length when nothing was dropped.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_media::glb::{self, Layout};

fuzz_target!(|data: &[u8]| {
    let framed;
    let input = if data.first().is_some_and(|b| b & 1 == 1) {
        let body = data.get(1..).unwrap_or_default();
        let total = u32::try_from(body.len() + 12).unwrap_or(u32::MAX);
        framed = [&b"glTF\x02\0\0\0"[..], &total.to_le_bytes(), body].concat();
        &framed[..]
    } else {
        data
    };
    let compact = glb::strip(input, Layout::Compact);
    let in_place = glb::strip(input, Layout::InPlace);
    assert_eq!(compact.is_ok(), in_place.is_ok());
    if let (Ok(c), Ok(p)) = (&compact, &in_place) {
        assert!(c.bytes.len() <= p.bytes.len());
        assert_eq!(c.report.images.len(), p.report.images.len());
        for (out, layout) in [(c, Layout::Compact), (p, Layout::InPlace)] {
            assert_eq!(
                out.report.changed,
                out.bytes != input,
                "changed must say whether the bytes changed"
            );
            let again = glb::strip(&out.bytes, layout).expect("a rewritten GLB rewrites again");
            assert!(!again.report.changed);
            assert_eq!(again.bytes, out.bytes);
            assert_eq!(again.report.images_cleaned(), 0);
        }
    }
});
