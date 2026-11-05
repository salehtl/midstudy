//! Image data URIs.
//!
//! - [`decode_image`] (contract §2.6 Render API `image`, §2.8 and §4.4 thumbnail PUTs, §4.7 keep-room `mask`): v1's
//!   `decode_data_uri` in `planner/serve.py`: exactly `data:image/jpeg;base64,` (or `jpg`; `png` for the mask), then
//!   base64 that may contain whitespace (Python's `\s`, Unicode included), decoded strictly once the whitespace is
//!   gone.
//! - [`parse`]: the WHATWG `data:` URL processor (fetch spec), as browsers read a URL: used for a GLB's data-URI
//!   textures (contract §2.8 Privacy), so the bytes cleaned are the bytes three.js will draw.

use crate::base64::{Base64Error, decode_forgiving, decode_python};

/// The image type a data URI must declare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageType {
    /// `data:image/jpeg;base64,` or `data:image/jpg;base64,`.
    Jpeg,
    /// `data:image/png;base64,`.
    Png,
}

/// Why [`decode_image`] refused a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataUriError {
    /// Not `data:image/<type>;base64,<base64 and whitespace>` for the expected type.
    NotDataUri,
    /// The payload isn't strict base64 once whitespace is removed.
    Base64(Base64Error),
}

impl core::fmt::Display for DataUriError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            DataUriError::NotDataUri => write!(f, "not an image data URI of the expected type"),
            DataUriError::Base64(e) => write!(f, "the data URI isn't base64 ({e})"),
        }
    }
}

/// Python's `str.isspace()` (and so `re`'s `\s` on text), Unicode 15 as in `CPython` 3.12.
#[must_use]
pub const fn is_python_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | '\u{1C}'..='\u{20}'
            | '\u{85}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
    )
}

/// The bytes of an image data URI of the given type, exactly as v1's `decode_data_uri` reads them.
///
/// # Errors
/// [`DataUriError`]: the value isn't such a data URI, or its payload isn't base64.
pub fn decode_image(value: &str, kind: ImageType) -> Result<Vec<u8>, DataUriError> {
    let rest = value
        .strip_prefix("data:image/")
        .ok_or(DataUriError::NotDataUri)?;
    let payload = match kind {
        ImageType::Jpeg => rest
            .strip_prefix("jpeg;base64,")
            .or_else(|| rest.strip_prefix("jpg;base64,")),
        ImageType::Png => rest.strip_prefix("png;base64,"),
    }
    .ok_or(DataUriError::NotDataUri)?;
    // `[A-Za-z0-9+/=\s]+`: at least one character, each base64, `=` or whitespace.
    if payload.is_empty()
        || !payload.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=') || is_python_space(c)
        })
    {
        return Err(DataUriError::NotDataUri);
    }
    let compact: String = payload.chars().filter(|&c| !is_python_space(c)).collect();
    decode_python(compact.as_bytes(), true).map_err(DataUriError::Base64)
}

/// A `data:` URL as the fetch spec's data URL processor reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataUrl {
    /// The MIME type text, without the `;base64` marker (unparsed; `text/plain` is prepended when it starts with `;`).
    pub mime: String,
    /// The body: percent-decoded, then base64-decoded when the URL says `;base64`.
    pub body: Vec<u8>,
    /// Whether the URL said `;base64`.
    pub base64: bool,
}

const fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(c.wrapping_sub(b'a').wrapping_add(10)),
        b'A'..=b'F' => Some(c.wrapping_sub(b'A').wrapping_add(10)),
        _ => None,
    }
}

/// The URL standard's percent-decode: `%` and two hex digits become that byte; anything else is kept.
pub(crate) fn percent_decode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0usize;
    while let Some(&c) = input.get(i) {
        if c == b'%' {
            let hi = input.get(i.saturating_add(1)).copied().and_then(hex);
            let lo = input.get(i.saturating_add(2)).copied().and_then(hex);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(hi.wrapping_shl(4) | lo);
                i = i.saturating_add(3);
                continue;
            }
        }
        out.push(c);
        i = i.saturating_add(1);
    }
    out
}

