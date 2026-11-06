//! JPEG: metadata stripping, the frame size and the ingest pass-through predicate.
//!
//! - [`strip`] (contract §2.6 Render API, §2.8 Privacy): drops APP1–APP15 (EXIF, GPS, XMP, ICC, MPF, Adobe, IPTC),
//!   COM and everything after EOI, wherever they are (before the first scan or between progressive scans); keeps
//!   APP0 only as a plain 16-byte JFIF header (a JFIF thumbnail or a JFXX extension, which can hold a whole JPEG
//!   with its own EXIF and GPS, is dropped); copies everything else (tables, frame and scan headers, the
//!   entropy-coded data with its stuffed bytes and restart markers, TEM, RST0–7) byte for byte: no re-encode.
//!   Fill bytes before a marker are dropped. v1: `clean_jpeg` in `planner/serve.py` and
//!   `pipeline/src/midstudy_pipeline/glb.py`.
//! - [`frame_info`] (§2.6: "the image's size must be readable from its frame header … never guessed"): the SOF
//!   header's size, stepping over fill bytes and the length-less markers TEM, RST0–7 and a stray SOI. v1:
//!   `jpeg_size` in `planner/serve.py`.
//! - [`is_clean`] and [`passthrough`] (§4.3 Ingest, Pass-through): v1's `is_clean_jpeg` in
//!   `calib/src/midstudy_calib/ingest.py`, plus the frame checks v1 made through Pillow.

use crate::bytes::{be16, byte};
use crate::plan::Plan;

const SOI: [u8; 2] = [0xFF, 0xD8];
const SOS: u8 = 0xDA;
const APP0: u8 = 0xE0;
const COM: u8 = 0xFE;
/// The longest side a JPEG may have to be ingested as it is (contract §4.3: "long side ≤ 2048").
pub const PASSTHROUGH_LONG_SIDE: u16 = 2048;

/// Why [`strip`] or [`is_clean`] refused a JPEG. Offsets are into the input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JpegError {
    /// Shorter than 4 bytes, or not starting with SOI (`FF D8`).
    NotJpeg,
    /// A byte other than `FF` where a marker must start.
    ExpectedMarker {
        /// Offset of the byte.
        at: usize,
    },
    /// `FF 00` where a marker must be.
    BadMarker {
        /// Offset of the `00`.
        at: usize,
    },
    /// A segment length below 2.
    BadLength {
        /// Offset of the length field.
        at: usize,
    },
    /// The data ends inside a marker, a segment or a scan.
    Truncated {
        /// Offset of the marker, segment or byte that runs past the end.
        at: usize,
    },
    /// The data ends without an end-of-image marker.
    NoEndOfImage,
}

impl core::fmt::Display for JpegError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            JpegError::NotJpeg => write!(f, "not a JPEG (no start-of-image marker)"),
            JpegError::ExpectedMarker { at } => write!(f, "expected a marker at byte {at}"),
            JpegError::BadMarker { at } => write!(f, "an invalid marker (FF 00) at byte {at}"),
            JpegError::BadLength { at } => write!(f, "a segment length below 2 at byte {at}"),
            JpegError::Truncated { at } => write!(f, "the JPEG is cut off (at byte {at})"),
            JpegError::NoEndOfImage => write!(f, "the JPEG has no end-of-image marker"),
        }
    }
}

/// What [`strip`] removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Removed {
    /// APP1–APP15 segments (EXIF, GPS, XMP, ICC, MPF, Adobe, IPTC, …).
    pub app_segments: usize,
    /// APP0 segments dropped whole: JFXX extensions, other APP0 uses, and JFIF headers shorter than 16 bytes.
    pub app0_segments: usize,
    /// JFIF headers rewritten to a plain 16-byte header (their thumbnail or extra bytes dropped).
    pub jfif_trimmed: usize,
    /// COM segments.
    pub comments: usize,
    /// Fill bytes (`FF`) before markers.
    pub fill_bytes: usize,
    /// Bytes after the end-of-image marker (an appended second image, padding, a trailer).
    pub trailing_bytes: usize,
}

