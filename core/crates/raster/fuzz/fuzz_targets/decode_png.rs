//! The depth.png decoder on arbitrary bytes: an error or an image, never a panic; an image it returns has the
//! samples its header promises, and encoding those samples again (crate::pngenc, filter 0) decodes to the same image.
#![no_main]

use libfuzzer_sys::fuzz_target;
use midstudy_raster::png::decode_gray;
use midstudy_raster::pngenc::{Color, encode};

fuzz_target!(|data: &[u8]| {
    if let Ok(g) = decode_gray(data) {
        assert_eq!(
            g.samples.len() as u64,
            u64::from(g.width) * u64::from(g.height)
        );
        let (color, bytes): (Color, Vec<u8>) = if g.bit_depth == 8 {
            assert!(g.samples.iter().all(|&v| v < 256));
            (Color::Gray8, g.samples.iter().map(|&v| v as u8).collect())
        } else {
            assert_eq!(g.bit_depth, 16);
            (
                Color::Gray16,
                g.samples.iter().flat_map(|v| v.to_be_bytes()).collect(),
            )
        };
        let again = encode(g.width, g.height, color, &bytes, 1).expect("a decoded image encodes");
        assert_eq!(decode_gray(&again).expect("an encoded image decodes"), g);
    }
});
