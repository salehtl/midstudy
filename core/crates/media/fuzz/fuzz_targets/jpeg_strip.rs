//! JPEG strip, frame size, clean and pass-through on arbitrary bytes (the input gets an SOI prefix half the time, so
//! the walker goes deep): a successful strip is clean and strips to itself; is_clean means strip removes nothing
//! but fill bytes; `Removed::any` says exactly whether the bytes changed; a frame has a non-zero size and
//! pass-through returns the frame that frame_info reads. (Stripping does not always keep frame_info's answer: like
//! v1's `jpeg_size`, frame_info reads the fields after an SOF marker even when its segment is too short to hold them,
//! so they can come from the bytes that follow, which the strip may drop; docs/notes/kernels-hardening.md.)
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
    assert_eq!(
        stripped.as_ref().err(),
        jpeg::strip_plan(input).err().as_ref()
    );
    if let Ok(s) = &stripped {
        assert!(jpeg::is_clean(&s.bytes));
        assert_eq!(
            s.removed.any(),
            s.bytes != input,
            "Removed::any must say whether the bytes changed"
        );
        assert!(
            s.bytes.len() <= input.len()
                || s.removed.jfif_trimmed > 0 && s.bytes.len() <= input.len() + 16
        );
        let (plan, removed) =
            jpeg::strip_plan(input).expect("strip_plan accepts what strip accepts");
        assert_eq!(removed, s.removed);
        assert_eq!(plan.apply(input), s.bytes);
        assert_eq!(plan.is_identity(input), !s.removed.any());
        let again = jpeg::strip(&s.bytes).expect("a stripped JPEG strips again");
        assert_eq!(again.bytes, s.bytes);
        assert_eq!(again.removed, jpeg::Removed::default());
    }
    let nothing_removed = stripped.is_ok_and(|s| {
        jpeg::Removed {
            fill_bytes: 0,
            ..s.removed
        } == jpeg::Removed::default()
    });
    assert_eq!(jpeg::is_clean(input), nothing_removed);
    let frame = jpeg::frame_info(input);
    if let Ok(f) = frame {
        assert!(f.width > 0 && f.height > 0);
    }
    if let Ok(f) = jpeg::passthrough(input) {
        assert!(jpeg::is_clean(input));
        assert_eq!(frame, Ok(f));
        assert!(
            f.precision == 8
                && f.components == 3
                && f.width.max(f.height) <= jpeg::PASSTHROUGH_LONG_SIDE
        );
    }
});
