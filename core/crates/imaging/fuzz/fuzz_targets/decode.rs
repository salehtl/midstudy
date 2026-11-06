//! The decoders on arbitrary bytes (raw, or behind a JPEG, PNG or RIFF/WebP signature): never a panic; a decoded
//! picture has the size its header probes and exactly width × height pixels of its mode.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_imaging::formats::{probe, read};

fuzz_target!(|data: &[u8]| {
    let framed;
    let input = match data.first().map(|b| b % 4) {
        Some(1) => {
            framed = [&[0xff, 0xd8, 0xff][..], data.get(1..).unwrap_or_default()].concat();
            &framed[..]
        }
        Some(2) => {
            framed = [&b"\x89PNG\r\n\x1a\n"[..], data.get(1..).unwrap_or_default()].concat();
            &framed[..]
        }
        Some(3) => {
            let body = data.get(1..).unwrap_or_default();
            let n = u32::try_from(body.len() + 4).unwrap_or(u32::MAX);
            framed = [&b"RIFF"[..], &n.to_le_bytes(), b"WEBP", body].concat();
            &framed[..]
        }
        _ => data,
    };
    let probed = probe(input);
    if let Ok(im) = read(input) {
        assert!(im.width > 0 && im.height > 0);
        assert_eq!(im.data.len(), im.width * im.height * im.mode.channels());
        if let Ok((_, w, h)) = probed {
            assert_eq!((w, h), (im.width, im.height));
        }
    }
});
