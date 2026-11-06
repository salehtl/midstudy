//! The media API with plain types (the `exports` module hands each function to JS under the same name). Each
//! function's doc gives its envelope payload; error codes are kebab-case names, the message is the error's sentence.

use midstudy_media::plan::{Piece, Plan};
use midstudy_media::{datauri, glb, http, jpeg, meta, path, png, slug, sniff, zip};

use crate::wire::{Reader, Writer, error};

/// The file type by magic bytes: `jpeg`, `png`, `heic`, `heif`, `webp`, `glb`, `zip` or `unknown`.
#[must_use]
pub fn sniff(bytes: &[u8]) -> String {
    sniff::sniff(bytes).name().to_owned()
}

fn jpeg_error(e: jpeg::JpegError) -> Vec<u8> {
    let (code, at) = match e {
        jpeg::JpegError::NotJpeg => ("not-jpeg", None),
        jpeg::JpegError::ExpectedMarker { at } => ("expected-marker", Some(at)),
        jpeg::JpegError::BadMarker { at } => ("bad-marker", Some(at)),
        jpeg::JpegError::BadLength { at } => ("bad-length", Some(at)),
        jpeg::JpegError::Truncated { at } => ("truncated", Some(at)),
        jpeg::JpegError::NoEndOfImage => ("no-end-of-image", None),
    };
    error(code, at, &e.to_string())
}

/// `jpeg::strip`. Ok: `app_segments`, `app0_segments`, `jfif_trimmed`, `comments`, `fill_bytes`, `trailing_bytes`,
/// then the JPEG.
#[must_use]
pub fn jpeg_strip(bytes: &[u8]) -> Vec<u8> {
    match jpeg::strip(bytes) {
        Ok(s) => {
            let r = s.removed;
            Writer::ok()
                .size(r.app_segments)
                .size(r.app0_segments)
                .size(r.jfif_trimmed)
                .size(r.comments)
                .size(r.fill_bytes)
                .size(r.trailing_bytes)
                .rest(&s.bytes)
                .finish()
        }
        Err(e) => jpeg_error(e),
    }
}

/// A plan's pieces after the counts: their number, then each piece as `start`, `end` (a range of the input) or
/// `0xFFFFFFFF`, `len`, then `len` bytes of its own.
fn pieces(w: &mut Writer, plan: &Plan) {
    w.size(plan.pieces.len());
    for p in &plan.pieces {
        match p {
            Piece::Copy { start, end } => {
                w.size(*start).size(*end);
            }
            Piece::Bytes(b) => {
                w.u32(u32::MAX).size(b.len()).rest(b);
            }
        }
    }
}

/// `jpeg::strip_plan`: what [`jpeg_strip`] would write, as ranges of the input (the bytes don't come back across the
/// boundary). Ok: the six counts as in [`jpeg_strip`], then the pieces (see `pieces`). Errors as [`jpeg_strip`].
#[must_use]
pub fn jpeg_strip_plan(bytes: &[u8]) -> Vec<u8> {
    match jpeg::strip_plan(bytes) {
        Ok((plan, r)) => {
            let mut w = Writer::ok();
            w.size(r.app_segments)
                .size(r.app0_segments)
                .size(r.jfif_trimmed)
                .size(r.comments)
                .size(r.fill_bytes)
                .size(r.trailing_bytes);
            pieces(&mut w, &plan);
            w.finish()
        }
        Err(e) => jpeg_error(e),
    }
}

fn frame(w: &mut Writer, f: jpeg::FrameInfo) -> Vec<u8> {
    w.u32(f.width.into())
        .u32(f.height.into())
        .u32(f.components.into())
        .u32(f.precision.into())
        .u32(f.marker.into())
        .finish()
}