impl Removed {
    /// Whether the output differs from the input: every byte [`strip`] drops or rewrites is counted above, so this
    /// is exact without comparing the bytes.
    #[must_use]
    pub fn any(&self) -> bool {
        *self != Removed::default()
    }
}

/// A JPEG without its metadata, and what was removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stripped {
    /// The JPEG: SOI, the kept segments and scans in their order, EOI.
    pub bytes: Vec<u8>,
    /// What was removed.
    pub removed: Removed,
}

const fn is_rst(m: u8) -> bool {
    matches!(m, 0xD0..=0xD7)
}

/// Markers without a length: RST0–7 and TEM (v1's `clean_jpeg` and `jpeg_walk`; `frame_info` also skips SOI).
const fn standalone(m: u8) -> bool {
    is_rst(m) || m == 0x01
}

/// APP1–APP15 and COM: always metadata.
const fn is_metadata(m: u8) -> bool {
    matches!(m, 0xE1..=0xEF) || m == COM
}

/// A start-of-frame marker: C0–CF except DHT (C4), JPG (C8) and DAC (CC).
const fn is_sof(m: u8) -> bool {
    matches!(m, 0xC0..=0xCF) && !matches!(m, 0xC4 | 0xC8 | 0xCC)
}

/// One step of the walk over a JPEG's markers.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Item {
    /// EOI; `end` is the offset just past it.
    Eoi { end: usize },
    /// A marker without a length (RST0–7, TEM).
    Standalone(#[cfg_attr(not(kani), allow(dead_code, reason = "the Kani harnesses check it"))] u8),
    /// A marker segment other than SOS: `data[start..end]` is its two length bytes and its payload.
    Segment {
        marker: u8,
        start: usize,
        end: usize,
    },
    /// SOS: `data[start..end]` is the scan header (length bytes and payload) and `data[end..scan_end]` the
    /// entropy-coded data after it (stuffed bytes and restart markers included).
    Scan { start: usize, scan_end: usize },
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Step {
    pub(crate) item: Item,
    /// Fill bytes before the marker.
    pub(crate) fill: usize,
    /// Where the next marker starts.
    pub(crate) next: usize,
}

/// The marker at `at` (after any fill bytes), as v1's `clean_jpeg` / `jpeg_walk` loop body reads it.
pub(crate) fn step(data: &[u8], at: usize) -> Result<Step, JpegError> {
    let rest = data
        .get(at..)
        .filter(|r| !r.is_empty())
        .ok_or(JpegError::NoEndOfImage)?;
    if rest.first() != Some(&0xFF) {
        return Err(JpegError::ExpectedMarker { at });
    }
    let ffs = rest
        .iter()
        .position(|&b| b != 0xFF)
        .ok_or(JpegError::Truncated { at })?;
    let marker_at = at.checked_add(ffs).ok_or(JpegError::Truncated { at })?;
    let marker = byte(data, marker_at).ok_or(JpegError::Truncated { at })?;
    let fill = ffs.saturating_sub(1);
    let i = marker_at
        .checked_add(1)
        .ok_or(JpegError::Truncated { at })?;
    if marker == 0xD9 {
        return Ok(Step {
            item: Item::Eoi { end: i },
            fill,
            next: i,
        });
    }
    if standalone(marker) {
        return Ok(Step {
            item: Item::Standalone(marker),
            fill,
            next: i,
        });
    }
    if marker == 0x00 {
        return Err(JpegError::BadMarker { at: marker_at });
    }
    let length = be16(data, i).ok_or(JpegError::Truncated { at: marker_at })?;
    if length < 2 {
        return Err(JpegError::BadLength { at: i });
    }
    let end = i
        .checked_add(usize::from(length))
        .filter(|&e| e <= data.len())
        .ok_or(JpegError::Truncated { at: marker_at })?;
    if marker == SOS {
        let scan_end = scan_end(data, end)?;
        return Ok(Step {
            item: Item::Scan { start: i, scan_end },
            fill,
            next: scan_end,
        });
    }
    Ok(Step {
        item: Item::Segment {
            marker,
            start: i,
            end,
        },
        fill,
        next: end,
    })
}

/// The end of the entropy-coded data that starts at `from`: the next `FF` that isn't a stuffed byte (`FF 00`) or a
/// restart marker (`FF D0`–`FF D7`). An `FF` in the last byte, or no `FF` at all, is a cut-off scan.
pub(crate) fn scan_end(data: &[u8], from: usize) -> Result<usize, JpegError> {
    let mut j = from;
    loop {
        let rest = data.get(j..).ok_or(JpegError::Truncated { at: j })?;
        let k = find_ff(rest).ok_or(JpegError::Truncated { at: from })?;
        let ff = j.checked_add(k).ok_or(JpegError::Truncated { at: from })?;
        let after = ff.checked_add(1).ok_or(JpegError::Truncated { at: ff })?;
        let next = byte(data, after).ok_or(JpegError::Truncated { at: ff })?;
        if next == 0x00 || is_rst(next) {
            j = after
                .checked_add(1)
                .ok_or(JpegError::Truncated { at: ff })?;
        } else {
            return Ok(ff);
        }
    }
}

/// The first `0xFF` in `hay` ([`find_ff_blocks`]).
#[cfg(not(kani))]
fn find_ff(hay: &[u8]) -> Option<usize> {
    find_ff_blocks(hay)
}

/// Under Kani the walk is verified with the plain scan, which CBMC handles in milliseconds;
/// `proofs::find_ff_blocks_is_position` proves [`find_ff_blocks`] equal to it.
#[cfg(kani)]
fn find_ff(hay: &[u8]) -> Option<usize> {
    hay.iter().position(|&b| b == 0xFF)
}

/// The first `0xFF` in `hay`: `hay.iter().position(|&b| b == 0xFF)`, but each 64-byte block is first tested with a
/// max-reduction without an early exit, which the compiler turns into SIMD (NEON natively, SIMD128 in wasm when
/// enabled). The entropy-coded data is nearly all of a JPEG, so this scan is the strip's cost: on a 12 MP JPEG it
/// took the strip from 4x slower than `CPython`'s `bytes.find` (a vectorized memchr) to 3x faster.
pub(crate) fn find_ff_blocks(hay: &[u8]) -> Option<usize> {
    const BLOCK: usize = 64;
    let mut blocks = hay.chunks_exact(BLOCK);
    let mut base = 0usize;
    for block in &mut blocks {
        if block.iter().fold(0u8, |m, &b| m.max(b)) == 0xFF {
            return block
                .iter()
                .position(|&b| b == 0xFF)
                .map(|k| base.saturating_add(k));
        }
        base = base.saturating_add(BLOCK);
    }
    blocks
        .remainder()
        .iter()
        .position(|&b| b == 0xFF)
        .map(|k| base.saturating_add(k))
}

fn starts_jpeg(data: &[u8]) -> bool {
    data.len() >= 4 && data.starts_with(&SOI)
}

/// An APP0 segment (its two length bytes and payload) as a plain 16-byte JFIF header with a 0×0 thumbnail, or `None`
/// when it should go: only a JFIF header of at least 16 bytes is kept (v1's `plain_jfif` in `planner/serve.py`).
fn plain_jfif(seg: &[u8]) -> Option<[u8; 16]> {
    let head = seg.first_chunk::<16>()?;
    if head.get(2..7) != Some(b"JFIF\0".as_slice()) {
        return None;
    }
    // FF E0 00 10, "JFIF\0", version, units, x and y density (seg[2..14]), then a 0 x 0 thumbnail.
    Some(core::array::from_fn(|k| match k {
        1 => 16,
        2..=13 => head.get(k).copied().unwrap_or(0),
        _ => 0,
    }))
}

/// The JPEG without its metadata (see the module docs), or why it isn't a well-formed JPEG.
///
/// # Errors
/// [`JpegError`] when the data isn't a JPEG, a segment or scan is cut off or malformed, or there is no EOI: v1 refused
/// exactly these (`clean_jpeg` returned `None`).
pub fn strip(data: &[u8]) -> Result<Stripped, JpegError> {
    let (plan, removed) = strip_plan(data)?;
    Ok(Stripped {
        bytes: plan.apply(data),
        removed,
    })
}

/// What [`strip`] writes, as a [`Plan`] over `data`, and what it removed: every kept marker, segment and scan is one
/// range of the input (the `FF` before its marker included; fill bytes before it are not), and a JFIF header cut back
/// to 16 bytes is the plan's only bytes of its own. `strip(data)` is exactly `plan.apply(data)`.
///
/// # Errors
/// As [`strip`].
pub fn strip_plan(data: &[u8]) -> Result<(Plan, Removed), JpegError> {
    if !starts_jpeg(data) {
        return Err(JpegError::NotJpeg);
    }
    let mut plan = Plan::default();
    plan.copy(0, SOI.len());
    let mut removed = Removed::default();
    let mut at = SOI.len();
    loop {
        let s = step(data, at)?;
        removed.fill_bytes = removed.fill_bytes.saturating_add(s.fill);
        // The marker's own FF is the byte before the marker (at + fill); the item's bytes run from it to `next`.
        let marker_ff = at.saturating_add(s.fill);
        match s.item {
            Item::Eoi { end } => {
                plan.copy(marker_ff, end);
                removed.trailing_bytes = data.len().saturating_sub(end);
                return Ok((plan, removed));
            }
            Item::Standalone(_) => plan.copy(marker_ff, s.next),
            Item::Scan { start, scan_end } => {
                // The marker's FF, SOS, the scan header (from `start`) and the entropy-coded data up to `scan_end`.
                debug_assert!(marker_ff < start && start <= scan_end);
                plan.copy(marker_ff, scan_end);
            }
            Item::Segment { marker, start, end } => {
                let seg = data
                    .get(start..end)
                    .ok_or(JpegError::Truncated { at: start })?;
                if marker == APP0 {
                    if let Some(header) = plain_jfif(seg) {
                        if header.as_slice() == seg {
                            plan.copy(marker_ff, end);
                        } else {
                            removed.jfif_trimmed = removed.jfif_trimmed.saturating_add(1);
                            let bytes: Vec<u8> = [0xFF, APP0].into_iter().chain(header).collect();
                            plan.bytes(&bytes);
                        }
                    } else {
                        removed.app0_segments = removed.app0_segments.saturating_add(1);
                    }
                } else if marker == COM {
                    removed.comments = removed.comments.saturating_add(1);
                } else if is_metadata(marker) {
                    removed.app_segments = removed.app_segments.saturating_add(1);
                } else {
                    plan.copy(marker_ff, end);
                }
            }
        }
        at = s.next;
    }
}

fn is_plain_jfif(seg: &[u8]) -> bool {
    seg.len() == 16
        && seg.starts_with(&[0x00, 0x10])
        && seg.get(2..7) == Some(b"JFIF\0".as_slice())
        && seg.get(14..16) == Some([0, 0].as_slice())
}

/// True when the JPEG carries no metadata at all and is well formed (contract §4.3 Pass-through, the structural
/// part): APP0 only as plain 16-byte JFIF headers, no APP1–APP15 or COM anywhere (between progressive scans too), and
/// not one byte after EOI. Fill bytes are allowed. v1: `is_clean_jpeg` in `calib/src/midstudy_calib/ingest.py`.
#[must_use]
pub fn is_clean(data: &[u8]) -> bool {
    if !starts_jpeg(data) {
        return false;
    }
    let mut at = SOI.len();
    loop {
        let Ok(s) = step(data, at) else { return false };
        match s.item {
            Item::Eoi { end } => return end == data.len(),
            Item::Standalone(_) | Item::Scan { .. } => {}
            Item::Segment { marker, start, end } => {
                if is_metadata(marker) {
                    return false;
                }
                if marker == APP0 && !data.get(start..end).is_some_and(is_plain_jfif) {
                    return false;
                }
            }
        }
        at = s.next;
    }
}

/// A JPEG's frame header (SOF).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameInfo {
    /// Samples per line.
    pub width: u16,
    /// Lines.
    pub height: u16,
    /// Number of components (1 grey, 3 colour, 4 CMYK).
    pub components: u8,
    /// Sample precision in bits.
    pub precision: u8,
    /// The SOF marker (C0 baseline, C1 extended, C2 progressive, …).
    pub marker: u8,
}

