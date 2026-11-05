//! PNG: metadata stripping and the IHDR size.
//!
//! - [`strip`] (contract §2.8 Privacy: "PNG: `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`"): drops those chunks and
//!   everything after IEND; every other chunk (IHDR, PLTE, IDAT, iCCP, gAMA, …) is copied byte for byte. v1:
//!   `clean_png` in `pipeline/src/midstudy_pipeline/glb.py`.
//! - [`size`] (§4.7 Keep room: the mask must be at the photo's size): width and height from IHDR. v1: `png_size` in
//!   `planner/serve.py`.

use crate::bytes::{be32, usize_from};

/// The 8-byte PNG signature.
pub const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Why [`strip`] refused a PNG.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PngError {
    /// No PNG signature.
    NotPng,
    /// A chunk runs past the end (`at` is its offset).
    Truncated {
        /// Offset of the chunk.
        at: usize,
    },
    /// The data ends without an IEND chunk.
    NoEnd,
}

impl core::fmt::Display for PngError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            PngError::NotPng => write!(f, "not a PNG (no signature)"),
            PngError::Truncated { at } => write!(
                f,
                "the PNG is cut off (the chunk at byte {at} runs past the end)"
            ),
            PngError::NoEnd => write!(f, "the PNG has no IEND chunk"),
        }
    }
}

/// What [`strip`] removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Removed {
    /// `eXIf` chunks (EXIF, GPS).
    pub exif: usize,
    /// `tEXt`, `iTXt` and `zTXt` chunks (XMP, comments, software, …).
    pub text: usize,
    /// `tIME` chunks.
    pub time: usize,
    /// Bytes after IEND.
    pub trailing_bytes: usize,
}

impl Removed {
    /// Whether the output differs from the input (exact: every dropped byte is counted above).
    #[must_use]
    pub fn any(&self) -> bool {
        *self != Removed::default()
    }
}

/// A PNG without its metadata, and what was removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stripped {
    /// The PNG.
    pub bytes: Vec<u8>,
    /// What was removed.
    pub removed: Removed,
}

/// The PNG without `eXIf`, `tEXt`, `iTXt`, `zTXt` and `tIME` chunks and without anything after IEND. Chunk CRCs are
/// not checked (as in v1): a chunk is kept or dropped whole.
///
/// # Errors
/// [`PngError`] when there's no signature, a chunk runs past the end, or there is no IEND (v1's `clean_png` refused
/// exactly these).
pub fn strip(data: &[u8]) -> Result<Stripped, PngError> {
    if !data.starts_with(&SIGNATURE) {
        return Err(PngError::NotPng);
    }
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&SIGNATURE);
    let mut removed = Removed::default();
    let mut i = SIGNATURE.len();
    while i.checked_add(12).is_some_and(|e| e <= data.len()) {
        let size = be32(data, i)
            .and_then(usize_from)
            .ok_or(PngError::Truncated { at: i })?;
        let kind = data
            .get(i.saturating_add(4)..)
            .and_then(<[u8]>::first_chunk::<4>)
            .ok_or(PngError::Truncated { at: i })?;
        let end = i
            .checked_add(12)
            .and_then(|k| k.checked_add(size))
            .filter(|&e| e <= data.len())
            .ok_or(PngError::Truncated { at: i })?;
        match kind {
            b"eXIf" => removed.exif = removed.exif.saturating_add(1),
            b"tEXt" | b"iTXt" | b"zTXt" => removed.text = removed.text.saturating_add(1),
            b"tIME" => removed.time = removed.time.saturating_add(1),
            _ => out.extend_from_slice(data.get(i..end).ok_or(PngError::Truncated { at: i })?),
        }
        i = end;
        if kind == b"IEND" {
            removed.trailing_bytes = data.len().saturating_sub(end);
            return Ok(Stripped {
                bytes: out,
                removed,
            });
        }
    }
    Err(PngError::NoEnd)
}

/// `(width, height)` from the IHDR chunk, when the data starts with a signature and an IHDR (v1's `png_size`: no
/// further checks, a zero size included).
#[must_use]
pub fn size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24
        || !data.starts_with(&SIGNATURE)
        || data.get(12..16) != Some(b"IHDR".as_slice())
    {
        return None;
    }
    Some((be32(data, 16)?, be32(data, 20)?))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::trivially_copy_pass_by_ref
)]
mod tests {
    use super::*;

    fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v.extend_from_slice(&[1, 2, 3, 4]); // CRC (not checked)
        v
    }

    fn png(extra: &[Vec<u8>]) -> Vec<u8> {
        let mut v = SIGNATURE.to_vec();
        let mut ihdr = 7u32.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&5u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        v.extend(chunk(b"IHDR", &ihdr));
        for e in extra {
            v.extend_from_slice(e);
        }
        v.extend(chunk(b"IDAT", &[0; 10]));
        v.extend(chunk(b"IEND", &[]));
        v
    }

    #[test]
    fn strips_metadata_chunks() {
        let clean = png(&[chunk(b"iCCP", b"profile")]);
        let dirty = {
            let mut v = png(&[
                chunk(b"eXIf", b"MM\0*GPS"),
                chunk(b"iCCP", b"profile"),
                chunk(b"tEXt", b"Comment\0x"),
                chunk(b"iTXt", b"XML:com.adobe.xmp\0"),
                chunk(b"zTXt", b"a\0\0z"),
                chunk(b"tIME", &[0; 7]),
            ]);
            v.extend_from_slice(b"after IEND");
            v
        };
        let s = strip(&dirty).unwrap();
        assert_eq!(s.bytes, clean);
        assert_eq!(
            s.removed,
            Removed {
                exif: 1,
                text: 3,
                time: 1,
                trailing_bytes: 10
            }
        );
        assert_eq!(strip(&clean).unwrap().bytes, clean);
        assert_eq!(size(&clean), Some((7, 5)));
    }

    #[test]
    fn broken_pngs_are_refused() {
        let p = png(&[]);
        assert_eq!(strip(&p[..p.len() - 1]), Err(PngError::NoEnd));
        assert_eq!(strip(b"\x89PNG"), Err(PngError::NotPng));
        let mut huge = SIGNATURE.to_vec();
        huge.extend(chunk(b"IDAT", &[]));
        huge[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(strip(&huge), Err(PngError::Truncated { at: 8 }));
        assert_eq!(size(&p[..23]), None);
    }
}
