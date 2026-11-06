//! What midstudy-add makes of a picture, on pictures built from the fuzzer's bytes (up to 96 × 96, any of RGB, RGBA,
//! L, LA and CMYK, with an EXIF orientation): the engine input, the thumbnail, the rug texture and SAM 3D's mask never
//! panic, and each output decodes again at the size it should have.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_imaging::formats::read;
use midstudy_imaging::image::{Image, Mode};
use midstudy_imaging::ops::{engine_input, foreground_mask, rug_texture, thumb};

fuzz_target!(|data: &[u8]| {
    let [a, b, c, rest @ ..] = data else { return };
    let (w, h) = (1 + usize::from(*a % 96), 1 + usize::from(*b % 96));
    let mode = [Mode::Rgb, Mode::Rgba, Mode::L, Mode::La, Mode::Cmyk][usize::from(*c % 5)];
    let n = w * h * mode.channels();
    let pixels: Vec<u8> = if rest.is_empty() { vec![0; n] } else { rest.iter().copied().cycle().take(n).collect() };
    let mut im = Image::new(w, h, mode, pixels);
    // an EXIF block with only the orientation tag (1..=8), big endian
    let o = 1 + u16::from(*c / 5 % 8);
    let mut exif = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
    exif.extend_from_slice(&o.to_be_bytes());
    exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    im.exif = Some(exif);
    let ei = engine_input(im.clone(), true);
    let back = read(&ei.bytes).expect("the engine input decodes");
    assert_eq!((back.width, back.height), (ei.width, ei.height));
    let t = read(&thumb(im.clone())).expect("the thumbnail decodes");
    assert_eq!((t.width, t.height), (256, 256));
    if let Ok(r) = rug_texture(im.clone(), 160.0, 230.0) {
        read(&r.jpeg).expect("the rug texture decodes");
    }
    let (_, _, png) = foreground_mask(im);
    read(&png).expect("the mask decodes");
});
