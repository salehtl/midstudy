//! Host parsing, the Host decision, Content-Length and the Origin rule on arbitrary text: a parsed host name is
//! lowercase `name` or `[addr]` with no port, and only a loopback or allowed name is allowed.
#![no_main]
use libfuzzer_sys::fuzz_target;
use midstudy_media::http;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if let Some(name) = http::host_name(text) {
        assert!(!name.is_empty() && !name.contains(':') || name.starts_with('['));
        assert_eq!(name, name.to_ascii_lowercase());
        assert!(
            name.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"[].:-".contains(&b))
        );
    }
    let decision = http::check_host(&[text], &["homeserver"]);
    if decision == http::HostDecision::Allowed {
        let name = http::host_name(text).expect("an allowed host has a name");
        assert!(http::LOOPBACK.contains(&name.as_str()) || name == "homeserver");
    }
    if let Ok(Some(n)) = http::content_length(&[text]) {
        assert!(n < 1_000_000_000_000_000);
    }
    // Split near the middle, at a character boundary.
    let mid = (0..=text.len() / 2)
        .rev()
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(0);
    let (a, b) = text.split_at(mid);
    let _ = http::origin_ok(Some(a), Some(b), Some(text));
});