fn size_error(e: jpeg::SizeError, code_prefix: &str) -> Vec<u8> {
    let (code, at) = match e {
        jpeg::SizeError::NotJpeg => ("not-jpeg", None),
        jpeg::SizeError::ExpectedMarker { at } => ("expected-marker", Some(at)),
        jpeg::SizeError::ScanBeforeFrame { at } => ("scan-before-frame", Some(at)),
        jpeg::SizeError::EndBeforeFrame { at } => ("end-before-frame", Some(at)),
        jpeg::SizeError::Truncated { at } => ("truncated", Some(at)),
        jpeg::SizeError::BadLength { at } => ("bad-length", Some(at)),
        jpeg::SizeError::ZeroSize => ("zero-size", None),
        jpeg::SizeError::NoFrame => ("no-frame", None),
    };
    error(
        if code_prefix.is_empty() {
            code
        } else {
            code_prefix
        },
        at,
        &e.to_string(),
    )
}

/// `jpeg::frame_info`. Ok: `width`, `height`, `components`, `precision`, `marker`.
#[must_use]
pub fn jpeg_frame(bytes: &[u8]) -> Vec<u8> {
    match jpeg::frame_info(bytes) {
        Ok(f) => frame(&mut Writer::ok(), f),
        Err(e) => size_error(e, ""),
    }
}

/// `jpeg::is_clean`.
#[must_use]
pub fn jpeg_is_clean(bytes: &[u8]) -> bool {
    jpeg::is_clean(bytes)
}

/// `jpeg::passthrough`. Ok: the frame, as [`jpeg_frame`]. Codes: `not-clean`, `frame`, `precision`, `components`,
/// `too-large`.
#[must_use]
pub fn jpeg_passthrough(bytes: &[u8]) -> Vec<u8> {
    match jpeg::passthrough(bytes) {
        Ok(f) => frame(&mut Writer::ok(), f),
        Err(jpeg::Reencode::Frame(e)) => size_error(e, "frame"),
        Err(e) => {
            let code = match e {
                jpeg::Reencode::NotClean | jpeg::Reencode::Frame(_) => "not-clean",
                jpeg::Reencode::Precision(_) => "precision",
                jpeg::Reencode::Components(_) => "components",
                jpeg::Reencode::TooLarge { .. } => "too-large",
            };
            error(code, None, &e.to_string())
        }
    }
}

/// `png::strip`. Ok: `exif`, `text`, `time`, `trailing_bytes`, then the PNG.
#[must_use]
pub fn png_strip(bytes: &[u8]) -> Vec<u8> {
    match png::strip(bytes) {
        Ok(s) => {
            let r = s.removed;
            Writer::ok()
                .size(r.exif)
                .size(r.text)
                .size(r.time)
                .size(r.trailing_bytes)
                .rest(&s.bytes)
                .finish()
        }
        Err(e) => png_error(e),
    }
}

fn png_error(e: png::PngError) -> Vec<u8> {
    let (code, at) = match e {
        png::PngError::NotPng => ("not-png", None),
        png::PngError::Truncated { at } => ("truncated", Some(at)),
        png::PngError::NoEnd => ("no-end", None),
    };
    error(code, at, &e.to_string())
}

/// `png::strip_plan`: what [`png_strip`] would write, as ranges of the input. Ok: the four counts as in
/// [`png_strip`], then the pieces (see `pieces`). Errors as [`png_strip`].
#[must_use]
pub fn png_strip_plan(bytes: &[u8]) -> Vec<u8> {
    match png::strip_plan(bytes) {
        Ok((plan, r)) => {
            let mut w = Writer::ok();
            w.size(r.exif)
                .size(r.text)
                .size(r.time)
                .size(r.trailing_bytes);
            pieces(&mut w, &plan);
            w.finish()
        }
        Err(e) => png_error(e),
    }
}

/// `png::size`. Ok: `width`, `height`. Code: `no-ihdr`.
#[must_use]
pub fn png_size(bytes: &[u8]) -> Vec<u8> {
    match png::size(bytes) {
        Some((w, h)) => Writer::ok().u32(w).u32(h).finish(),
        None => error("no-ihdr", None, "not a PNG with an IHDR chunk"),
    }
}

