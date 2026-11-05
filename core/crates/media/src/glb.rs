//! GLB (binary glTF 2.0): the container read strictly and rewritten with every embedded JPEG and PNG image stripped
//! of its camera metadata (contract §2.8 Privacy: "A model's embedded textures lose their camera metadata in
//! `model.glb` (JPEG: APP1–APP15, comments, JFIF thumbnails and JFXX, anything after EOI; PNG: `eXIf`, `tEXt`,
//! `iTXt`, `zTXt`, `tIME`), the image data kept as it is: a user's own GLB can embed a geotagged photo, and
//! `model.glb` is served").
//!
//! v1: `read_glb`, `write_glb`, `clean_jpeg`, `clean_png` and `scrub_images` in
//! `pipeline/src/midstudy_pipeline/glb.py`. What v2 does differently, and why, is in `docs/notes/k-media.md`; in
//! short: the JSON text is kept byte for byte except the values that change (v1 re-serialised it); the freed bytes
//! are removed and later bufferViews moved down by multiples of 16 ([`Layout::Compact`]; v1 zeroed them in place,
//! which [`Layout::InPlace`] still does); a texture that can't be parsed refuses the file instead of being served
//! with its metadata; malformed containers and documents are refused with a reason.
//!
//! What is cleaned: images stored in a bufferView of the GLB's own binary chunk, and images given as `data:` URIs
//! (read as browsers read them, written back as base64). Images given as an external `uri` aren't in the file and
//! are reported as such; images in other formats (WebP, KTX2) are left as they are and reported.

use crate::bytes::{le32, usize_from};
use crate::json::{self, Kind, Value};
use crate::{datauri, jpeg, png};

pub use crate::json::JsonError;

const MAGIC: &[u8; 4] = b"glTF";
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;
const HEADER_LEN: usize = 12;
/// [`Layout::Compact`] removes multiples of 16 bytes, so every later bufferView keeps its offset modulo 16 (glTF needs
/// 4 for accessors and vertex strides; 16 keeps any stricter alignment a writer chose).
pub const ALIGN: usize = 16;

/// Where the bytes a cleaned image no longer needs go.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layout {
    /// Removed: the image's bufferView shrinks and every bufferView after it moves down by a multiple of [`ALIGN`]
    /// (up to 15 zero bytes stay after the image). Falls back to `InPlace` when a bufferView has `extensions`
    /// (`EXT_meshopt_compression` and the like address the buffer directly, and would not move with it).
    #[default]
    Compact,
    /// Zeroed in place: only the image's `byteLength` changes and nothing moves (v1's `scrub_images`).
    InPlace,
}

/// What an image entry holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind {
    /// A JPEG (starts `FF D8`).
    Jpeg,
    /// A PNG (signature).
    Png,
    /// Another format (WebP, KTX2, …), left as it is.
    Other,
    /// An external `uri`: not in the file.
    External,
}

/// Where an image entry's bytes are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageSource {
    /// A bufferView of the binary chunk.
    BufferView(usize),
    /// A `data:` URI.
    DataUri,
    /// An external `uri`.
    Uri,
}

/// What happened to one image entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageReport {
    /// Its index in `images`.
    pub image: usize,
    /// Where its bytes are.
    pub source: ImageSource,
    /// What it is.
    pub kind: ImageKind,
    /// Its size before (0 for an external image).
    pub bytes_before: usize,
    /// Its size after.
    pub bytes_after: usize,
    /// Its bytes changed (metadata was removed; a JFIF header can be rewritten at the same size).
    pub changed: bool,
}

/// What [`strip`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// One entry per image, in order.
    pub images: Vec<ImageReport>,
    /// The layout used (`InPlace` when `Compact` had to fall back).
    pub layout: Layout,
    /// Chunks dropped: unknown chunk types, and a binary chunk no buffer refers to.
    pub dropped_chunks: usize,
    /// Bytes after the length the header gives.
    pub trailing_bytes: usize,
    /// Bytes of the binary chunk beyond buffer 0's `byteLength` and its padding.
    pub slack_bytes: usize,
    /// The output differs from the input.
    pub changed: bool,
}

impl Report {
    /// How many image entries changed (two entries sharing a bufferView both count).
    #[must_use]
    pub fn images_cleaned(&self) -> usize {
        self.images.iter().filter(|i| i.changed).count()
    }
}

/// The rewritten GLB and what was done.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stripped {
    /// The GLB.
    pub bytes: Vec<u8>,
    /// What was done.
    pub report: Report,
}

/// Why an embedded image couldn't be cleaned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageProblem {
    /// A JPEG that isn't well formed.
    Jpeg(jpeg::JpegError),
    /// A PNG that isn't well formed.
    Png(png::PngError),
    /// A `data:` URI a browser couldn't read.
    DataUri,
}

/// What is wrong with a required glTF field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldProblem {
    /// It is missing.
    Missing,
    /// It isn't an object.
    NotObject,
    /// It isn't an array.
    NotArray,
    /// It isn't a non-negative integer.
    NotIndex,
    /// It points past what it refers to.
    OutOfRange,
    /// It isn't a string (or holds a lone surrogate).
    NotString,
}