/// Why [`frame_info`] couldn't read a size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeError {
    /// Shorter than 4 bytes or not starting with SOI.
    NotJpeg,
    /// A byte other than `FF` where a marker must start.
    ExpectedMarker {
        /// Offset of the byte.
        at: usize,
    },
    /// A scan (SOS) before any frame header.
    ScanBeforeFrame {
        /// Offset of the marker.
        at: usize,
    },
    /// EOI before any frame header.
    EndBeforeFrame {
        /// Offset of the marker.
        at: usize,
    },
    /// A segment too close to the end to hold a frame header, or cut off.
    Truncated {
        /// Offset of the marker.
        at: usize,
    },
    /// A segment length below 2.
    BadLength {
        /// Offset of the marker.
        at: usize,
    },
    /// A frame header with a zero width or height (the height would come later, in a DNL segment).
    ZeroSize,
    /// No frame header before the data ran out.
    NoFrame,
}

impl core::fmt::Display for SizeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SizeError::NotJpeg => write!(f, "not a JPEG (no start-of-image marker)"),
            SizeError::ExpectedMarker { at } => write!(f, "expected a marker at byte {at}"),
            SizeError::ScanBeforeFrame { at } => {
                write!(f, "a scan before the frame header (byte {at})")
            }
            SizeError::EndBeforeFrame { at } => {
                write!(f, "the image ends before its frame header (byte {at})")
            }
            SizeError::Truncated { at } => {
                write!(f, "the JPEG is cut off before its frame header (byte {at})")
            }
            SizeError::BadLength { at } => write!(f, "a segment length below 2 (byte {at})"),
            SizeError::ZeroSize => write!(f, "the frame header gives no size"),
            SizeError::NoFrame => write!(f, "the JPEG has no frame header"),
        }
    }
}

