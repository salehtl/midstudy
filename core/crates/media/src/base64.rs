//! Base64 in the three dialects midstudy meets.
//!
//! - [`decode_python`]: `CPython`'s `binascii.a2b_base64`, which v1 used through `base64.b64decode`: strict
//!   (`validate=True`, for `X-Midstudy-Meta` and the render and thumbnail data URIs, contract §2.6, §2.8) or lenient
//!   (the default, which v1's GLB texture scrub used on `data:` URIs).
//! - [`decode_forgiving`]: the WHATWG "forgiving-base64 decode" that browsers apply to `data:` URLs, so a GLB's
//!   data-URI texture is read exactly as three.js will read it (contract §2.8 Privacy).
//! - [`encode`]: the standard alphabet with padding.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// The 6-bit value of a base64 alphabet character.
const fn value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c.wrapping_sub(b'A')),
        b'a'..=b'z' => Some(c.wrapping_sub(b'a').wrapping_add(26)),
        b'0'..=b'9' => Some(c.wrapping_sub(b'0').wrapping_add(52)),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Why [`decode_python`] refused its input (`CPython`'s messages, in its order of checks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base64Error {
    /// Strict: the input starts with `=`.
    LeadingPadding,
    /// Strict: `=` where no character is pending (a multiple of 4 data characters before it).
    ExcessPadding,
    /// Strict: a character outside the alphabet.
    NotBase64 {
        /// Offset of the character.
        at: usize,
    },
    /// Strict: a data character after padding started.
    DiscontinuousPadding {
        /// Offset of the character.
        at: usize,
    },
    /// Strict: anything after complete padding.
    DataAfterPadding,
    /// One data character more than a multiple of 4.
    OneExtraCharacter,
    /// Two or three data characters left over without their padding.
    IncorrectPadding,
}

impl core::fmt::Display for Base64Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Base64Error::LeadingPadding => write!(f, "leading padding"),
            Base64Error::ExcessPadding => write!(f, "excess padding"),
            Base64Error::NotBase64 { at } => write!(f, "a character outside base64 at {at}"),
            Base64Error::DiscontinuousPadding { at } => {
                write!(f, "data after padding started, at {at}")
            }
            Base64Error::DataAfterPadding => write!(f, "data after the padding"),
            Base64Error::OneExtraCharacter => write!(f, "one character more than a multiple of 4"),
            Base64Error::IncorrectPadding => write!(f, "incorrect padding"),
        }
    }
}

/// Decodes like `CPython` 3.12's `binascii.a2b_base64(s, strict_mode=strict)`, check for check.
///
/// Strict mode refuses anything but alphabet characters and correct, final padding; lenient mode skips characters
/// outside the alphabet, ignores `=` that can't be padding and stops at the first complete padding. Neither checks
/// that the unused low bits of the last character are zero (`CPython` doesn't).
///
/// # Errors
/// [`Base64Error`], as `CPython` raises `binascii.Error`.
pub fn decode_python(input: &[u8], strict: bool) -> Result<Vec<u8>, Base64Error> {
    if strict && input.first() == Some(&b'=') {
        return Err(Base64Error::LeadingPadding);
    }
    let mut out = Vec::with_capacity((input.len() / 4).saturating_mul(3).saturating_add(3));
    let mut quad: u8 = 0;
    let mut left: u8 = 0;
    let mut pads: u8 = 0;
    let mut padding_started = false;
    for (i, &c) in input.iter().enumerate() {
        if c == b'=' {
            padding_started = true;
            if strict && quad == 0 {
                return Err(Base64Error::ExcessPadding);
            }
            if quad >= 2 {
                pads = pads.saturating_add(1);
                if quad.saturating_add(pads) >= 4 {
                    if strict && i.saturating_add(1) < input.len() {
                        return Err(Base64Error::DataAfterPadding);
                    }
                    return Ok(out);
                }
            }
            continue;
        }
        let Some(v) = value(c) else {
            if strict {
                return Err(Base64Error::NotBase64 { at: i });
            }
            continue;
        };
        if strict && padding_started {
            return Err(Base64Error::DiscontinuousPadding { at: i });
        }
        pads = 0;
        match quad {
            0 => {
                quad = 1;
                left = v;
            }
            1 => {
                quad = 2;
                out.push(left.wrapping_shl(2) | v.wrapping_shr(4));
                left = v & 0x0F;
            }
            2 => {
                quad = 3;
                out.push(left.wrapping_shl(4) | v.wrapping_shr(2));
                left = v & 0x03;
            }
            _ => {
                quad = 0;
                out.push(left.wrapping_shl(6) | v);
                left = 0;
            }
        }
    }
    match quad {
        0 => Ok(out),
        1 => Err(Base64Error::OneExtraCharacter),
        _ => Err(Base64Error::IncorrectPadding),
    }
}

