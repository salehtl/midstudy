//! splat.spz from arbitrary PLY bytes: never a panic; an encoded splat checks against its own PLY (count, header,
//! positions within half a fixed-point step), and at most 262,144 splats are kept.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_splat::spz::{check, encode};

const HEADER: &[u8] = b"ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n";

fuzz_target!(|data: &[u8]| {
    let framed;
    let input = if data.first().is_some_and(|b| b & 1 == 1) {
        framed = [HEADER, data.get(1..).unwrap_or_default()].concat();
        &framed[..]
    } else {
        data
    };
    if let Ok(spz) = encode(input) {
        assert!(spz.count <= 262_144);
        let c = check(&spz.payload, input).expect("an encoded splat reads back");
        assert!(c.valid);
        assert_eq!(c.count as usize, spz.count);
        assert!(!(c.max_offset > 0.5 / 4096.0 + 1e-12), "positions {} off", c.max_offset);
    }
});