/// Why [`strip`] refused a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GlbError {
    /// Shorter than 20 bytes, or no `glTF` magic.
    NotGlb,
    /// A container version other than 2.
    Version(u32),
    /// The header's length is below 20 or past the end of the data (a cut-off file).
    Length {
        /// The header's length.
        declared: u32,
        /// The data's length.
        actual: usize,
    },
    /// A chunk runs past the header's length.
    ChunkTruncated {
        /// Offset of the chunk.
        at: usize,
    },
    /// The first chunk isn't JSON.
    FirstChunkNotJson,
    /// A second JSON or binary chunk.
    DuplicateChunk {
        /// Offset of the chunk.
        at: usize,
    },
    /// The JSON chunk isn't UTF-8 JSON.
    Json(JsonError),
    /// The JSON isn't an object.
    NotObject,
    /// `asset.version` isn't a string starting with `2`.
    NotGltf2,
    /// A required field is missing or wrong.
    Field {
        /// `images`, `bufferViews` or `buffers`.
        array: &'static str,
        /// The entry.
        index: usize,
        /// The field (empty for the entry itself).
        field: &'static str,
        /// What is wrong.
        problem: FieldProblem,
    },
    /// Buffer 0 has no `uri` but the file has no binary chunk.
    BinMissing,
    /// The binary chunk is shorter than buffer 0's `byteLength`.
    BinShort {
        /// `byteLength`.
        needed: usize,
        /// The chunk's length.
        have: usize,
    },
    /// An image is in a buffer other than the binary chunk.
    ImageOutsideBin {
        /// The image.
        image: usize,
        /// Its buffer.
        buffer: usize,
    },
    /// An image with both a `bufferView` and a `uri`, or neither.
    ImageSource {
        /// The image.
        image: usize,
    },
    /// An embedded JPEG or PNG that can't be parsed, so its metadata can't be removed.
    BadImage {
        /// The image.
        image: usize,
        /// Why.
        problem: ImageProblem,
    },
    /// The bytes of an image that changes are shared with another bufferView.
    Overlap {
        /// The image's bufferView.
        view: usize,
        /// The other bufferView.
        other: usize,
    },
    /// The output would be over 4 GiB.
    TooLarge,
}

impl core::fmt::Display for GlbError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            GlbError::NotGlb => write!(f, "not a GLB file (bad header)"),
            GlbError::Version(v) => write!(f, "the GLB is glTF {v}; only glTF 2.0 is supported"),
            GlbError::Length { declared, actual } => {
                write!(
                    f,
                    "the GLB header says {declared} bytes but the file has {actual}: it is cut off or corrupt"
                )
            }
            GlbError::ChunkTruncated { at } => write!(
                f,
                "the GLB chunk at byte {at} runs past the end of the file"
            ),
            GlbError::FirstChunkNotJson => write!(f, "the GLB's first chunk isn't its JSON"),
            GlbError::DuplicateChunk { at } => write!(
                f,
                "the GLB has a second JSON or binary chunk (at byte {at})"
            ),
            GlbError::Json(e) => write!(f, "the GLB's JSON isn't valid ({e})"),
            GlbError::NotObject => write!(f, "the GLB's JSON isn't an object"),
            GlbError::NotGltf2 => write!(f, "the GLB isn't glTF 2.0 (asset.version)"),
            GlbError::Field {
                array,
                index,
                field,
                problem,
            } => {
                let what = match problem {
                    FieldProblem::Missing => "is missing",
                    FieldProblem::NotObject => "isn't an object",
                    FieldProblem::NotArray => "isn't an array",
                    FieldProblem::NotIndex => "isn't a non-negative integer",
                    FieldProblem::OutOfRange => "is out of range",
                    FieldProblem::NotString => "isn't a string",
                };
                if field.is_empty() {
                    write!(f, "the GLB's {array}[{index}] {what}")
                } else {
                    write!(f, "the GLB's {array}[{index}].{field} {what}")
                }
            }
            GlbError::BinMissing => write!(f, "the GLB has no binary chunk for buffer 0"),
            GlbError::BinShort { needed, have } => {
                write!(
                    f,
                    "the GLB is truncated (binary chunk is {have} of {needed} bytes)"
                )
            }
            GlbError::ImageOutsideBin { image, buffer } => write!(
                f,
                "image {image} is in buffer {buffer}, outside the GLB's binary chunk: pack the model into one buffer first"
            ),
            GlbError::ImageSource { image } => {
                write!(f, "image {image} needs exactly one of bufferView and uri")
            }
            GlbError::BadImage { image, problem } => match problem {
                ImageProblem::Jpeg(e) => write!(
                    f,
                    "texture {image} is a damaged JPEG ({e}): export the model again"
                ),
                ImageProblem::Png(e) => write!(
                    f,
                    "texture {image} is a damaged PNG ({e}): export the model again"
                ),
                ImageProblem::DataUri => {
                    write!(f, "texture {image} is a data URI that can't be read")
                }
            },
            GlbError::Overlap { view, other } => {
                write!(
                    f,
                    "bufferView {view} (a texture) shares bytes with bufferView {other}"
                )
            }
            GlbError::TooLarge => write!(f, "the rewritten GLB would be over 4 GiB"),
        }
    }
}

/// The chunks of a GLB.
struct Container<'a> {
    json: &'a [u8],
    bin: Option<&'a [u8]>,
    dropped_chunks: usize,
    trailing_bytes: usize,
}