/// The WHATWG forgiving-base64 decode (as browsers decode `data:` URLs): ASCII whitespace removed, one or two final
/// `=` allowed when the length is a multiple of 4, padding otherwise optional, anything else outside the alphabet a
/// failure. Leftover bits are discarded.
#[must_use]
pub fn decode_forgiving(input: &[u8]) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = input
        .iter()
        .copied()
        .filter(|c| !matches!(c, b'\t' | b'\n' | 0x0C | b'\r' | b' '))
        .collect();
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len().saturating_sub(2));
        } else if data.ends_with(b"=") {
            data.truncate(data.len().saturating_sub(1));
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity((data.len() / 4).saturating_mul(3).saturating_add(2));
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &c in &data {
        let v = value(c)?;
        buffer = buffer.wrapping_shl(6) | u32::from(v);
        bits = bits.saturating_add(6);
        if bits >= 8 {
            bits = bits.saturating_sub(8);
            let [low, ..] = buffer.wrapping_shr(bits).to_le_bytes();
            out.push(low);
            buffer &= 1u32.wrapping_shl(bits).wrapping_sub(1);
        }
    }
    Some(out)
}

/// Standard base64 (RFC 4648 §4) with `=` padding.
#[must_use]
pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3).saturating_mul(4));
    for group in data.chunks(3) {
        let [a, b, c] = match *group {
            [a] => [a, 0, 0],
            [a, b] => [a, b, 0],
            [a, b, c, ..] => [a, b, c],
            [] => break,
        };
        let n = u32::from_be_bytes([0, a, b, c]);
        let chars = [18u32, 12, 6, 0].map(|shift| {
            let index = n.wrapping_shr(shift) & 0x3F;
            ALPHABET
                .get(usize::try_from(index).unwrap_or(0))
                .copied()
                .map_or('A', char::from)
        });
        let keep = group.len().saturating_add(1);
        for (k, ch) in chars.into_iter().enumerate() {
            out.push(if k < keep { ch } else { '=' });
        }
    }
    out
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    #[test]
    fn python_strict_matches_cpython() {
        // Each case was checked against CPython 3.12's base64.b64decode(s, validate=True).
        let ok: &[(&str, &[u8])] = &[
            ("", b""),
            ("QQ==", b"A"),
            ("QUI=", b"AB"),
            ("QR==", b"A"),
            ("QUJD", b"ABC"),
        ];
        for (s, want) in ok {
            assert_eq!(
                decode_python(s.as_bytes(), true).as_deref(),
                Ok(*want),
                "{s}"
            );
        }
        let bad: &[(&str, Base64Error)] = &[
            ("QQ=", Base64Error::IncorrectPadding),
            ("QUI==", Base64Error::DataAfterPadding),
            ("=QQ", Base64Error::LeadingPadding),
            ("QQ==QQ==", Base64Error::DataAfterPadding),
            ("Q===", Base64Error::OneExtraCharacter),
            ("QU JD", Base64Error::NotBase64 { at: 2 }),
            ("QUJD\n", Base64Error::NotBase64 { at: 4 }),
            ("QQ=Q", Base64Error::DiscontinuousPadding { at: 3 }),
            ("QUJD=", Base64Error::ExcessPadding),
        ];
        for (s, want) in bad {
            assert_eq!(decode_python(s.as_bytes(), true), Err(*want), "{s}");
        }
    }

    #[test]
    fn python_lenient_skips_junk() {
        assert_eq!(decode_python(b"QU\nJD", false).unwrap(), b"ABC");
        assert_eq!(decode_python(b"QQ==QUJD", false).unwrap(), b"A");
        assert_eq!(decode_python(b"=QQ==", false).unwrap(), b"A");
        assert_eq!(
            decode_python(b"QQ=Q", false),
            Err(Base64Error::IncorrectPadding)
        );
    }

    #[test]
    fn forgiving() {
        assert_eq!(decode_forgiving(b"QQ").unwrap(), b"A");
        assert_eq!(decode_forgiving(b" Q Q = = ").unwrap(), b"A");
        assert_eq!(decode_forgiving(b"QUJD").unwrap(), b"ABC");
        assert_eq!(decode_forgiving(b"Q"), None);
        assert_eq!(decode_forgiving(b"QQ=="), Some(b"A".to_vec()));
        assert_eq!(decode_forgiving(b"QQ="), None);
        assert_eq!(decode_forgiving(b"QQ==QQ=="), None);
    }

    #[test]
    fn round_trip() {
        for n in 0..300usize {
            let data: Vec<u8> = (0..n)
                .map(|k| u8::try_from((k * 37 + n) % 256).unwrap())
                .collect();
            let e = encode(&data);
            assert_eq!(decode_python(e.as_bytes(), true).unwrap(), data);
            assert_eq!(decode_forgiving(e.as_bytes()).unwrap(), data);
        }
        assert_eq!(encode(b"AB"), "QUI=");
    }
}
