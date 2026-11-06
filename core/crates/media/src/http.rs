//! Request framing and ownership checks (contract §2.9 Mutating requests and money).
//!
//! - [`content_length`] (§2.9 Framing: "more than one `Content-Length` header is `400`, and so is one that isn't
//!   ASCII digits"). v1: `parse_request` in `planner/serve.py` (`CONTENT_LENGTH`).
//! - [`host_name`], [`check_host`] (§2.9 Host names: a loopback `Host` or one given with `--allowed-host`, exactly
//!   `name[:port]`; `127.0.0.1:80@evil.example` and `[::1]evil.example` don't pass). v1: `host_name`, `HOST_RE`,
//!   `parse_request` and `main` in `planner/serve.py`.
//! - [`origin_ok`] (§2.9 Forged requests: `X-Midstudy: 1` and an `Origin` that is absent or the page's own). v1:
//!   `forged` in `planner/serve.py`.
//!
//! Header values are text as an HTTP server hands them over (Latin-1 characters); v1 stripped `Host` and
//! `Content-Length` with Python's `str.strip()`, so the same characters are stripped here.

use crate::datauri::is_python_space;

/// The loopback host names every request may use (v1's `LOOPBACK`; compared as text, so `[0:0:0:0:0:0:0:1]` or
/// `127.000.000.001` are not loopback).
pub const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// The most digits a `Content-Length` may have (v1: `[0-9]{1,15}`), so its value always fits (below 2^50).
pub const MAX_LENGTH_DIGITS: usize = 15;

/// Why a request's `Content-Length` is refused (both are `400` in v1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentLengthError {
    /// More than one `Content-Length` header (even equal ones: they frame the body ambiguously).
    Multiple,
    /// Not 1 to 15 ASCII digits once surrounding whitespace is stripped.
    NotDigits,
}

impl core::fmt::Display for ContentLengthError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ContentLengthError::Multiple => {
                write!(f, "the request has more than one Content-Length header")
            }
            ContentLengthError::NotDigits => {
                write!(f, "the Content-Length header isn't a number of bytes")
            }
        }
    }
}

fn py_strip(s: &str) -> &str {
    s.trim_matches(is_python_space)
}

/// The request's body length from all its `Content-Length` header values: `None` without one.
///
/// # Errors
/// [`ContentLengthError`]: more than one header, or a value that isn't 1–15 ASCII digits (a sign, a space inside, a
/// Unicode digit such as `²`).
pub fn content_length(values: &[&str]) -> Result<Option<u64>, ContentLengthError> {
    let value = match values {
        [] => return Ok(None),
        [one] => py_strip(one),
        _ => return Err(ContentLengthError::Multiple),
    };
    digits_value(value.as_bytes())
        .map(Some)
        .ok_or(ContentLengthError::NotDigits)
}

/// The number written by 1 to [`MAX_LENGTH_DIGITS`] ASCII digits, or `None` for anything else. Below 10¹⁵, so the fold
/// never overflows (proved for every input up to 16 bytes by `proofs::digits_value_is_exact`).
pub(crate) fn digits_value(digits: &[u8]) -> Option<u64> {
    if digits.is_empty()
        || digits.len() > MAX_LENGTH_DIGITS
        || !digits.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    digits.iter().try_fold(0u64, |n, &b| {
        n.checked_mul(10)?
            .checked_add(u64::from(b.wrapping_sub(b'0')))
    })
}

/// A `Host` value's name, lowercased and without its port (`[::1]:8765` → `[::1]`), or `None` when it isn't exactly
/// `name[:port]` once Python's `strip()` is applied: a name is `[a-z0-9.-]+` or a bracketed `[0-9a-f:.]+`, a port 1–5
/// digits. The same rule checks `--allowed-host` at startup (§2.9: anything else, a URL say, is refused).
#[must_use]
pub fn host_name(value: &str) -> Option<String> {
    let text = py_strip(value);
    if !text.is_ascii() {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let (name, rest) = if let Some(inner) = lower.strip_prefix('[') {
        let close = inner.find(']')?;
        let (body, after) = inner.split_at_checked(close)?;
        if body.is_empty()
            || !body
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return None;
        }
        let name_len = close.checked_add(2)?;
        (lower.get(..name_len)?, after.get(1..)?)
    } else {
        let len = lower
            .bytes()
            .take_while(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-'
            })
            .count();
        if len == 0 {
            return None;
        }
        lower.split_at_checked(len)?
    };
    let port_ok = match rest.strip_prefix(':') {
        None => rest.is_empty(),
        Some(port) => (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()),
    };
    port_ok.then(|| name.to_owned())
}