fn read_container(data: &[u8]) -> Result<Container<'_>, GlbError> {
    if data.len() < 20 || !data.starts_with(MAGIC) {
        return Err(GlbError::NotGlb);
    }
    let version = le32(data, 4).ok_or(GlbError::NotGlb)?;
    if version != 2 {
        return Err(GlbError::Version(version));
    }
    let declared = le32(data, 8).ok_or(GlbError::NotGlb)?;
    let total = usize_from(declared)
        .filter(|&t| t >= 20 && t <= data.len())
        .ok_or(GlbError::Length {
            declared,
            actual: data.len(),
        })?;
    let mut json = None;
    let mut bin = None;
    let mut dropped_chunks = 0usize;
    let mut at = HEADER_LEN;
    while at < total {
        let body = at
            .checked_add(8)
            .filter(|&b| b <= total)
            .ok_or(GlbError::ChunkTruncated { at })?;
        let len = le32(data, at)
            .and_then(usize_from)
            .ok_or(GlbError::ChunkTruncated { at })?;
        let kind = le32(data, at.saturating_add(4)).ok_or(GlbError::ChunkTruncated { at })?;
        let end = body
            .checked_add(len)
            .filter(|&e| e <= total)
            .ok_or(GlbError::ChunkTruncated { at })?;
        let chunk = data.get(body..end).ok_or(GlbError::ChunkTruncated { at })?;
        if at == HEADER_LEN {
            if kind != CHUNK_JSON {
                return Err(GlbError::FirstChunkNotJson);
            }
            json = Some(chunk);
        } else if kind == CHUNK_JSON || (kind == CHUNK_BIN && bin.is_some()) {
            return Err(GlbError::DuplicateChunk { at });
        } else if kind == CHUNK_BIN {
            bin = Some(chunk);
        } else {
            dropped_chunks = dropped_chunks.saturating_add(1);
        }
        at = end;
    }
    let json = json.ok_or(GlbError::FirstChunkNotJson)?;
    Ok(Container {
        json,
        bin,
        dropped_chunks,
        trailing_bytes: data.len().saturating_sub(total),
    })
}

#[derive(Clone, Copy, Debug)]
struct Buffer {
    length: usize,
    length_value: Value,
    /// No `uri`: buffer 0 is the binary chunk.
    in_bin: bool,
}

#[derive(Clone, Copy, Debug)]
struct View {
    buffer: usize,
    offset: usize,
    length: usize,
    offset_value: Option<Value>,
    length_value: Value,
    extensions: bool,
}

impl View {
    fn end(&self) -> usize {
        self.offset.saturating_add(self.length)
    }
}

fn field(
    array: &'static str,
    index: usize,
    field: &'static str,
    problem: FieldProblem,
) -> GlbError {
    GlbError::Field {
        array,
        index,
        field,
        problem,
    }
}

/// The entries of a top-level array (`images`, `bufferViews`, `buffers`): it must be an array when present.
fn entries<'a>(
    name: &'static str,
    value: Option<Value>,
    items: &'a [json::Item],
) -> Result<&'a [json::Item], GlbError> {
    match value {
        None => Ok(&[]),
        Some(v) if v.kind == Kind::Array => Ok(items),
        Some(_) => Err(field(name, 0, "", FieldProblem::NotArray)),
    }
}

fn index_field(
    text: &[u8],
    array: &'static str,
    k: usize,
    name: &'static str,
    v: Option<Value>,
) -> Result<usize, GlbError> {
    let v = v.ok_or(field(array, k, name, FieldProblem::Missing))?;
    json::index(text, v).ok_or(field(array, k, name, FieldProblem::NotIndex))
}

fn read_buffers(text: &[u8], ix: &json::Index) -> Result<Vec<Buffer>, GlbError> {
    let mut out = Vec::new();
    for (k, item) in entries("buffers", ix.buffers, &ix.buffer_items)?
        .iter()
        .enumerate()
    {
        if item.value.kind != Kind::Object {
            return Err(field("buffers", k, "", FieldProblem::NotObject));
        }
        let length = index_field(text, "buffers", k, "byteLength", item.fields.byte_length)?;
        let length_value = item.fields.byte_length.ok_or(field(
            "buffers",
            k,
            "byteLength",
            FieldProblem::Missing,
        ))?;
        let in_bin = match item.fields.uri {
            Some(u) if u.kind == Kind::String => false,
            Some(_) => return Err(field("buffers", k, "uri", FieldProblem::NotString)),
            None if k == 0 => true,
            None => return Err(field("buffers", k, "uri", FieldProblem::Missing)),
        };
        out.push(Buffer {
            length,
            length_value,
            in_bin,
        });
    }
    Ok(out)
}

fn read_views(text: &[u8], ix: &json::Index, buffers: &[Buffer]) -> Result<Vec<View>, GlbError> {
    let mut out = Vec::new();
    for (k, item) in entries("bufferViews", ix.buffer_views, &ix.view_items)?
        .iter()
        .enumerate()
    {
        if item.value.kind != Kind::Object {
            return Err(field("bufferViews", k, "", FieldProblem::NotObject));
        }
        let f = &item.fields;
        let buffer = index_field(text, "bufferViews", k, "buffer", f.buffer)?;
        let offset = match f.byte_offset {
            None => 0,
            Some(v) => json::index(text, v).ok_or(field(
                "bufferViews",
                k,
                "byteOffset",
                FieldProblem::NotIndex,
            ))?,
        };
        let length = index_field(text, "bufferViews", k, "byteLength", f.byte_length)?;
        let length_value =
            f.byte_length
                .ok_or(field("bufferViews", k, "byteLength", FieldProblem::Missing))?;
        let size = buffers
            .get(buffer)
            .ok_or(field("bufferViews", k, "buffer", FieldProblem::OutOfRange))?
            .length;
        if offset.checked_add(length).is_none_or(|end| end > size) {
            return Err(field(
                "bufferViews",
                k,
                "byteLength",
                FieldProblem::OutOfRange,
            ));
        }
        out.push(View {
            buffer,
            offset,
            length,
            offset_value: f.byte_offset,
            length_value,
            extensions: f.extensions.is_some(),
        });
    }
    Ok(out)
}

