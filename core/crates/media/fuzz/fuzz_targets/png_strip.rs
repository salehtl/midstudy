//! PNG strip and IHDR size on arbitrary bytes (signature prefixed half the time): a successful strip keeps the
//! signature, has no metadata chunk and strips to itself.
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
        let again = png::strip(&s.bytes).expect("a stripped PNG strips again");
        assert_eq!(again.bytes, s.bytes);
        assert_eq!(again.removed, png::Removed::default());
    }
    let _ = png::size(input);
});