/// What [`check_host`] decided. Only `Allowed` may be served; v1 answered `403` to the rest (and used the first of
/// several `Host` headers; v2 refuses them, as RFC 9112 §3.2 asks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostDecision {
    /// A loopback name or an allowed host.
    Allowed,
    /// No `Host` header.
    Missing,
    /// More than one `Host` header.
    Multiple,
    /// Not exactly `name[:port]`.
    Malformed,
    /// A well-formed name that isn't loopback or allowed.
    Unknown,
}

/// Whether a request's `Host` headers name this server: loopback, or one of `allowed` (the names [`host_name`] gave
/// for each `--allowed-host`; their ports are ignored, as in v1).
#[must_use]
pub fn check_host(values: &[&str], allowed: &[&str]) -> HostDecision {
    let value = match values {
        [] => return HostDecision::Missing,
        [one] => *one,
        _ => return HostDecision::Multiple,
    };
    let Some(name) = host_name(value) else {
        return HostDecision::Malformed;
    };
    if LOOPBACK.contains(&name.as_str()) || allowed.iter().any(|a| !a.is_empty() && *a == name) {
        HostDecision::Allowed
    } else {
        HostDecision::Unknown
    }
}

/// §2.9 Forged requests: a mutation passes only with `X-Midstudy: 1` and an `Origin` that is absent or exactly
/// `http://<Host>` or `https://<Host>` (the `Host` value as sent). Values are compared as given: v1 saw them with
/// leading whitespace stripped; Node also strips trailing whitespace, as RFC 9110 says a server should.
#[must_use]
pub fn origin_ok(x_midstudy: Option<&str>, origin: Option<&str>, host: Option<&str>) -> bool {
    if x_midstudy != Some("1") {
        return false;
    }
    let Some(origin) = origin else { return true };
    let host = host.unwrap_or_default();
    !host.is_empty()
        && origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            == Some(host)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn content_lengths() {
        assert_eq!(content_length(&[]), Ok(None));
        assert_eq!(content_length(&[" 12 "]), Ok(Some(12)));
        assert_eq!(content_length(&["0"]), Ok(Some(0)));
        assert_eq!(
            content_length(&["999999999999999"]),
            Ok(Some(999_999_999_999_999))
        );
        assert_eq!(
            content_length(&["1000000000000000"]),
            Err(ContentLengthError::NotDigits)
        );
        assert_eq!(
            content_length(&["12", "12"]),
            Err(ContentLengthError::Multiple)
        );
        for bad in ["", "+1", "-1", "1 2", "²", "0x10", "1.0", "１"] {
            assert_eq!(
                content_length(&[bad]),
                Err(ContentLengthError::NotDigits),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn host_names() {
        assert_eq!(host_name("127.0.0.1:8765").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_name(" LocalHost ").as_deref(), Some("localhost"));
        assert_eq!(host_name("[::1]:80").as_deref(), Some("[::1]"));
        assert_eq!(
            host_name("\u{a0}127.0.0.1\u{85}").as_deref(),
            Some("127.0.0.1")
        );
        for bad in [
            "",
            "127.0.0.1:80@evil.example",
            "[::1]evil.example",
            "http://x",
            "a:123456",
            "a:",
            "[]",
            "[::1",
            "a b",
            "é",
        ] {
            assert_eq!(host_name(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn host_checks() {
        assert_eq!(check_host(&["localhost:1"], &[]), HostDecision::Allowed);
        assert_eq!(
            check_host(&["homeserver:443"], &["homeserver"]),
            HostDecision::Allowed
        );
        assert_eq!(
            check_host(&["evil.example"], &["homeserver"]),
            HostDecision::Unknown
        );
        assert_eq!(
            check_host(&["[0:0:0:0:0:0:0:1]"], &[]),
            HostDecision::Unknown
        );
        assert_eq!(check_host(&[], &[]), HostDecision::Missing);
        assert_eq!(check_host(&["a", "b"], &[]), HostDecision::Multiple);
        assert_eq!(check_host(&["a/b"], &[]), HostDecision::Malformed);
    }

    #[test]
    fn origins() {
        let host = Some("127.0.0.1:8765");
        assert!(origin_ok(Some("1"), None, host));
        assert!(origin_ok(Some("1"), Some("http://127.0.0.1:8765"), host));
        assert!(origin_ok(Some("1"), Some("https://127.0.0.1:8765"), host));
        assert!(!origin_ok(Some("1"), Some("http://evil.example"), host));
        assert!(!origin_ok(Some("1"), Some("null"), host));
        assert!(!origin_ok(None, None, host));
        assert!(!origin_ok(Some("true"), None, host));
        assert!(!origin_ok(Some("1"), Some("http://"), None));
    }
}