/// Reads a `data:` URL the way a browser does (WHATWG URL parsing's trimming and tab/newline removal, the fragment
/// dropped, then the fetch spec's data URL processor). `None` when it isn't a `data:` URL or its base64 is invalid.
#[must_use]
pub fn parse(url: &str) -> Option<DataUrl> {
    let trimmed = url.trim_matches(|c: char| c <= ' ');
    let cleaned: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let scheme = cleaned.get(..5)?;
    if !scheme.eq_ignore_ascii_case("data:") {
        return None;
    }
    let after = cleaned.get(5..)?;
    let without_fragment = after.split_once('#').map_or(after, |(head, _)| head);
    let (mime_raw, body_raw) = without_fragment.split_once(',')?;
    let mut mime = mime_raw
        .trim_matches(|c: char| matches!(c, '\t' | '\n' | '\u{0C}' | '\r' | ' '))
        .to_owned();
    let mut body = percent_decode(body_raw.as_bytes());
    let base64 = base64_marker(&mime);
    if let Some(cut) = base64 {
        body = decode_forgiving(&body)?;
        mime.truncate(cut);
    }
    if mime.starts_with(';') {
        mime.insert_str(0, "text/plain");
    }
    Some(DataUrl {
        mime,
        body,
        base64: base64.is_some(),
    })
}

/// When `mime` ends with `;`, optional spaces and `base64` (any case), the length to cut it back to (before the `;`).
fn base64_marker(mime: &str) -> Option<usize> {
    let cut = mime.len().checked_sub(6)?;
    let tail = mime.get(cut..)?;
    if !tail.eq_ignore_ascii_case("base64") {
        return None;
    }
    let head = mime.get(..cut)?.trim_end_matches(' ');
    head.strip_suffix(';').map(str::len)
}

/// `data:<mime>;base64,<body>`: the canonical form a cleaned texture is written back in.
#[must_use]
pub fn encode(mime: &str, body: &[u8]) -> String {
    let b64 = crate::base64::encode(body);
    let mut out = String::with_capacity(mime.len().saturating_add(b64.len()).saturating_add(13));
    out.push_str("data:");
    out.push_str(mime);
    out.push_str(";base64,");
    out.push_str(&b64);
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn v1_image_data_uris() {
        assert_eq!(
            decode_image("data:image/jpeg;base64,/9j/", ImageType::Jpeg).unwrap(),
            [0xFF, 0xD8, 0xFF]
        );
        assert_eq!(
            decode_image("data:image/jpg;base64,/9j/", ImageType::Jpeg).unwrap(),
            [0xFF, 0xD8, 0xFF]
        );
        assert_eq!(
            decode_image("data:image/jpeg;base64,/9\n j/\u{3000}", ImageType::Jpeg).unwrap(),
            [0xFF, 0xD8, 0xFF]
        );
        assert_eq!(
            decode_image("data:image/png;base64,/9j/", ImageType::Jpeg),
            Err(DataUriError::NotDataUri)
        );
        assert_eq!(
            decode_image("data:image/jpeg;base64,", ImageType::Jpeg),
            Err(DataUriError::NotDataUri)
        );
        assert_eq!(
            decode_image("data:image/jpeg;base64,/9j", ImageType::Jpeg),
            Err(DataUriError::Base64(Base64Error::IncorrectPadding))
        );
        assert_eq!(
            decode_image("DATA:image/jpeg;base64,/9j/", ImageType::Jpeg),
            Err(DataUriError::NotDataUri)
        );
    }

    #[test]
    fn browser_data_urls() {
        let d = parse(" data:image/png;BASE64,iV\nBO#frag").unwrap();
        assert_eq!(
            (d.mime.as_str(), d.body.as_slice(), d.base64),
            ("image/png", [0x89, 0x50, 0x4E].as_slice(), true)
        );
        let p = parse("DATA:image/png,%89PNG").unwrap();
        assert_eq!(
            (d.base64, p.base64, p.body.as_slice()),
            (true, false, b"\x89PNG".as_slice())
        );
        assert_eq!(parse("data:;base64,QQ").unwrap().mime, "");
        assert_eq!(
            parse("data:;charset=x,QQ").unwrap().mime,
            "text/plain;charset=x"
        );
        assert_eq!(parse("data:image/png;base64,Q"), None);
        assert_eq!(parse("http://x/data:,"), None);
        assert_eq!(parse("data:image/png"), None);
        assert_eq!(encode("image/png", b"A"), "data:image/png;base64,QQ==");
    }
}