/// The frame header of a JPEG: the first SOF before any scan, read exactly as v1's `jpeg_size` reads it (fill bytes
/// and the length-less markers TEM, RST0–7 and SOI are stepped over). Never a guess (contract §2.6).
///
/// # Errors
/// [`SizeError`] when no frame header can be read before the first scan or the end of the image, or it has a zero
/// width or height.
pub fn frame_info(data: &[u8]) -> Result<FrameInfo, SizeError> {
    if !starts_jpeg(data) {
        return Err(SizeError::NotJpeg);
    }
    let n = data.len();
    let mut i = SOI.len();
    while i.checked_add(1).is_some_and(|k| k < n) {
        if byte(data, i) != Some(0xFF) {
            return Err(SizeError::ExpectedMarker { at: i });
        }
        let marker = byte(data, i.saturating_add(1)).ok_or(SizeError::Truncated { at: i })?;
        if marker == 0xFF {
            i = i.saturating_add(1);
            continue;
        }
        if marker == 0x01 || marker == 0xD8 || is_rst(marker) {
            i = i.saturating_add(2);
            continue;
        }
        if marker == 0xD9 {
            return Err(SizeError::EndBeforeFrame { at: i });
        }
        if marker == SOS {
            return Err(SizeError::ScanBeforeFrame { at: i });
        }
        // v1: `i + 9 >= len(data)` refuses any segment that couldn't hold a frame header's fields.
        if i.checked_add(9).is_none_or(|k| k >= n) {
            return Err(SizeError::Truncated { at: i });
        }
        let length = be16(data, i.saturating_add(2)).ok_or(SizeError::Truncated { at: i })?;
        if length < 2 {
            return Err(SizeError::BadLength { at: i });
        }
        if is_sof(marker) {
            let precision =
                byte(data, i.saturating_add(4)).ok_or(SizeError::Truncated { at: i })?;
            let height = be16(data, i.saturating_add(5)).ok_or(SizeError::Truncated { at: i })?;
            let width = be16(data, i.saturating_add(7)).ok_or(SizeError::Truncated { at: i })?;
            let components =
                byte(data, i.saturating_add(9)).ok_or(SizeError::Truncated { at: i })?;
            if width == 0 || height == 0 {
                return Err(SizeError::ZeroSize);
            }
            return Ok(FrameInfo {
                width,
                height,
                components,
                precision,
                marker,
            });
        }
        i = i
            .checked_add(2)
            .and_then(|k| k.checked_add(usize::from(length)))
            .ok_or(SizeError::Truncated { at: i })?;
    }
    Err(SizeError::NoFrame)
}

