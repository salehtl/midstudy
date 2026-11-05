//! The `X-Midstudy-Meta` header (contract §2.8 Library API and §4.4 Upload: "`X-Midstudy-Meta: <base64 of JSON
//! meta>`"): strict base64 of UTF-8 JSON, with a size cap. The JSON itself is parsed by the caller.
//!
//! v1 (`post_scene`, `post_library_upload` in `planner/serve.py`): `json.loads(base64.b64decode(raw,
//! validate=True).decode("utf-8"))`; a non-ASCII header failed in `b64decode` (a `ValueError`). v1 had no cap of
//! its own (http.client refuses header lines over 64 KiB); Node's whole header block is 16 KiB by default.

use crate::base64::{Base64Error, decode_python};

/// The longest header value accepted, in bytes of base64 (the decoded JSON is at most three quarters of it).
pub const MAX_HEADER_LEN: usize = 16 * 1024;

/// Why [`decode`] refused a header value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaError {
    /// Longer than the cap.
    TooLong {
        /// The header's length in bytes.
        len: usize,
        /// The cap.
        max: usize,
    },
    /// A character outside ASCII.
    NotAscii,
    /// Not strict base64.
    Base64(Base64Error),
    /// The decoded bytes aren't UTF-8.
    NotUtf8,
}

impl core::fmt::Display for MetaError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MetaError::TooLong { len, max } => write!(
                f,
                "X-Midstudy-Meta is {len} bytes, at most {max} are allowed"
            ),
            MetaError::NotAscii => write!(f, "X-Midstudy-Meta isn't ASCII"),
            MetaError::Base64(e) => write!(f, "X-Midstudy-Meta isn't base64 ({e})"),
            MetaError::NotUtf8 => write!(f, "X-Midstudy-Meta doesn't decode to UTF-8 text"),
        }
    }
}

/// The JSON text inside an `X-Midstudy-Meta` value: strict base64 (`CPython` `b64decode(…, validate=True)`), then
/// strict UTF-8. An empty header decodes to an empty string (which isn't JSON: the caller refuses it as v1 did).
///
/// # Errors
/// [`MetaError`]: over `max_len` bytes, not ASCII, not strict base64, or not UTF-8.
pub fn decode(header: &str, max_len: usize) -> Result<String, MetaError> {
    if header.len() > max_len {
        return Err(MetaError::TooLong {
            len: header.len(),
            max: max_len,
        });
    }
    if !header.is_ascii() {
        return Err(MetaError::NotAscii);
    }
    let bytes = decode_python(header.as_bytes(), true).map_err(MetaError::Base64)?;
    String::from_utf8(bytes).map_err(|_| MetaError::NotUtf8)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn decodes_strictly() {
        assert_eq!(
            decode("eyJ0aXRsZSI6ICJMb3VuZ2UifQ==", MAX_HEADER_LEN).unwrap(),
            r#"{"title": "Lounge"}"#
        );
        assert_eq!(decode("", MAX_HEADER_LEN).unwrap(), "");
        assert_eq!(
            decode("eyJ0 aXRsZSI6ICJMb3VuZ2UifQ==", MAX_HEADER_LEN),
            Err(MetaError::Base64(Base64Error::NotBase64 { at: 4 }))
        );
        assert_eq!(decode("é", MAX_HEADER_LEN), Err(MetaError::NotAscii));
        assert_eq!(decode("/w==", MAX_HEADER_LEN), Err(MetaError::NotUtf8));
        assert_eq!(
            decode("QUJD", 3),
            Err(MetaError::TooLong { len: 4, max: 3 })
        );
    }
}
