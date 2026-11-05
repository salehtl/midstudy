//! GLB rewrite on arbitrary bytes behind a valid header (or as they come): both layouts; a successful rewrite is a
//! GLB that rewrites to itself, never larger in compact than in place.
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
        for (out, layout) in [(c, Layout::Compact), (p, Layout::InPlace)] {
            let again = glb::strip(&out.bytes, layout).expect("a rewritten GLB rewrites again");
            assert!(!again.report.changed);
        }
    }
});