/// Cleans one image's bytes: `(kind, Some(cleaned))` for a JPEG or PNG, `(Other, None)` for anything else. The
/// format is decided by content, as v1 did (`FF D8` or the PNG signature), whatever `mimeType` says.
fn clean_image(bytes: &[u8]) -> Result<(ImageKind, Option<Vec<u8>>), ImageProblem> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let s = jpeg::strip(bytes).map_err(ImageProblem::Jpeg)?;
        return Ok((ImageKind::Jpeg, Some(s.bytes)));
    }
    if bytes.starts_with(&png::SIGNATURE) {
        let s = png::strip(bytes).map_err(ImageProblem::Png)?;
        return Ok((ImageKind::Png, Some(s.bytes)));
    }
    Ok((ImageKind::Other, None))
}

/// A bufferView whose image shrinks.
#[derive(Clone, Debug)]
struct ViewEdit {
    view: usize,
    offset: usize,
    length: usize,
    clean: Vec<u8>,
}

/// One replacement in the JSON text.
#[derive(Clone, Debug)]
struct TextEdit {
    start: usize,
    end: usize,
    text: String,
}

/// `uri` looks like a `data:` URL to a browser (after the URL parser's trimming).
fn is_data_url(uri: &str) -> bool {
    let trimmed = uri.trim_start_matches(|c: char| c <= ' ');
    let mut letters = trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r'));
    "data:".chars().all(|want| {
        letters
            .next()
            .is_some_and(|c| c.eq_ignore_ascii_case(&want))
    })
}

/// What [`clean_images`] found: one report per image, the bufferViews whose image shrinks, the JSON replacements.
#[derive(Debug, Default)]
struct Cleaned {
    reports: Vec<ImageReport>,
    view_edits: Vec<ViewEdit>,
    text_edits: Vec<TextEdit>,
}

/// Cleans the image in bufferView `vi` (image `k`); `seen` remembers views already cleaned for another image.
fn view_image(
    text: &[u8],
    k: usize,
    item: &json::Item,
    views: &[View],
    bin: Option<&[u8]>,
    seen: &mut [Option<ImageReport>],
    out: &mut Cleaned,
) -> Result<ImageReport, GlbError> {
    let vi = index_field(text, "images", k, "bufferView", item.fields.buffer_view)?;
    let view = views
        .get(vi)
        .ok_or(field("images", k, "bufferView", FieldProblem::OutOfRange))?;
    let bin = bin
        .filter(|_| view.buffer == 0)
        .ok_or(GlbError::ImageOutsideBin {
            image: k,
            buffer: view.buffer,
        })?;
    if let Some(earlier) = seen.get(vi).copied().flatten() {
        return Ok(ImageReport {
            image: k,
            ..earlier
        });
    }
    let bytes = bin.get(view.offset..view.end()).ok_or(field(
        "bufferViews",
        vi,
        "byteLength",
        FieldProblem::OutOfRange,
    ))?;
    let (kind, clean) =
        clean_image(bytes).map_err(|problem| GlbError::BadImage { image: k, problem })?;
    let bytes_after = clean.as_ref().map_or(bytes.len(), Vec::len);
    let changed = clean.as_ref().is_some_and(|c| c.as_slice() != bytes);
    if let Some(clean) = clean.filter(|_| changed) {
        out.view_edits.push(ViewEdit {
            view: vi,
            offset: view.offset,
            length: view.length,
            clean,
        });
    }
    let report = ImageReport {
        image: k,
        source: ImageSource::BufferView(vi),
        kind,
        bytes_before: bytes.len(),
        bytes_after,
        changed,
    };
    if let Some(slot) = seen.get_mut(vi) {
        *slot = Some(report);
    }
    Ok(report)
}

/// Cleans image `k` given by its `uri` value `u`: a `data:` URL is decoded, cleaned and written back as base64; any
/// other URI is external.
fn uri_image(text: &[u8], k: usize, u: Value, out: &mut Cleaned) -> Result<ImageReport, GlbError> {
    let uri = json::string(text, u).ok_or(field("images", k, "uri", FieldProblem::NotString))?;
    if !is_data_url(&uri) {
        return Ok(ImageReport {
            image: k,
            source: ImageSource::Uri,
            kind: ImageKind::External,
            bytes_before: 0,
            bytes_after: 0,
            changed: false,
        });
    }
    let data = datauri::parse(&uri).ok_or(GlbError::BadImage {
        image: k,
        problem: ImageProblem::DataUri,
    })?;
    let (kind, clean) =
        clean_image(&data.body).map_err(|problem| GlbError::BadImage { image: k, problem })?;
    let bytes_after = clean.as_ref().map_or(data.body.len(), Vec::len);
    let changed = clean.as_ref().is_some_and(|c| *c != data.body);
    if let Some(clean) = clean.filter(|_| changed) {
        let text = json::quote(&datauri::encode(&data.mime, &clean));
        out.text_edits.push(TextEdit {
            start: u.start,
            end: u.end,
            text,
        });
    }
    Ok(ImageReport {
        image: k,
        source: ImageSource::DataUri,
        kind,
        bytes_before: data.body.len(),
        bytes_after,
        changed,
    })
}

/// Reads every image entry, cleans what can be cleaned and collects the edits.
fn clean_images(
    text: &[u8],
    ix: &json::Index,
    views: &[View],
    bin: Option<&[u8]>,
) -> Result<Cleaned, GlbError> {
    let mut out = Cleaned::default();
    let mut seen: Vec<Option<ImageReport>> = vec![None; views.len()];
    for (k, item) in entries("images", ix.images, &ix.image_items)?
        .iter()
        .enumerate()
    {
        if item.value.kind != Kind::Object {
            return Err(field("images", k, "", FieldProblem::NotObject));
        }
        let report = match (item.fields.buffer_view, item.fields.uri) {
            (Some(_), None) => view_image(text, k, item, views, bin, &mut seen, &mut out)?,
            (None, Some(u)) => uri_image(text, k, u, &mut out)?,
            _ => return Err(GlbError::ImageSource { image: k }),
        };
        out.reports.push(report);
    }
    Ok(out)
}

