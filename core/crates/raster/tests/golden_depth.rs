//! The golden scenes' depth.png (contract §5.1) through the decoder: the samples equal Pillow's decode (recorded by
//! `tests/support/pil_depth.py`, run with `evals/py`), and the open-floor points read 0 there, as
//! `fixtures/check_scenes.py` requires of Pillow's decode.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

use midstudy_geom::{Camera, CameraBlock};
use midstudy_raster::depth::decode_depth_m;
use midstudy_raster::png::decode_gray;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::path::PathBuf;

/// `evals/py core/crates/raster/tests/support/pil_depth.py`: (scene, width, height, sum of samples, SHA-256 of the
/// samples as little-endian u16).
const PIL: [(&str, u32, u32, u64, &str); 5] = [
    (
        "living-cool",
        1024,
        768,
        2_365_972_735,
        "9465f503feba0d1c614322405b27582ae191d9bc5db4ec59fe208732d9e4b36b",
    ),
    (
        "living-warm",
        1024,
        768,
        2_365_972_735,
        "9465f503feba0d1c614322405b27582ae191d9bc5db4ec59fe208732d9e4b36b",
    ),
    (
        "living-wide",
        1024,
        768,
        2_365_972_735,
        "9465f503feba0d1c614322405b27582ae191d9bc5db4ec59fe208732d9e4b36b",
    ),
    (
        "portrait",
        768,
        1024,
        2_110_123_373,
        "b12f3226891931b5d7a21b8a4a4e76b4acab12a36751332955f23b9f4c47dcd6",
    ),
    (
        "steep-roll",
        1024,
        768,
        1_580_140_275,
        "d2b2434e783edff6554b425b1e15092731dc369f60c9cb938d8e42ab10722d1d",
    ),
];

fn scene(id: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/scenes")
        .join(id)
}

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn decodes_like_pillow() {
    for (id, w, h, sum, sha) in PIL {
        let bytes = std::fs::read(scene(id).join("depth.png")).unwrap();
        let g = decode_gray(&bytes).unwrap();
        assert_eq!((g.width, g.height, g.bit_depth), (w, h, 16), "{id}");
        assert_eq!(
            g.samples.iter().map(|&v| u64::from(v)).sum::<u64>(),
            sum,
            "{id}"
        );
        let mut hasher = Sha256::new();
        for v in &g.samples {
            hasher.update(v.to_le_bytes());
        }
        let digest = hasher.finalize().iter().fold(String::new(), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        });
        assert_eq!(digest, sha, "{id}: the samples differ from Pillow's");
    }
}

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn open_floor_is_zero() {
    for (id, ..) in PIL {
        let dir = scene(id);
        let truth: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("truth.json")).unwrap())
                .unwrap();
        let num = |v: &Value| v.as_f64().unwrap();
        let c = &truth["camera"];
        let camera = CameraBlock {
            fov_y_deg: num(&c["fov_y_deg"]),
            height_m: num(&c["height_m"]),
            pitch_deg: num(&c["pitch_deg"]),
            roll_deg: num(&c["roll_deg"]),
        };
        let map = decode_depth_m(&std::fs::read(dir.join("depth.png")).unwrap(), 1.0).unwrap();
        // depth.png is the same projection at its own size (f scales with H).
        let cam = Camera::new(camera, f64::from(map.width), f64::from(map.height));
        let w = usize::try_from(map.width).unwrap();
        for p in truth["floor_points"].as_array().unwrap() {
            let world = &p["world"];
            let [px, py] = cam.floor_to_photo([num(&world[0]), num(&world[1]), num(&world[2])]);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let (i, j) = (px as usize, py as usize);
            assert_eq!(
                map.data[j * w + i],
                0.0,
                "{id}: open floor at {world} is not 0"
            );
        }
        assert!(map.data.iter().any(|&d| d > 1.0), "{id}: no depth at all");
    }
}