/// Why [`passthrough`] says a JPEG must be re-encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reencode {
    /// It carries metadata, or isn't well formed ([`is_clean`] is false).
    NotClean,
    /// Its frame header can't be read.
    Frame(SizeError),
    /// Not 8-bit samples.
    Precision(u8),
    /// Not three colour components (grey and CMYK are converted to sRGB colour).
    Components(u8),
    /// Its long side is over [`PASSTHROUGH_LONG_SIDE`].
    TooLarge {
        /// Width in pixels.
        width: u16,
        /// Height in pixels.
        height: u16,
    },
}

impl core::fmt::Display for Reencode {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Reencode::NotClean => write!(f, "the JPEG carries metadata or isn't well formed"),
            Reencode::Frame(e) => write!(f, "{e}"),
            Reencode::Precision(p) => write!(f, "{p}-bit samples"),
            Reencode::Components(c) => write!(f, "{c} colour components, not 3"),
            Reencode::TooLarge { width, height } => {
                write!(
                    f,
                    "{width} x {height} is over {PASSTHROUGH_LONG_SIDE} px on its long side"
                )
            }
        }
    }
}

/// Whether ingest may copy this JPEG to `photo.jpg` byte for byte (contract §4.3 Pass-through): [`is_clean`], an
/// 8-bit, three-component frame (Pillow mode RGB; grey and CMYK are re-encoded), long side ≤ 2048 px. Returns the
/// frame. v1 (`ingest` in `calib/src/midstudy_calib/ingest.py`) also decoded the whole image with Pillow and
/// refused the upload when that failed; that check needs a decoder and stays with the caller.
///
/// # Errors
/// [`Reencode`]: why the JPEG must be re-encoded instead.
pub fn passthrough(data: &[u8]) -> Result<FrameInfo, Reencode> {
    if !is_clean(data) {
        return Err(Reencode::NotClean);
    }
    let info = frame_info(data).map_err(Reencode::Frame)?;
    if info.precision != 8 {
        return Err(Reencode::Precision(info.precision));
    }
    if info.components != 3 {
        return Err(Reencode::Components(info.components));
    }
    if info.width.max(info.height) > PASSTHROUGH_LONG_SIDE {
        return Err(Reencode::TooLarge {
            width: info.width,
            height: info.height,
        });
    }
    Ok(info)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
pub(crate) mod tests {
    use super::*;

    const EOI: [u8; 2] = [0xFF, 0xD9];

    fn seg(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![0xFF, marker];
        v.extend_from_slice(&u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
        v.extend_from_slice(payload);
        v
    }

    fn jfif(thumb: &[u8]) -> Vec<u8> {
        let mut p = b"JFIF\0\x01\x01\x00\x00\x48\x00\x48".to_vec();
        if thumb.is_empty() {
            p.extend_from_slice(&[0, 0]);
        } else {
            p.extend_from_slice(&[1, 1]);
            p.extend_from_slice(thumb);
        }
        seg(APP0, &p)
    }

    fn sof(w: u16, h: u16, components: u8) -> Vec<u8> {
        let mut p = vec![8];
        p.extend_from_slice(&h.to_be_bytes());
        p.extend_from_slice(&w.to_be_bytes());
        p.push(components);
        for c in 0..components {
            p.extend_from_slice(&[c + 1, 0x11, 0]);
        }
        seg(0xC0, &p)
    }

    /// A small structurally valid JPEG: JFIF, DQT, SOF0, DHT, one scan with stuffed bytes and restart markers.
    pub(crate) fn tiny(w: u16, h: u16) -> Vec<u8> {
        let mut v = SOI.to_vec();
        v.extend(jfif(&[]));
        v.extend(seg(0xDB, &[0; 65]));
        v.extend(sof(w, h, 3));
        v.extend(seg(0xC4, &[0; 20]));
        v.extend(seg(SOS, &[3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0]));
        v.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xD7, 0x78]);
        v.extend_from_slice(&EOI);
        v
    }

    #[test]
    fn clean_jpeg_is_unchanged() {
        let j = tiny(10, 20);
        assert!(is_clean(&j));
        let s = strip(&j).unwrap();
        assert_eq!(s.bytes, j);
        assert_eq!(s.removed, Removed::default());
        let f = frame_info(&j).unwrap();
        assert_eq!((f.width, f.height, f.components), (10, 20, 3));
        assert_eq!(passthrough(&j), Ok(f));
    }

    #[test]
    fn metadata_goes() {
        let clean = tiny(4, 4);
        let mut j = clean[..2].to_vec();
        j.extend(jfif(&[9; 3]));
        j.extend(seg(0xE1, b"Exif\0\0GPS"));
        j.extend(seg(0xFE, b"comment"));
        j.extend(seg(0xE0, b"JFXX\0\x10thumb"));
        j.push(0xFF);
        j.extend_from_slice(&clean[20..]);
        j.extend_from_slice(b"trailing GPS");
        let s = strip(&j).unwrap();
        assert_eq!(s.bytes, clean);
        assert_eq!(
            s.removed,
            Removed {
                app_segments: 1,
                app0_segments: 1,
                jfif_trimmed: 1,
                comments: 1,
                fill_bytes: 1,
                trailing_bytes: 12
            }
        );
        assert!(!is_clean(&j));
        assert_eq!(passthrough(&j), Err(Reencode::NotClean));
    }

    #[test]
    fn metadata_between_scans_goes() {
        let clean = tiny(4, 4);
        let eoi = clean.len() - 2;
        let mut j = clean[..eoi].to_vec();
        j.extend(seg(0xE1, b"Exif\0\0between scans"));
        j.extend(seg(SOS, &[1, 1, 0, 0, 0x3F, 0]));
        j.extend_from_slice(&[1, 2, 3]);
        j.extend_from_slice(&EOI);
        let mut want = clean[..eoi].to_vec();
        want.extend(seg(SOS, &[1, 1, 0, 0, 0x3F, 0]));
        want.extend_from_slice(&[1, 2, 3]);
        want.extend_from_slice(&EOI);
        assert_eq!(strip(&j).unwrap().bytes, want);
        assert!(!is_clean(&j));
        assert!(is_clean(&want));
    }

    #[test]
    fn broken_jpegs_are_refused() {
        let j = tiny(4, 4);
        assert!(matches!(
            strip(&j[..j.len() - 2]),
            Err(JpegError::Truncated { .. })
        ));
        assert_eq!(strip(&[0xFF, 0xD8, 0xFF]), Err(JpegError::NotJpeg));
        assert_eq!(
            strip(&[0xFF, 0xD8, 0x00, 0x00]),
            Err(JpegError::ExpectedMarker { at: 2 })
        );
        assert_eq!(
            strip(&[0xFF, 0xD8, 0xFF, 0x00]),
            Err(JpegError::BadMarker { at: 3 })
        );
        assert_eq!(
            strip(&[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x01]),
            Err(JpegError::BadLength { at: 4 })
        );
        assert_eq!(
            strip(&[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x09]),
            Err(JpegError::Truncated { at: 3 })
        );
        assert_eq!(
            strip(&[0xFF, 0xD8, 0xFF, 0xD0]),
            Err(JpegError::NoEndOfImage)
        );
        assert_eq!(
            strip(&[0xFF, 0xD8, 0xFF, 0xFF]),
            Err(JpegError::Truncated { at: 2 })
        );
        assert!(!is_clean(&j[..j.len() - 1]));
    }

    #[test]
    fn frame_size_steps_over_standalone_markers() {
        let mut j = tiny(4000, 3000);
        j.splice(2..2, [0xFF, 0xD0, 0xFF, 0x01, 0xFF, 0xFF, 0xFF, 0xD8]);
        assert_eq!(
            frame_info(&j).map(|f| (f.width, f.height)),
            Ok((4000, 3000))
        );
        // A stray SOI is length-less only for the size (as in v1): the metadata walk refuses it.
        assert_eq!(passthrough(&j), Err(Reencode::NotClean));
        assert_eq!(
            passthrough(&tiny(4000, 3000)),
            Err(Reencode::TooLarge {
                width: 4000,
                height: 3000
            })
        );
        assert_eq!(frame_info(&tiny(0, 5)), Err(SizeError::ZeroSize));
        let scan_first = [0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(
            frame_info(&scan_first),
            Err(SizeError::ScanBeforeFrame { at: 2 })
        );
    }

    #[test]
    fn find_ff_is_position() {
        for len in [0usize, 1, 63, 64, 65, 127, 128, 200] {
            for at in [None, Some(0), Some(len / 2), Some(len.saturating_sub(1))] {
                let mut v = vec![0x12u8; len];
                if let Some(i) = at.filter(|&i| i < len) {
                    v[i] = 0xFF;
                    v.push(0xFF);
                }
                assert_eq!(
                    find_ff(&v),
                    v.iter().position(|&b| b == 0xFF),
                    "{len} {at:?}"
                );
            }
        }
    }

    /// Found by the `jpeg_strip` fuzz target: like v1's `jpeg_size`, `frame_info` reads the frame fields after an SOF
    /// marker even when its segment is too short to hold them (here a length of 2), so they come from the bytes that
    /// follow, and stripping (which drops fill bytes there) changes what it reads. Kept as v1; pinned here.
    #[test]
    fn frame_info_reads_past_a_short_sof_like_v1() {
        let j = [
            0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x02, 0xFF, 0x04, 0x00, 0x02, 0xFF, 0xFF, 0xFF, 0xD9,
        ];
        let f = frame_info(&j).unwrap();
        assert_eq!(
            (f.precision, f.height, f.width, f.components),
            (0xFF, 0x0400, 0x02FF, 0xFF)
        );
        let s = strip(&j).unwrap();
        assert_eq!(s.removed.fill_bytes, 2);
        assert_eq!(frame_info(&s.bytes).unwrap().components, 0xD9);
    }

    #[test]
    fn grey_is_reencoded() {
        let mut j = SOI.to_vec();
        j.extend(sof(8, 8, 1));
        j.extend(seg(SOS, &[1, 1, 0, 0, 0x3F, 0]));
        j.extend_from_slice(&[0, 0xFF, 0xD9]);
        assert!(is_clean(&j));
        assert_eq!(passthrough(&j), Err(Reencode::Components(1)));
    }
}