fn check_overlaps(edits: &[ViewEdit], views: &[View]) -> Result<(), GlbError> {
    for e in edits {
        let end = e.offset.saturating_add(e.length);
        for (j, v) in views.iter().enumerate() {
            if j != e.view && v.buffer == 0 && v.offset < end && e.offset < v.end() {
                return Err(GlbError::Overlap {
                    view: e.view,
                    other: j,
                });
            }
        }
    }
    Ok(())
}

/// How a shrinking view's freed bytes are split: `(zero padding kept after the image, bytes removed)`.
fn split_freed(freed: usize, layout: Layout) -> (usize, usize) {
    match layout {
        Layout::InPlace => (freed, 0),
        Layout::Compact => {
            let pad = freed & (ALIGN.saturating_sub(1));
            (pad, freed.saturating_sub(pad))
        }
    }
}

fn pad4(len: usize) -> usize {
    len.wrapping_neg() & 3
}

/// Buffer 0's bytes in the binary chunk (`None` when buffer 0 isn't the binary chunk), the slack beyond its padding,
/// and whether the chunk is dropped (no buffer refers to it).
fn bin_buffer<'a>(
    buffers: &[Buffer],
    chunk: Option<&'a [u8]>,
) -> Result<(Option<&'a [u8]>, usize, bool), GlbError> {
    match (buffers.first(), chunk) {
        (Some(b0), chunk) if b0.in_bin => {
            let chunk = match chunk {
                Some(c) => c,
                None if b0.length == 0 => &[],
                None => return Err(GlbError::BinMissing),
            };
            let used = chunk.get(..b0.length).ok_or(GlbError::BinShort {
                needed: b0.length,
                have: chunk.len(),
            })?;
            let slack = chunk
                .len()
                .saturating_sub(b0.length.saturating_add(pad4(b0.length)));
            Ok((Some(used), slack, false))
        }
        (_, Some(_)) => Ok((None, 0, true)),
        (_, None) => Ok((None, 0, false)),
    }
}

/// Buffer 0 with each shrinking image written at its offset and followed by its zero padding (compact: the rest of
/// the freed bytes removed). `edits` are sorted by offset and don't overlap.
fn rebuild_bin(bin: &[u8], edits: &[ViewEdit], layout: Layout) -> Vec<u8> {
    let mut out = Vec::with_capacity(bin.len());
    let mut pos = 0usize;
    for e in edits {
        out.extend_from_slice(bin.get(pos..e.offset).unwrap_or_default());
        out.extend_from_slice(&e.clean);
        let (pad, _) = split_freed(e.length.saturating_sub(e.clean.len()), layout);
        out.resize(out.len().saturating_add(pad), 0);
        pos = e.offset.saturating_add(e.length);
    }
    out.extend_from_slice(bin.get(pos..).unwrap_or_default());
    out
}

/// The JSON edits a layout needs: the shrunk views' new lengths and, when bytes were removed, the new offsets of the
/// views after each gap and buffer 0's new length.
fn layout_edits(
    views: &[View],
    buffers: &[Buffer],
    edits: &[ViewEdit],
    layout: Layout,
) -> Result<Vec<TextEdit>, GlbError> {
    let mut out = Vec::new();
    let mut removed_total = 0usize;
    let mut gaps: Vec<(usize, usize)> = Vec::new();
    for e in edits {
        let (_, removed) = split_freed(e.length.saturating_sub(e.clean.len()), layout);
        removed_total = removed_total.saturating_add(removed);
        gaps.push((e.offset.saturating_add(e.length), removed));
        if let Some(v) = views.get(e.view) {
            out.push(TextEdit {
                start: v.length_value.start,
                end: v.length_value.end,
                text: e.clean.len().to_string(),
            });
        }
    }
    if removed_total == 0 {
        return Ok(out);
    }
    for (j, v) in views.iter().enumerate().filter(|(_, v)| v.buffer == 0) {
        let shift = gaps
            .iter()
            .filter(|(end, _)| *end <= v.offset)
            .fold(0usize, |s, (_, r)| s.saturating_add(*r));
        if shift > 0 {
            let ov = v.offset_value.ok_or(field(
                "bufferViews",
                j,
                "byteOffset",
                FieldProblem::Missing,
            ))?;
            out.push(TextEdit {
                start: ov.start,
                end: ov.end,
                text: v.offset.saturating_sub(shift).to_string(),
            });
        }
    }
    if let Some(b0) = buffers.first() {
        let lv = b0.length_value;
        out.push(TextEdit {
            start: lv.start,
            end: lv.end,
            text: b0.length.saturating_sub(removed_total).to_string(),
        });
    }
    Ok(out)
}

/// The JSON chunk: the original text with the edits spliced in (then trailing whitespace trimmed), padded with
/// spaces to 4 bytes. Without edits, the original text as it is (padded if it wasn't).
fn splice_json(text: &[u8], mut edits: Vec<TextEdit>) -> Vec<u8> {
    let mut j = Vec::with_capacity(text.len().saturating_add(4));
    if edits.is_empty() {
        j.extend_from_slice(text);
    } else {
        edits.sort_by_key(|e| e.start);
        let mut pos = 0usize;
        for e in &edits {
            j.extend_from_slice(text.get(pos..e.start).unwrap_or_default());
            j.extend_from_slice(e.text.as_bytes());
            pos = e.end;
        }
        j.extend_from_slice(text.get(pos..).unwrap_or_default());
        while j
            .last()
            .is_some_and(|c| matches!(c, b' ' | b'\t' | b'\n' | b'\r'))
        {
            j.pop();
        }
    }
    j.resize(j.len().saturating_add(pad4(j.len())), b' ');
    j
}

