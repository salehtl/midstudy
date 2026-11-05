//! JPEG strip, frame size, clean and pass-through on arbitrary bytes (the input gets an SOI prefix half the time, so
//! the walker goes deep): a successful strip is clean and strips to itself; is_clean means strip removes nothing
//! but fill bytes; a frame has a non-zero size.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_media::jpeg;

fuzz_target!(|data: &[u8]| {
    let with_soi;
    let input = if data.first().is_some_and(|b| b & 1 == 1) {
        with_soi = [&[0xFF, 0xD8][..], data.get(1..).unwrap_or_default()].concat();
        &with_soi[..]
    } else {
        data
    };
    let stripped = jpeg::strip(input);
    if let Ok(s) = &stripped {
        assert!(jpeg::is_clean(&s.bytes));
        let again = jpeg::strip(&s.bytes).expect("a stripped JPEG strips again");
        assert_eq!(again.bytes, s.bytes);
        assert_eq!(again.removed, jpeg::Removed::default());
    }
    let nothing_removed = stripped.is_ok_and(|s| jpeg::Removed { fill_bytes: 0, ..s.removed } == jpeg::Removed::default());
    assert_eq!(jpeg::is_clean(input), nothing_removed);
    if let Ok(f) = jpeg::frame_info(input) {
        assert!(f.width > 0 && f.height > 0);
    }
    if jpeg::passthrough(input).is_ok() {
        assert!(jpeg::is_clean(input));
    }
});