fn glb_error(e: &glb::GlbError) -> Vec<u8> {
    let (code, at) = match e {
        glb::GlbError::NotGlb => ("not-glb", None),
        glb::GlbError::Version(_) => ("version", None),
        glb::GlbError::Length { .. } => ("length", None),
        glb::GlbError::ChunkTruncated { at } => ("chunk-truncated", Some(*at)),
        glb::GlbError::FirstChunkNotJson => ("first-chunk-not-json", None),
        glb::GlbError::DuplicateChunk { at } => ("duplicate-chunk", Some(*at)),
        glb::GlbError::Json(_) => ("json", None),
        glb::GlbError::NotObject => ("not-object", None),
        glb::GlbError::NotGltf2 => ("not-gltf2", None),
        glb::GlbError::Field { index, .. } => ("field", Some(*index)),
        glb::GlbError::BinMissing => ("bin-missing", None),
        glb::GlbError::BinShort { .. } => ("bin-short", None),
        glb::GlbError::ImageOutsideBin { image, .. } => ("image-outside-bin", Some(*image)),
        glb::GlbError::ImageSource { image } => ("image-source", Some(*image)),
        glb::GlbError::BadImage { image, .. } => ("bad-image", Some(*image)),
        glb::GlbError::Overlap { view, .. } => ("overlap", Some(*view)),
        glb::GlbError::TooLarge => ("too-large", None),
    };
    error(code, at, &e.to_string())
}

/// `glb::strip` (`in_place` picks [`glb::Layout::InPlace`], else compact). Ok: `layout` (0 compact, 1 in place),
/// `dropped_chunks`, `trailing_bytes`, `slack_bytes`, `changed` (0/1), the image count, then per image `image`,
/// `source` (0 bufferView, 1 data URI, 2 external uri), `view` (0xFFFFFFFF unless a bufferView), `kind` (0 JPEG,
/// 1 PNG, 2 other, 3 external), `bytes_before`, `bytes_after`, `changed` (0/1); then the GLB.
#[must_use]
pub fn glb_strip(bytes: &[u8], in_place: bool) -> Vec<u8> {
    let layout = if in_place {
        glb::Layout::InPlace
    } else {
        glb::Layout::Compact
    };
    match glb::strip(bytes, layout) {
        Ok(s) => {
            let r = &s.report;
            let mut w = Writer::ok();
            w.u32(u32::from(r.layout == glb::Layout::InPlace))
                .size(r.dropped_chunks)
                .size(r.trailing_bytes)
                .size(r.slack_bytes)
                .flag(r.changed)
                .size(r.images.len());
            for i in &r.images {
                let (source, view) = match i.source {
                    glb::ImageSource::BufferView(v) => (0, u32::try_from(v).unwrap_or(u32::MAX)),
                    glb::ImageSource::DataUri => (1, u32::MAX),
                    glb::ImageSource::Uri => (2, u32::MAX),
                };
                let kind = match i.kind {
                    glb::ImageKind::Jpeg => 0,
                    glb::ImageKind::Png => 1,
                    glb::ImageKind::Other => 2,
                    glb::ImageKind::External => 3,
                };
                w.size(i.image)
                    .u32(source)
                    .u32(view)
                    .u32(kind)
                    .size(i.bytes_before)
                    .size(i.bytes_after)
                    .flag(i.changed);
            }
            w.rest(&s.bytes).finish()
        }
        Err(e) => glb_error(&e),
    }
}

/// `datauri::decode_image` (`png` picks a PNG data URI, else JPEG). Ok: the bytes. Codes: `not-data-uri`, `base64`.
#[must_use]
pub fn data_uri_image(value: &str, png: bool) -> Vec<u8> {
    let kind = if png {
        datauri::ImageType::Png
    } else {
        datauri::ImageType::Jpeg
    };
    match datauri::decode_image(value, kind) {
        Ok(bytes) => Writer::ok().rest(&bytes).finish(),
        Err(e) => {
            let code = match e {
                datauri::DataUriError::NotDataUri => "not-data-uri",
                datauri::DataUriError::Base64(_) => "base64",
            };
            error(code, None, &e.to_string())
        }
    }
}

