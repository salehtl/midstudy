//! PNG strip and IHDR size on arbitrary bytes (signature prefixed half the time): a successful strip keeps the
//! signature and (with a 13-byte IHDR) the IHDR size, has no metadata chunk, strips to itself, and `Removed::any` says exactly whether the
//! bytes changed.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_media::png;

fuzz_target!(|data: &[u8]| {
    let with_sig;
    let input = if data.first().is_some_and(|b| b & 1 == 1) {
        with_sig = [&png::SIGNATURE[..], data.get(1..).unwrap_or_default()].concat();
        &with_sig[..]
    } else {
        data
    };
    if let Ok(s) = png::strip(input) {
        assert!(s.bytes.starts_with(&png::SIGNATURE));
        assert!(s.bytes.len() <= input.len());
        assert_eq!(
            s.removed.any(),
            s.bytes != input,
            "Removed::any must say whether the bytes changed"
        );
        let (plan, removed) =
            png::strip_plan(input).expect("strip_plan accepts what strip accepts");
        assert_eq!(removed, s.removed);
        assert_eq!(plan.apply(input), s.bytes);
        assert_eq!(plan.is_identity(input), !s.removed.any());
        let again = png::strip(&s.bytes).expect("a stripped PNG strips again");
        assert_eq!(again.bytes, s.bytes);
        assert_eq!(again.removed, png::Removed::default());
        // A 13-byte IHDR is kept, so the size it gives is kept. (Like v1's png_size, `size` reads bytes 16..24 without
        // looking at IHDR's length, so a shorter IHDR gives bytes of the next chunk, which the strip may drop.)
        if input.get(8..16) == Some(b"\0\0\0\x0dIHDR") {
            assert_eq!(png::size(&s.bytes), png::size(input));
        }
    }
    let _ = png::size(input);
});
