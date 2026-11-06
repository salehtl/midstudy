//! Path normalisation and the static route on arbitrary text: the result starts with `/`, has no `.`, `..` or
//! empty inner segment, is a fixed point of resolve, and nothing served has a segment starting with `.`.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_media::path;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(clean) = path::normalize(text) {
        assert!(clean.starts_with('/'));
        let inner = clean.trim_start_matches('/').trim_end_matches('/');
        assert!(
            inner.is_empty()
                || inner
                    .split('/')
                    .all(|s| !s.is_empty() && s != "." && s != "..")
        );
        assert_eq!(path::resolve(&clean), clean);
        if !matches!(path::route(&clean), path::Route::NotFound) {
            assert!(!clean.split('/').any(|s| s.starts_with('.')));
        }
    }
    let _ = path::static_route(text);
});