/// `meta::decode` with a cap of `max_len` bytes (0: [`meta::MAX_HEADER_LEN`]). Ok: the JSON text (UTF-8). Codes:
/// `too-long`, `not-ascii`, `base64`, `not-utf8`.
#[must_use]
pub fn meta_decode(header: &str, max_len: u32) -> Vec<u8> {
    let max = if max_len == 0 {
        meta::MAX_HEADER_LEN
    } else {
        usize::try_from(max_len).unwrap_or(usize::MAX)
    };
    match meta::decode(header, max) {
        Ok(text) => Writer::ok().rest(text.as_bytes()).finish(),
        Err(e) => {
            let code = match e {
                meta::MetaError::TooLong { .. } => "too-long",
                meta::MetaError::NotAscii => "not-ascii",
                meta::MetaError::Base64(_) => "base64",
                meta::MetaError::NotUtf8 => "not-utf8",
            };
            error(code, None, &e.to_string())
        }
    }
}

/// `path::normalize`, or `None` for a refused path.
#[must_use]
pub fn path_normalize(target: &str) -> Option<String> {
    path::normalize(target).ok()
}

/// `path::reduce_leading_slashes`.
#[must_use]
pub fn reduce_leading_slashes(target: &str) -> String {
    path::reduce_leading_slashes(target).to_owned()
}

/// `path::static_route` (always ok). Payload: `kind` (0 redirect to `/planner/`, 1 planner, 2 `library.json`,
/// 3 library asset, 4 scene asset, 5 render, 6 not found), `sub` (planner: trailing slash 0/1; library: 0 `model.glb`,
/// 1 `splat.ply`, 2 `splat.spz`, 3 `thumb.jpg`; scene: 0 `photo.jpg`, 1 `depth.png`, 2 `thumb.jpg`; else 0), then the
/// text (planner: the path inside it; library: the id; scene: the name; render: the file name; else empty).
#[must_use]
pub fn static_route(target: &str) -> Vec<u8> {
    let (kind, sub, text) = match path::static_route(target) {
        path::Route::RedirectToPlanner => (0, 0, String::new()),
        path::Route::Planner {
            rel,
            trailing_slash,
        } => (1, u32::from(trailing_slash), rel),
        path::Route::LibraryJson => (2, 0, String::new()),
        path::Route::Library { id, file } => {
            let sub = match file {
                path::LibraryFile::Model => 0,
                path::LibraryFile::SplatPly => 1,
                path::LibraryFile::SplatSpz => 2,
                path::LibraryFile::Thumb => 3,
            };
            (3, sub, id)
        }
        path::Route::Scene { name, file } => {
            let sub = match file {
                path::SceneFile::Photo => 0,
                path::SceneFile::Depth => 1,
                path::SceneFile::Thumb => 2,
            };
            (4, sub, name)
        }
        path::Route::Render { file } => (5, 0, file),
        path::Route::NotFound => (6, 0, String::new()),
    };
    Writer::ok()
        .u32(kind)
        .u32(sub)
        .rest(text.as_bytes())
        .finish()
}

/// `slug::is_slug`.
#[must_use]
pub fn is_slug(s: &str) -> bool {
    slug::is_slug(s)
}

/// `slug::is_scene_name`.
#[must_use]
pub fn is_scene_name(s: &str) -> bool {
    slug::is_scene_name(s)
}

/// `slug::is_render_name`.
#[must_use]
pub fn is_render_name(s: &str) -> bool {
    slug::is_render_name(s)
}

/// `slug::cmp_names`: -1, 0 or 1.
#[must_use]
pub fn cmp_names(a: &str, b: &str) -> i32 {
    match slug::cmp_names(a, b) {
        core::cmp::Ordering::Less => -1,
        core::cmp::Ordering::Equal => 0,
        core::cmp::Ordering::Greater => 1,
    }
}

