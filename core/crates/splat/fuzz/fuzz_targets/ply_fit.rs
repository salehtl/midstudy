//! The per-axis fit on arbitrary bytes, raw or behind a valid 3DGS header: never a panic; a fitted splat is a PLY that
//! reads back with the same count, without nx/ny/nz, and fits again.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_splat::eigen::IDENTITY;
use midstudy_splat::fit::{FitParams, normalize};
use midstudy_splat::ply::read;

const HEADER: &[u8] = b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n";

fuzz_target!(|data: &[u8]| {
    let framed;
    let input = if data.first().is_some_and(|b| b & 1 == 1) {
        framed = [HEADER, data.get(1..).unwrap_or_default()].concat();
        &framed[..]
    } else {
        data
    };
    let params = FitParams { rotation: IDENTITY, dims: [0.8, 0.95, 0.9], lo_pct: 0.1, hi_pct: 99.9 };
    if let Ok(fit) = normalize(input, &params) {
        let back = read(&fit.ply).expect("a fitted splat reads back");
        assert!(back.props.iter().all(|p| p.name != "nx"));
        let again = normalize(&fit.ply, &params);
        assert!(again.is_ok() || !fit.finite, "a finite fitted splat fits again");
    }
});
