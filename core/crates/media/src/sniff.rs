//! What a file is, from its first bytes (contract §4.3 Ingest: "recognized by their bytes, not the name"; §4.4
//! Upload: "sniffed from its bytes"; §2.8 Bodies).
//!
//! The image rules are v1's `midstudy-calib ingest` (`sniff` in `calib/src/midstudy_calib/ingest.py`), which reads
//! the first 64 bytes; the server (`image_kind` in `planner/serve.py`) used a coarser HEIF rule, and v2 uses this
//! one in both places (the differences are listed in `docs/notes/k-media.md`).

use crate::bytes::be32;

/// What [`sniff`] recognises.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// `FF D8 FF`.
    Jpeg,
    /// The 8-byte PNG signature.
    Png,
    /// An ISO-BMFF `ftyp` box whose major brand is an HEVC still-image brand (`heic`, `heix`, `hevc`, …).
    Heic,
    /// An `ftyp` box with a generic HEIF major brand (`mif1`, `msf1`, `mif2`, `miaf`) that isn't AVIF-only.
    Heif,
    /// `RIFF` … `WEBP`.
    Webp,
    /// `glTF` (binary glTF).
    Glb,
    /// A zip local-file header (`PK 03 04`) or an empty archive's end record (`PK 05 06`).
    Zip,
    /// Anything else (AVIF included).
    Unknown,
}

/// How many leading bytes [`sniff`] looks at (v1's ingest reads `data[:64]`).
pub const HEAD_LEN: usize = 64;

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const HEVC_BRANDS: [&[u8; 4]; 8] = [
    b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs",
];
const GENERIC_BRANDS: [&[u8; 4]; 4] = [b"mif1", b"msf1", b"mif2", b"miaf"];
const AVIF_BRANDS: [&[u8; 4]; 2] = [b"avif", b"avis"];

/// `head[at..at + 4] == tag`.
fn tag_at(head: &[u8], at: usize, tag: [u8; 4]) -> bool {
    head.get(at..).and_then(<[u8]>::first_chunk::<4>) == Some(&tag)
}

/// The file type from its first [`HEAD_LEN`] bytes (more are ignored), exactly as v1's ingest decides it.
#[must_use]
pub fn sniff(data: &[u8]) -> Kind {
    let head = data.get(..HEAD_LEN).unwrap_or(data);
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Kind::Jpeg;
    }
    if head.starts_with(&PNG_SIGNATURE) {
        return Kind::Png;
    }
    if head.starts_with(b"RIFF") && tag_at(head, 8, *b"WEBP") {
        return Kind::Webp;
    }
    if tag_at(head, 4, *b"ftyp")
        && head.len() >= 12
        && let Some(kind) = heif(head)
    {
        return kind;
    }
    if head.starts_with(b"glTF") {
        return Kind::Glb;
    }
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return Kind::Zip;
    }
    Kind::Unknown
}

/// The HEIF decision on an `ftyp` box: the major brand, then (for a generic one) the compatible brands found in
/// `head` (the box's own size bounds them, as in v1: `range(16, min(size, len(head)) - 3, 4)`).
fn heif(head: &[u8]) -> Option<Kind> {
    let major = head.get(8..).and_then(<[u8]>::first_chunk::<4>)?;
    if HEVC_BRANDS.contains(&major) {
        return Some(Kind::Heic);
    }
    if !GENERIC_BRANDS.contains(&major) {
        return None;
    }
    let size = usize::try_from(be32(head, 0)?).unwrap_or(usize::MAX);
    let limit = size.min(head.len());
    let compat = head.get(16..limit).unwrap_or_default();
    let mut avif = false;
    let mut hevc = false;
    for brand in compat.chunks_exact(4).filter_map(<[u8]>::first_chunk::<4>) {
        avif |= AVIF_BRANDS.contains(&brand);
        hevc |= HEVC_BRANDS.contains(&brand);
    }
    if avif && !hevc {
        None
    } else {
        Some(Kind::Heif)
    }
}

impl Kind {
    /// The `ext` v1 records for an accepted photo upload (`source.<ext>`, scene.json's `upload.ext`): `jpg`, `png`,
    /// `heic` (HEIC and HEIF alike) or `webp`; `None` for anything that isn't an accepted photo.
    #[must_use]
    pub const fn photo_ext(self) -> Option<&'static str> {
        match self {
            Kind::Jpeg => Some("jpg"),
            Kind::Png => Some("png"),
            Kind::Heic | Kind::Heif => Some("heic"),
            Kind::Webp => Some("webp"),
            Kind::Glb | Kind::Zip | Kind::Unknown => None,
        }
    }

    /// A short lowercase name: `jpeg`, `png`, `heic`, `heif`, `webp`, `glb`, `zip` or `unknown`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Kind::Jpeg => "jpeg",
            Kind::Png => "png",
            Kind::Heic => "heic",
            Kind::Heif => "heif",
            Kind::Webp => "webp",
            Kind::Glb => "glb",
            Kind::Zip => "zip",
            Kind::Unknown => "unknown",
        }
    }
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

    fn ftyp(major: &[u8; 4], compat: &[&[u8; 4]]) -> Vec<u8> {
        let size = u32::try_from(16 + 4 * compat.len()).unwrap();
        let mut v = size.to_be_bytes().to_vec();
        v.extend_from_slice(b"ftyp");
        v.extend_from_slice(major);
        v.extend_from_slice(&[0, 0, 0, 0]);
        for c in compat {
            v.extend_from_slice(*c);
        }
        v.extend_from_slice(&[0; 32]);
        v
    }

    #[test]
    fn magic_bytes() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Kind::Jpeg);
        assert_eq!(sniff(&[0xFF, 0xD8]), Kind::Unknown);
        assert_eq!(sniff(&PNG_SIGNATURE), Kind::Png);
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Kind::Webp);
        assert_eq!(sniff(b"glTF\x02\0\0\0"), Kind::Glb);
        assert_eq!(sniff(b"PK\x03\x04rest"), Kind::Zip);
        assert_eq!(sniff(b""), Kind::Unknown);
    }

    #[test]
    fn heif_brands() {
        assert_eq!(sniff(&ftyp(b"heic", &[b"mif1", b"heic"])), Kind::Heic);
        assert_eq!(sniff(&ftyp(b"hevs", &[])), Kind::Heic);
        assert_eq!(sniff(&ftyp(b"mif1", &[b"heic"])), Kind::Heif);
        assert_eq!(sniff(&ftyp(b"mif1", &[b"avif"])), Kind::Unknown);
        assert_eq!(sniff(&ftyp(b"mif1", &[b"avif", b"heic"])), Kind::Heif);
        assert_eq!(sniff(&ftyp(b"avif", &[b"mif1"])), Kind::Unknown);
        assert_eq!(sniff(&ftyp(b"mif2", &[])), Kind::Heif);
    }

    #[test]
    fn compat_brands_only_inside_the_box_and_the_head() {
        // A box that claims 16 bytes has no compatible brands, even if "avif" follows it.
        let mut v = ftyp(b"mif1", &[b"avif"]);
        v[3] = 16;
        assert_eq!(sniff(&v), Kind::Heif);
        // A compatible brand past byte 64 isn't seen (the box is 64 bytes of mif1 brands, then "avif").
        let mut long = ftyp(b"mif1", &[b"mif1"; 12]);
        long[64..68].copy_from_slice(b"avif");
        long[0..4].copy_from_slice(&200u32.to_be_bytes());
        assert_eq!(sniff(&long), Kind::Heif);
        long[60..64].copy_from_slice(b"avif");
        assert_eq!(sniff(&long), Kind::Unknown);
    }
}