/// The GLB container around a JSON chunk and an optional binary chunk (padded with zeros to 4 bytes here).
fn assemble(json_chunk: &[u8], bin: Option<Vec<u8>>) -> Result<Vec<u8>, GlbError> {
    let bin = bin.map(|mut b| {
        b.resize(b.len().saturating_add(pad4(b.len())), 0);
        b
    });
    let total = HEADER_LEN
        .checked_add(8)
        .and_then(|t| t.checked_add(json_chunk.len()))
        .and_then(|t| t.checked_add(bin.as_ref().map_or(0, |b| b.len().saturating_add(8))))
        .and_then(|t| u32::try_from(t).ok())
        .ok_or(GlbError::TooLarge)?;
    let json_len = u32::try_from(json_chunk.len()).map_err(|_| GlbError::TooLarge)?;
    let mut out = Vec::with_capacity(usize_from(total).unwrap_or(0));
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&total.to_le_bytes());
    out.extend_from_slice(&json_len.to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(json_chunk);
    if let Some(b) = &bin {
        let bin_len = u32::try_from(b.len()).map_err(|_| GlbError::TooLarge)?;
        out.extend_from_slice(&bin_len.to_le_bytes());
        out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
        out.extend_from_slice(b);
    }
    Ok(out)
}

/// Rewrites a GLB with every embedded JPEG and PNG image stripped of its metadata ([`jpeg::strip`],
/// [`png::strip`]); see the module docs for what is kept, moved and refused.
///
/// # Errors
/// [`GlbError`]: the container or the document is malformed, a texture can't be parsed, or a texture's bytes are
/// shared with another bufferView.
pub fn strip(data: &[u8], layout: Layout) -> Result<Stripped, GlbError> {
    let container = read_container(data)?;
    let text = container.json;
    let ix = json::parse(text).map_err(GlbError::Json)?;
    if ix.root.is_none_or(|r| r.kind != Kind::Object) {
        return Err(GlbError::NotObject);
    }
    let version = ix
        .asset
        .filter(|a| a.kind == Kind::Object)
        .and(ix.version)
        .and_then(|v| json::string(text, v));
    if !version.is_some_and(|v| v.starts_with('2')) {
        return Err(GlbError::NotGltf2);
    }
    let buffers = read_buffers(text, &ix)?;
    let views = read_views(text, &ix, &buffers)?;
    let (bin, slack_bytes, drop_bin) = bin_buffer(&buffers, container.bin)?;
    let dropped_chunks = container
        .dropped_chunks
        .saturating_add(usize::from(drop_bin));

    let Cleaned {
        reports,
        mut view_edits,
        mut text_edits,
    } = clean_images(text, &ix, &views, bin)?;
    check_overlaps(&view_edits, &views)?;
    let layout = if layout == Layout::Compact && views.iter().any(|v| v.extensions) {
        Layout::InPlace
    } else {
        layout
    };
    view_edits.sort_by_key(|e| e.offset);
    text_edits.extend(layout_edits(&views, &buffers, &view_edits, layout)?);

    // A binary chunk is written when buffer 0 lives in it and the input had one (an empty buffer 0 may have none).
    let bin_out = match bin {
        Some(b) if container.bin.is_some() => Some(if view_edits.is_empty() {
            b.to_vec()
        } else {
            rebuild_bin(b, &view_edits, layout)
        }),
        _ => None,
    };
    let bytes = assemble(&splice_json(text, text_edits), bin_out)?;
    let changed = bytes != data;
    Ok(Stripped {
        bytes,
        report: Report {
            images: reports,
            layout,
            dropped_chunks,
            trailing_bytes: container.trailing_bytes,
            slack_bytes,
            changed,
        },
    })
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
pub(crate) mod tests {
    use super::*;

    /// A GLB with the given JSON and binary chunk (padded as the spec says).
    pub(crate) fn glb(json: &str, bin: Option<&[u8]>) -> Vec<u8> {
        let mut j = json.as_bytes().to_vec();
        j.resize(j.len() + pad4(j.len()), b' ');
        let mut body = Vec::new();
        body.extend_from_slice(&u32::try_from(j.len()).unwrap().to_le_bytes());
        body.extend_from_slice(&CHUNK_JSON.to_le_bytes());
        body.extend_from_slice(&j);
        if let Some(b) = bin {
            let mut b = b.to_vec();
            b.resize(b.len() + pad4(b.len()), 0);
            body.extend_from_slice(&u32::try_from(b.len()).unwrap().to_le_bytes());
            body.extend_from_slice(&CHUNK_BIN.to_le_bytes());
            body.extend_from_slice(&b);
        }
        let mut out = MAGIC.to_vec();
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&u32::try_from(12 + body.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    /// A JPEG of `tiny` with an EXIF segment of `exif_len` bytes after SOI.
    fn exif_jpeg(exif_len: usize) -> Vec<u8> {
        let clean = crate::jpeg::tests::tiny(2, 2);
        let mut j = clean[..2].to_vec();
        j.extend_from_slice(&[0xFF, 0xE1]);
        j.extend_from_slice(&u16::try_from(exif_len + 2).unwrap().to_be_bytes());
        j.extend(std::iter::repeat_n(b'G', exif_len));
        j.extend_from_slice(&clean[2..]);
        j
    }

    fn model(image: &[u8]) -> (String, Vec<u8>) {
        // view 0: 8 bytes of positions, view 1: the image, view 2: 8 bytes after it.
        let mut bin = vec![1u8; 8];
        bin.extend_from_slice(image);
        let pad = pad4(bin.len());
        bin.resize(bin.len() + pad, 0);
        let after = bin.len();
        bin.extend_from_slice(&[2u8; 8]);
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"images":[{{"bufferView":1,"mimeType":"image/jpeg"}}],"bufferViews":[{{"buffer":0,"byteLength":8}},{{"buffer":0,"byteOffset":8,"byteLength":{}}},{{"buffer":0,"byteOffset":{after},"byteLength":8}}],"buffers":[{{"byteLength":{}}}]}}"#,
            image.len(),
            bin.len()
        );
        (json, bin)
    }

    #[test]
    fn compacts_and_keeps_alignment() {
        let dirty = exif_jpeg(100);
        let clean = crate::jpeg::strip(&dirty).unwrap().bytes;
        let (json, bin) = model(&dirty);
        let file = glb(&json, Some(&bin));
        let out = strip(&file, Layout::Compact).unwrap();
        assert!(out.report.changed);
        assert_eq!(out.report.layout, Layout::Compact);
        assert_eq!(out.report.images_cleaned(), 1);
        // The output parses, its image is the cleaned JPEG, and the last view kept its bytes and its offset mod 16.
        let again = strip(&out.bytes, Layout::Compact).unwrap();
        assert!(!again.report.changed, "strip is idempotent");
        let c = read_container(&out.bytes).unwrap();
        let ix = json::parse(c.json).unwrap();
        let views = read_views(c.json, &ix, &read_buffers(c.json, &ix).unwrap()).unwrap();
        let bin2 = c.bin.unwrap();
        assert_eq!(&bin2[views[1].offset..views[1].end()], clean.as_slice());
        assert_eq!(&bin2[views[2].offset..views[2].end()], &[2u8; 8]);
        assert_eq!(
            views[2].offset % ALIGN,
            (8 + dirty.len()).next_multiple_of(4) % ALIGN
        );
        assert!(views[2].offset < 8 + dirty.len());
    }

    #[test]
    fn in_place_zeroes() {
        let dirty = exif_jpeg(100);
        let clean = crate::jpeg::strip(&dirty).unwrap().bytes;
        let (json, bin) = model(&dirty);
        let out = strip(&glb(&json, Some(&bin)), Layout::InPlace).unwrap();
        let c = read_container(&out.bytes).unwrap();
        let b = c.bin.unwrap();
        assert_eq!(b.len(), bin.len());
        assert_eq!(&b[8..8 + clean.len()], clean.as_slice());
        assert!(b[8 + clean.len()..8 + dirty.len()].iter().all(|&x| x == 0));
        assert_eq!(&b[b.len() - 8..], &[2u8; 8]);
    }

    #[test]
    fn meshopt_views_fall_back_to_in_place() {
        let dirty = exif_jpeg(64);
        let (json, bin) = model(&dirty);
        let json = json.replacen(
            r#"{"buffer":0,"byteLength":8}"#,
            r#"{"buffer":0,"byteLength":8,"extensions":{"EXT_meshopt_compression":{}}}"#,
            1,
        );
        let out = strip(&glb(&json, Some(&bin)), Layout::Compact).unwrap();
        assert_eq!(out.report.layout, Layout::InPlace);
        assert_eq!(
            read_container(&out.bytes).unwrap().bin.unwrap().len(),
            bin.len()
        );
    }

    #[test]
    fn data_uri_images() {
        let dirty = exif_jpeg(30);
        let clean = crate::jpeg::strip(&dirty).unwrap().bytes;
        let uri = format!("data:image/jpeg;base64,{}", crate::base64::encode(&dirty));
        let json = format!(
            r#"{{"asset":{{"version":"2.0"}},"images":[{{"uri":"{uri}"}},{{"uri":"tex.png"}}]}}"#
        );
        let out = strip(&glb(&json, None), Layout::Compact).unwrap();
        let c = read_container(&out.bytes).unwrap();
        let ix = json::parse(c.json).unwrap();
        let new_uri = json::string(c.json, ix.image_items[0].fields.uri.unwrap()).unwrap();
        assert_eq!(
            new_uri,
            format!("data:image/jpeg;base64,{}", crate::base64::encode(&clean))
        );
        assert_eq!(out.report.images[1].kind, ImageKind::External);
    }

    #[test]
    fn refusals() {
        let (json, bin) = model(&exif_jpeg(10));
        let good = glb(&json, Some(&bin));
        assert_eq!(
            strip(&good[..good.len() - 4], Layout::Compact).unwrap_err(),
            GlbError::Length {
                declared: u32::try_from(good.len()).unwrap(),
                actual: good.len() - 4
            }
        );
        assert_eq!(
            strip(b"glTF\x01\0\0\0\x14\0\0\0\0\0\0\0\0\0\0\0", Layout::Compact),
            Err(GlbError::Version(1))
        );
        let broken = model(&exif_jpeg(10)[..40]);
        assert!(matches!(
            strip(&glb(&broken.0, Some(&broken.1)), Layout::Compact),
            Err(GlbError::BadImage { image: 0, .. })
        ));
        let v1 = json.replace(r#""version":"2.0""#, r#""version":"1.0""#);
        assert_eq!(
            strip(&glb(&v1, Some(&bin)), Layout::Compact),
            Err(GlbError::NotGltf2)
        );
        let dup = json.replace(r#""bufferView":1,"#, r#""bufferView":1,"bufferView":0,"#);
        assert!(matches!(
            strip(&glb(&dup, Some(&bin)), Layout::Compact),
            Err(GlbError::Json(JsonError::DuplicateKey { .. }))
        ));
        let overlap = json.replace(
            r#"{"buffer":0,"byteLength":8}"#,
            r#"{"buffer":0,"byteLength":12}"#,
        );
        assert_eq!(
            strip(&glb(&overlap, Some(&bin)), Layout::Compact),
            Err(GlbError::Overlap { view: 1, other: 0 })
        );
        let both = json.replace(r#""bufferView":1,"#, r#""bufferView":1,"uri":"x.png","#);
        assert_eq!(
            strip(&glb(&both, Some(&bin)), Layout::Compact),
            Err(GlbError::ImageSource { image: 0 })
        );
        assert_eq!(
            strip(&glb(&json, None), Layout::Compact),
            Err(GlbError::BinMissing)
        );
    }

    #[test]
    fn clean_files_are_unchanged() {
        let clean = crate::jpeg::tests::tiny(2, 2);
        let (json, bin) = model(&clean);
        let file = glb(&json, Some(&bin));
        let out = strip(&file, Layout::Compact).unwrap();
        assert!(!out.report.changed);
        assert_eq!(out.bytes, file);
    }

    use proptest::prelude::*;

    /// One bufferView of a generated GLB: an image (a JPEG with `exif` bytes of EXIF, or a PNG with a `text`-byte
    /// tEXt chunk) or plain data, after `gap` bytes of padding.
    #[derive(Clone, Debug)]
    enum Blob {
        Jpeg { exif: usize },
        Png { text: usize },
        Data(Vec<u8>),
    }

    fn blob() -> impl Strategy<Value = (Blob, usize)> {
        let b = prop_oneof![
            (0usize..400).prop_map(|exif| Blob::Jpeg { exif }),
            (0usize..100).prop_map(|text| Blob::Png { text }),
            prop::collection::vec(any::<u8>(), 0..64).prop_map(Blob::Data),
        ];
        (b, 0usize..3)
    }

    fn bytes_of(b: &Blob) -> Vec<u8> {
        match b {
            Blob::Jpeg { exif } => exif_jpeg(*exif),
            Blob::Png { text } => {
                let mut v = png::SIGNATURE.to_vec();
                let chunk = |kind: &[u8; 4], body: &[u8]| {
                    let mut c = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
                    c.extend_from_slice(kind);
                    c.extend_from_slice(body);
                    c.extend_from_slice(&[0; 4]);
                    c
                };
                v.extend(chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
                v.extend(chunk(b"tEXt", &vec![b'g'; *text]));
                v.extend(chunk(b"IDAT", &[1, 2, 3]));
                v.extend(chunk(b"IEND", &[]));
                v
            }
            Blob::Data(d) => d.clone(),
        }
    }

    /// The views of a GLB as (offset, length) and its binary chunk.
    fn views_of(file: &[u8]) -> (Vec<(usize, usize)>, Vec<u8>) {
        let c = read_container(file).unwrap();
        let ix = json::parse(c.json).unwrap();
        let buffers = read_buffers(c.json, &ix).unwrap();
        let views = read_views(c.json, &ix, &buffers).unwrap();
        (
            views.iter().map(|v| (v.offset, v.length)).collect(),
            c.bin.unwrap_or_default().to_vec(),
        )
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 500, ..ProptestConfig::default() })]

        /// Both layouts: every image's bytes become exactly its stripped bytes, every other view keeps its bytes,
        /// every view moves by a multiple of 16 (not at all in place), the output strips to itself, and compact is
        /// never larger than in place.
        #[test]
        fn glb_layouts(parts in prop::collection::vec(blob(), 0..7)) {
            let mut bin = Vec::new();
            let mut views = Vec::new();
            let mut images = Vec::new();
            for (k, (b, gap)) in parts.iter().enumerate() {
                bin.resize(bin.len().next_multiple_of(4) + 4 * gap, 0);
                let bytes = bytes_of(b);
                views.push(format!(r#"{{"buffer":0,"byteOffset":{},"byteLength":{}}}"#, bin.len(), bytes.len()));
                if !matches!(b, Blob::Data(_)) {
                    images.push(format!(r#"{{"bufferView":{k}}}"#));
                }
                bin.extend_from_slice(&bytes);
            }
            let json = format!(
                r#"{{"asset":{{"version":"2.0"}},"images":[{}],"bufferViews":[{}],"buffers":[{{"byteLength":{}}}]}}"#,
                images.join(","), views.join(","), bin.len()
            );
            let file = glb(&json, Some(&bin));
            let (before, old_bin) = views_of(&file);
            let mut sizes = Vec::new();
            for layout in [Layout::Compact, Layout::InPlace] {
                let out = strip(&file, layout).unwrap();
                prop_assert!(!strip(&out.bytes, layout).unwrap().report.changed);
                let (after, new_bin) = views_of(&out.bytes);
                for (k, (b, _)) in parts.iter().enumerate() {
                    let (o1, l1) = before[k];
                    let (o2, l2) = after[k];
                    prop_assert_eq!((o1 - o2) % ALIGN, 0);
                    if layout == Layout::InPlace {
                        prop_assert_eq!(o1, o2);
                    }
                    let old = &old_bin[o1..o1 + l1];
                    let want = match b {
                        Blob::Jpeg { .. } => jpeg::strip(old).unwrap().bytes,
                        Blob::Png { .. } => png::strip(old).unwrap().bytes,
                        Blob::Data(_) => old.to_vec(),
                    };
                    prop_assert_eq!(&new_bin[o2..o2 + l2], want.as_slice());
                }
                sizes.push(out.bytes.len());
            }
            prop_assert!(sizes[0] <= sizes[1]);
        }

        /// Arbitrary JSON-ish text in a GLB never panics the reader or the rewrite.
        #[test]
        fn glb_json_never_panics(text in r#"[\[\]{}",:0-9a-zA-Z .\\-]{0,120}"#, bin in prop::collection::vec(any::<u8>(), 0..64)) {
            let _ = strip(&glb(&text, Some(&bin)), Layout::Compact);
            let _ = json::parse(text.as_bytes());
        }
    }
}
