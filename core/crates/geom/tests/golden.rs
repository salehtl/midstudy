//! The golden scenes (`fixtures/scenes/*/truth.json`, contract §5.1) against the camera model.
//!
//! truth.json stores `corner_px` and `floor_points[].px` rounded to 3 decimals (`make_scene.mjs`'s `toFixed(3)`) and the
//! world corners to 6 (`r6`), so the checks against those numbers allow exactly that rounding; the full-precision
//! checks (the floor round trip, 1e-9 m) run from the world points through this crate's own projection, and the
//! Node differential test compares the projection with evals/lib/harness.mjs at full precision (1e-6 px).
#![allow(
    clippy::unwrap_used,
    clippy::many_single_char_names,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

use midstudy_geom::camera::turn_to_world;
use midstudy_geom::item::{LocalBox, Pose, box_corners};
use midstudy_geom::mat::V3;
use midstudy_geom::{Camera, CameraBlock};
use serde_json::Value;
use std::path::PathBuf;

fn scenes_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/scenes")
}

struct Scene {
    id: String,
    truth: Value,
    lighting: Value,
    cam: Camera,
}

fn scenes() -> Vec<Scene> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(scenes_dir()).expect("fixtures/scenes") {
        let dir = entry.unwrap().path();
        let Ok(text) = std::fs::read_to_string(dir.join("truth.json")) else {
            continue;
        };
        let truth: Value = serde_json::from_str(&text).unwrap();
        // The room fixtures (room-1 … room-6, docs/ROOMS.md) are other cameras in the same room, not the five pinned here.
        if truth.get("pose_in_room").is_some() {
            continue;
        }
        let lighting: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("lighting.json")).unwrap())
                .unwrap();
        let c = &truth["camera"];
        let block = CameraBlock {
            fov_y_deg: num(&c["fov_y_deg"]),
            height_m: num(&c["height_m"]),
            pitch_deg: num(&c["pitch_deg"]),
            roll_deg: num(&c["roll_deg"]),
        };
        let cam = Camera::new(block, num(&truth["image"]["w"]), num(&truth["image"]["h"]));
        out.push(Scene {
            id: dir.file_name().unwrap().to_string_lossy().into_owned(),
            truth,
            lighting,
            cam,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(out.len(), 5, "the five golden scenes");
    out
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn v3(v: &Value) -> V3 {
    [num(&v[0]), num(&v[1]), num(&v[2])]
}

fn p2(v: &Value) -> [f64; 2] {
    [num(&v[0]), num(&v[1])]
}

/// The largest error a 3-decimal `toFixed` leaves, plus float slack.
const ROUND3: f64 = 5e-4 + 1e-9;

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn every_corner_projects_onto_corner_px() {
    let mut worst = 0.0_f64;
    let mut n = 0;
    for s in scenes() {
        for (name, o) in s.truth["objects"].as_object().unwrap() {
            let corners = o["corners"].as_array().unwrap();
            let px = o["corner_px"].as_array().unwrap();
            assert_eq!(corners.len(), 8);
            for (c, p) in corners.iter().zip(px) {
                let mine = s.cam.floor_to_photo(v3(c));
                let file = p2(p);
                let err = (mine[0] - file[0]).abs().max((mine[1] - file[1]).abs());
                assert!(err <= ROUND3, "{} {name}: {mine:?} vs {file:?}", s.id);
                assert!(
                    s.cam.project(v3(c))[2] > 0.0,
                    "{} {name}: corner behind the camera",
                    s.id
                );
                worst = worst.max(err);
                n += 1;
            }
        }
    }
    assert_eq!(n, 5 * 2 * 8);
    eprintln!(
        "{n} corners: worst |floorToPhoto − corner_px| = {worst:.2e} px (the file rounds to 1e-3)"
    );
}

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn photo_to_floor_inverts_the_floor_points() {
    let mut worst_trip = 0.0_f64;
    let mut worst_file = 0.0_f64;
    for s in scenes() {
        for fp in s.truth["floor_points"].as_array().unwrap() {
            let world = v3(&fp["world"]);
            // Full precision: the world point through this crate's projection and back.
            let [px, py] = s.cam.floor_to_photo(world);
            let back = s
                .cam
                .photo_to_floor(px, py)
                .expect("a floor point is below the horizon");
            let trip = (0..3)
                .map(|k| (back[k] - world[k]).abs())
                .fold(0.0, f64::max);
            assert!(trip <= 1e-9, "{}: {world:?} -> {back:?}", s.id);
            worst_trip = worst_trip.max(trip);
            // The file's 3-decimal pixel: within what that rounding moves a floor point (meters per pixel there).
            let file = p2(&fp["px"]);
            let got = s.cam.photo_to_floor(file[0], file[1]).unwrap();
            let gx = s.cam.photo_to_floor(file[0] + 1.0, file[1]).unwrap();
            let gy = s.cam.photo_to_floor(file[0], file[1] + 1.0).unwrap();
            let m_per_px = (0..3)
                .map(|k| (gx[k] - got[k]).abs() + (gy[k] - got[k]).abs())
                .fold(0.0, f64::max);
            let err = (0..3)
                .map(|k| (got[k] - world[k]).abs())
                .fold(0.0, f64::max);
            assert!(
                err <= m_per_px * 6e-4 + 1e-9,
                "{}: {err} m with {m_per_px} m/px",
                s.id
            );
            worst_file = worst_file.max(err);
        }
    }
    eprintln!(
        "floor points: round trip ≤ {worst_trip:.2e} m; from the file's rounded px ≤ {worst_file:.2e} m"
    );
}

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn horizon_and_signs_are_pinned() {
    for s in scenes() {
        let b = s.cam.block();
        let (w, h) = s.cam.size();
        let f = s.cam.focal();
        let mid = s.cam.horizon_at(w / 2.0).unwrap();
        // At the centre column roll doesn't move the horizon's row: H/2 − f·tan(−pitch)/cos(roll).
        let expect =
            h / 2.0 - f * (-b.pitch_deg).to_radians().tan() / b.roll_deg.to_radians().cos();
        assert!(
            (mid - expect).abs() < 1e-9,
            "{}: horizon {mid} vs {expect}",
            s.id
        );
        assert!(
            mid < h / 2.0,
            "{}: looking down puts the horizon above the centre",
            s.id
        );
        // Positive roll: the horizon falls to the right; negative: it rises.
        let (left, right) = (s.cam.horizon_at(0.0).unwrap(), s.cam.horizon_at(w).unwrap());
        assert_eq!(right > left, b.roll_deg > 0.0, "{}", s.id);
        assert_eq!(right < left, b.roll_deg < 0.0, "{}", s.id);
        // Every floor corner of every object is below the horizon at its column.
        for o in s.truth["objects"].as_object().unwrap().values() {
            for c in o["corners"].as_array().unwrap().iter().take(4) {
                let [px, py] = s.cam.floor_to_photo(v3(c));
                assert!(
                    py > s.cam.horizon_at(px).unwrap(),
                    "{}: a floor corner above the horizon",
                    s.id
                );
            }
        }
        // The pitch the horizon row gives back is the camera's.
        assert!((s.cam.pitch_from_horizon(mid).unwrap() - b.pitch_deg).abs() < 1e-9);
        // The wrong signs miss corner_px by pixels, not rounding: negated pitch, negated roll (when there is one).
        let sofa = &s.truth["objects"]["sofa"];
        let miss = |alt: CameraBlock| {
            let c = Camera::new(alt, w, h);
            let corners = sofa["corners"].as_array().unwrap();
            corners
                .iter()
                .zip(sofa["corner_px"].as_array().unwrap())
                .fold(0.0_f64, |m, (c3, p)| {
                    let q = c.floor_to_photo(v3(c3));
                    let f = p2(p);
                    m.max((q[0] - f[0]).abs().max((q[1] - f[1]).abs()))
                })
        };
        assert!(
            miss(CameraBlock {
                pitch_deg: -b.pitch_deg,
                ..b
            }) > 50.0,
            "{}",
            s.id
        );
        assert!(
            miss(CameraBlock {
                pitch_deg: b.pitch_deg + 0.5,
                ..b
            }) > 5.0,
            "{}",
            s.id
        );
        if b.roll_deg.abs() > 0.1 {
            assert!(
                miss(CameraBlock {
                    roll_deg: -b.roll_deg,
                    ..b
                }) > 5.0,
                "{}",
                s.id
            );
        }
    }
}

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn the_item_frame_builds_truths_corners() {
    for s in scenes() {
        for (name, o) in s.truth["objects"].as_object().unwrap() {
            let size = &o["size_m"];
            let pose = Pose {
                position: v3(&o["center"]),
                rotation_y_deg: num(&o["rotation_y_deg"]),
            };
            let local = LocalBox::from_dims(num(&size["w"]), num(&size["h"]), num(&size["d"]));
            let mine = box_corners(&pose.transform(), &local);
            for (m, c) in mine.iter().zip(o["corners"].as_array().unwrap()) {
                let c = v3(c);
                // truth.json rounds the corners to 6 decimals.
                assert!(
                    (0..3).all(|k| (m[k] - c[k]).abs() <= 5e-7 + 1e-12),
                    "{} {name}: {m:?} vs {c:?}",
                    s.id
                );
            }
        }
    }
}

#[test]
#[cfg_attr(
    miri,
    ignore = "reads the golden fixtures from disk, and Miri runs isolated"
)]
fn the_light_frame_is_the_cameras() {
    // lighting.json's key is in the camera frame; R turns it into the world frame (§4.8), which the golden
    // lighting.json records (rounded to 6 decimals) for the evals.
    for s in scenes() {
        let key = v3(&s.lighting["key"]["direction"]);
        let world = v3(&s.lighting["world"]["key_direction"]);
        let mine = turn_to_world(&s.cam.rotation(), key);
        assert!(
            (0..3).all(|k| (mine[k] - world[k]).abs() < 2e-6),
            "{}: {mine:?} vs {world:?}",
            s.id
        );
    }
}
