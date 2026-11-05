//! The depth.png decoder on arbitrary bytes: an error or an image, never a panic; and an image it returns has the
//! samples its header promises.
#![no_main]

use libfuzzer_sys::fuzz_target;
use midstudy_raster::png::decode_gray;

fuzz_target!(|data: &[u8]| {
    if let Ok(g) = decode_gray(data) {
        assert_eq!(g.samples.len() as u64, u64::from(g.width) * u64::from(g.height));
        if g.bit_depth == 8 {
            assert!(g.samples.iter().all(|&v| v < 256));
        }
    }
});