/// `http::content_length` over all the request's `Content-Length` values. Ok: `present` (0/1), the length (u64, low
/// word first). Codes: `multiple`, `not-digits`.
#[must_use]
pub fn content_length(values: &[String]) -> Vec<u8> {
    let refs: Vec<&str> = values.iter().map(String::as_str).collect();
    match http::content_length(&refs) {
        Ok(n) => Writer::ok().flag(n.is_some()).u64(n.unwrap_or(0)).finish(),
        Err(e) => {
            let code = match e {
                http::ContentLengthError::Multiple => "multiple",
                http::ContentLengthError::NotDigits => "not-digits",
            };
            error(code, None, &e.to_string())
        }
    }
}

/// `http::host_name`.
#[must_use]
pub fn host_name(value: &str) -> Option<String> {
    http::host_name(value)
}

/// `http::check_host`: `allowed`, `missing`, `multiple`, `malformed` or `unknown`.
#[must_use]
pub fn check_host(values: &[String], allowed: &[String]) -> String {
    let values: Vec<&str> = values.iter().map(String::as_str).collect();
    let allowed: Vec<&str> = allowed.iter().map(String::as_str).collect();
    match http::check_host(&values, &allowed) {
        http::HostDecision::Allowed => "allowed",
        http::HostDecision::Missing => "missing",
        http::HostDecision::Multiple => "multiple",
        http::HostDecision::Malformed => "malformed",
        http::HostDecision::Unknown => "unknown",
    }
    .to_owned()
}

/// `http::origin_ok`.
#[must_use]
pub fn origin_ok(x_midstudy: Option<&str>, origin: Option<&str>, host: Option<&str>) -> bool {
    http::origin_ok(x_midstudy, origin, host)
}

fn read_entry<'a>(r: &mut Reader<'a>) -> Option<zip::Entry<'a>> {
    let name = r.bytes()?;
    let flags = r.u32()?;
    let low = r.u32()?;
    let high = r.u32()?;
    let external_attr = r.u32()?;
    Some(zip::Entry {
        name,
        utf8: flags & 0x0800 != 0,
        size: u64::from(low) | u64::from(high).wrapping_shl(32),
        external_attr,
    })
}

