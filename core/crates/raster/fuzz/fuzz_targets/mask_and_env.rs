//! The keep-room mask and the environment map on arbitrary sizes and pixels: an error or a result, never a panic.
#![no_main]

use libfuzzer_sys::fuzz_target;
use midstudy_raster::envmap::{EnvFilter, EnvSpec, Rgba8, env_map};
use midstudy_raster::mask::keep_room_mask;

fuzz_target!(|data: &[u8]| {
    let Some((&[w, h, flags, pitch, roll, fov], pixels)) = data.split_first_chunk::<6>() else { return };
    let (w, h) = (usize::from(w % 64), usize::from(h % 64));
    if let Ok(k) = keep_room_mask(pixels, w, h, flags & 1 == 1) {
        assert_eq!(k.mask.len(), w * h);
        assert!((0.0..=1.0).contains(&k.coverage));
    }
    let r = midstudy_geom_rotation(f64::from(pitch) - 128.0, f64::from(roll) - 128.0);
    let filter = if flags & 2 == 2 { EnvFilter::Bilinear } else { EnvFilter::Mipmapped { max_anisotropy: flags >> 4 } };
    let spec = EnvSpec {
        width: 8,
        height: 4,
        filter,
        ..EnvSpec::v1(&r, f64::from(fov % 120), w as f64, h as f64)
    };
    let mut out = vec![0.0_f32; 8 * 4 * 4];
    if env_map(&Rgba8 { width: w, height: h, pixels }, &spec, &mut out).is_ok() {
        assert!(out.iter().all(|v| !v.is_nan()));
    }
});

fn midstudy_geom_rotation(pitch: f64, roll: f64) -> [[f64; 3]; 3] {
    let (sp, cp) = pitch.to_radians().sin_cos();
    let (sr, cr) = roll.to_radians().sin_cos();
    [[cr, -sr, 0.0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]]
}