/// `zip::plan` over packed entries: for each, the name (u32 length, bytes), the general-purpose flags (u32; bit 11 is
/// UTF-8), the uncompressed size (u64, low word first) and the external attributes (u32). Ok: `obj` (its index),
/// `total` (u64), the count and indices of the entries to extract, the count and indices of the skipped ones. Codes:
/// `too-many-entries`, `bad-name`, `absolute`, `climbs`, `link`, `not-allowed` (offset: the entry), `too-big`,
/// `obj-count`, and `bad-input` for a packing the face got wrong.
#[must_use]
pub fn zip_plan(packed: &[u8]) -> Vec<u8> {
    let mut r = Reader::new(packed);
    let mut entries = Vec::new();
    while !r.done() {
        match read_entry(&mut r) {
            Some(e) => entries.push(e),
            None => {
                return error(
                    "bad-input",
                    None,
                    "the zip entries weren't packed as expected",
                );
            }
        }
    }
    match zip::plan(&entries) {
        Ok(p) => {
            let mut w = Writer::ok();
            w.size(p.obj).u64(p.total).size(p.extract.len());
            for i in &p.extract {
                w.size(*i);
            }
            w.size(p.skip.len());
            for i in &p.skip {
                w.size(*i);
            }
            w.finish()
        }
        Err(e) => {
            let (code, at) = match &e {
                zip::Refusal::TooManyEntries { .. } => ("too-many-entries", None),
                zip::Refusal::Entry { index, problem, .. } => (
                    match problem {
                        zip::Problem::BadName => "bad-name",
                        zip::Problem::Absolute => "absolute",
                        zip::Problem::Climbs => "climbs",
                        zip::Problem::Link => "link",
                        zip::Problem::NotAllowed => "not-allowed",
                    },
                    Some(*index),
                ),
                zip::Refusal::TooBig { .. } => ("too-big", None),
                zip::Refusal::ObjCount { .. } => ("obj-count", None),
            };
            error(code, at, &e.to_string())
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod tests {
    use super::*;

    fn le(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn envelopes() {
        let e = jpeg_strip(b"nope");
        assert_eq!(e[0], 1);
        assert_eq!(le(&e, 1), u32::MAX);
        assert_eq!(&e[6..6 + usize::from(e[5])], b"not-jpeg");
        let ok = png_size(b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x07\0\0\0\x05");
        assert_eq!((ok[0], le(&ok, 1), le(&ok, 5)), (0, 7, 5));
        let cl = content_length(&["12".to_owned()]);
        assert_eq!((cl[0], le(&cl, 1), le(&cl, 5), le(&cl, 9)), (0, 1, 12, 0));
        assert_eq!(check_host(&["127.0.0.1:1".to_owned()], &[]), "allowed");
        let route = static_route("/library/x/model.glb");
        assert_eq!(
            (le(&route, 1), le(&route, 5), &route[9..]),
            (3, 0, b"x".as_slice())
        );
    }

    /// The plan's pieces, applied to the input, are exactly what the strip writes.
    fn apply_plan(env: &[u8], counts: usize, input: &[u8]) -> Vec<u8> {
        let mut at = 1 + 4 * counts;
        let n = le(env, at) as usize;
        at += 4;
        let mut out = Vec::new();
        for _ in 0..n {
            let (a, b) = (le(env, at), le(env, at + 4) as usize);
            at += 8;
            if a == u32::MAX {
                out.extend_from_slice(&env[at..at + b]);
                at += b;
            } else {
                out.extend_from_slice(&input[a as usize..b]);
            }
        }
        assert_eq!(at, env.len());
        out
    }

    #[test]
    fn strip_plans_match_the_strips() {
        let clean = midstudy_media::jpeg::strip(b"\xff\xd8\xff\xd9")
            .unwrap()
            .bytes;
        let mut dirty =
            b"\xff\xd8\xff\xe0\x00\x13JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x01\x01abc".to_vec();
        dirty.extend_from_slice(b"\xff\xe1\x00\x04GP\xff\xff\xd9trailing");
        for input in [clean.as_slice(), dirty.as_slice()] {
            let strip = jpeg_strip(input);
            let plan = jpeg_strip_plan(input);
            assert_eq!(&plan[..25], &strip[..25], "same counts");
            assert_eq!(apply_plan(&plan, 6, input), &strip[25..]);
        }
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\0tEXt\0\0\0\0\0\0\0\0IEND\0\0\0\0after";
        let (strip, plan) = (png_strip(png), png_strip_plan(png));
        assert_eq!(&plan[..17], &strip[..17]);
        assert_eq!(apply_plan(&plan, 4, png), &strip[17..]);
        assert_eq!(jpeg_strip_plan(b"nope"), jpeg_strip(b"nope"));
        assert_eq!(png_strip_plan(b"nope"), png_strip(b"nope"));
    }

    #[test]
    fn zip_packing() {
        let mut p = Vec::new();
        for (name, size) in [("m.obj", 5u64), ("d/", 0)] {
            p.extend_from_slice(&u32::try_from(name.len()).unwrap().to_le_bytes());
            p.extend_from_slice(name.as_bytes());
            p.extend_from_slice(&0x0800u32.to_le_bytes());
            p.extend_from_slice(&size.to_le_bytes());
            p.extend_from_slice(&(0o100_644u32 << 16).to_le_bytes());
        }
        let ok = zip_plan(&p);
        assert_eq!(ok[0], 0);
        assert_eq!(
            (
                le(&ok, 1),
                le(&ok, 5),
                le(&ok, 13),
                le(&ok, 17),
                le(&ok, 21),
                le(&ok, 25)
            ),
            (0, 5, 1, 0, 1, 1)
        );
        assert_eq!(zip_plan(&p[..p.len() - 1])[0], 1);
    }
}
