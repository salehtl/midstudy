//! The 3DGS PLY reader and writer (contract §1), as v1 reads and writes them (`pipeline/src/midstudy_pipeline/splat.py`
//! `read_ply`, `write_ply`): the vertex element only (it must come first; later elements are ignored), binary little-
//! or big-endian, scalar properties of the eight PLY types, the 14 standard properties required. Written back as
//! binary little-endian with every property a `float`.
//!
//! Values are held as `f64` (exact for every PLY type) together with their type, so that an assignment of a computed
//! value casts it the way numpy's structured-array assignment does ([`Scalar::cast`]).
#![deny(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]

/// The properties a 3DGS splat must have (v1's `_REQUIRED`, in its order).
pub const REQUIRED: [&str; 14] = [
    "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
];

/// A PLY scalar type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scalar {
    F32,
    F64,
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
}

impl Scalar {
    /// The type of a `property <type> <name>` line (v1's `_TYPES`).
    #[must_use]
    pub fn from_name(name: &str) -> Option<Scalar> {
        Some(match name {
            "float" | "float32" => Scalar::F32,
            "double" | "float64" => Scalar::F64,
            "uchar" | "uint8" => Scalar::U8,
            "char" | "int8" => Scalar::I8,
            "ushort" | "uint16" => Scalar::U16,
            "short" | "int16" => Scalar::I16,
            "uint" | "uint32" => Scalar::U32,
            "int" | "int32" => Scalar::I32,
            _ => return None,
        })
    }

    /// Its size in bytes.
    #[must_use]
    pub fn size(self) -> usize {
        match self {
            Scalar::U8 | Scalar::I8 => 1,
            Scalar::U16 | Scalar::I16 => 2,
            Scalar::F32 | Scalar::U32 | Scalar::I32 => 4,
            Scalar::F64 => 8,
        }
    }

    /// A float64 assigned into a field of this type, as numpy's assignment casts it: rounded to the nearest float32,
    /// kept as float64, or truncated toward zero for the integer types (saturating where C leaves it undefined).
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_lossless,
        clippy::cast_sign_loss
    )]
    pub fn cast(self, v: f64) -> f64 {
        match self {
            Scalar::F32 => f64::from(v as f32),
            Scalar::F64 => v,
            Scalar::U8 => f64::from(v as u8),
            Scalar::I8 => f64::from(v as i8),
            Scalar::U16 => f64::from(v as u16),
            Scalar::I16 => f64::from(v as i16),
            Scalar::U32 => f64::from(v as u32),
            Scalar::I32 => f64::from(v as i32),
        }
    }

    fn read(self, b: &[u8], little: bool) -> Option<f64> {
        Some(match self {
            Scalar::U8 => f64::from(*b.first()?),
            Scalar::I8 => f64::from(i8::from_ne_bytes([*b.first()?])),
            Scalar::U16 => {
                let a = *b.first_chunk::<2>()?;
                f64::from(if little {
                    u16::from_le_bytes(a)
                } else {
                    u16::from_be_bytes(a)
                })
            }
            Scalar::I16 => {
                let a = *b.first_chunk::<2>()?;
                f64::from(if little {
                    i16::from_le_bytes(a)
                } else {
                    i16::from_be_bytes(a)
                })
            }
            Scalar::U32 => {
                let a = *b.first_chunk::<4>()?;
                f64::from(if little {
                    u32::from_le_bytes(a)
                } else {
                    u32::from_be_bytes(a)
                })
            }
            Scalar::I32 => {
                let a = *b.first_chunk::<4>()?;
                f64::from(if little {
                    i32::from_le_bytes(a)
                } else {
                    i32::from_be_bytes(a)
                })
            }
            Scalar::F32 => {
                let a = *b.first_chunk::<4>()?;
                f64::from(if little {
                    f32::from_le_bytes(a)
                } else {
                    f32::from_be_bytes(a)
                })
            }
            Scalar::F64 => {
                let a = *b.first_chunk::<8>()?;
                if little {
                    f64::from_le_bytes(a)
                } else {
                    f64::from_be_bytes(a)
                }
            }
        })
    }
}

/// One property of the vertex element.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Property {
    pub name: String,
    pub ty: Scalar,
}

/// The vertex element: its properties and, per property, one value per splat.
#[derive(Clone, Debug, PartialEq)]
pub struct Ply {
    pub count: usize,
    pub props: Vec<Property>,
    pub columns: Vec<Vec<f64>>,
}

/// Why a PLY was refused; the TypeScript side words each one as v1 did, with the file's path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlyError {
    /// No `ply` magic, or no `end_header`.
    NotPly,
    /// `end_header` with no newline after it (v1: a `ValueError` from `bytes.index`).
    NoHeaderEnd,
    /// Not a binary PLY: the format named (empty when there's no `format` line).
    Format(String),
    /// Another element comes before `vertex`.
    VertexNotFirst,
    /// A header line v1 couldn't read (a missing token, a count that isn't an integer): the line.
    Malformed(String),
    /// A list property or an unknown type in the vertex element: the line, stripped.
    Unsupported(String),
    /// The 3DGS properties that are missing, in v1's order.
    Missing(Vec<String>),
    /// A vertex count of 0.
    Empty,
    /// Fewer bytes than the vertices need.
    Truncated,
    /// A property named twice (numpy refuses the dtype).
    Duplicate(String),
}

/// Python's `str.split()` whitespace among the ASCII bytes (a byte above 0x7F decodes to U+FFFD, not a space).
fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c | 0x1c..=0x1f)
}

/// Python's `str.splitlines()` boundaries among the ASCII bytes.
fn is_line_break(b: u8) -> bool {
    matches!(b, b'\n' | b'\r' | 0x0b | 0x0c | 0x1c..=0x1e)
}

/// The header's lines (`bytes.decode("ascii", "replace").splitlines()`), as byte slices.
fn lines(header: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut rest = header;
    while !rest.is_empty() {
        match rest.iter().position(|&b| is_line_break(b)) {
            None => {
                out.push(rest);
                break;
            }
            Some(i) => {
                let (line, tail) = rest.split_at(i);
                out.push(line);
                // "\r\n" is one boundary
                let skip = if tail.starts_with(b"\r\n") { 2 } else { 1 };
                rest = tail.get(skip..).unwrap_or(&[]);
            }
        }
    }
    out
}

/// `str.split()` of one line.
fn tokens(line: &[u8]) -> Vec<&[u8]> {
    line.split(|&b| is_space(b))
        .filter(|t| !t.is_empty())
        .collect()
}

/// `str.strip()` of one line, as text (non-ASCII bytes become U+FFFD, as the "replace" decode does).
fn stripped(line: &[u8]) -> String {
    let start = line
        .iter()
        .position(|&b| !is_space(b))
        .unwrap_or(line.len());
    let end = line
        .iter()
        .rposition(|&b| !is_space(b))
        .map_or(start, |i| i.saturating_add(1));
    line.get(start..end)
        .unwrap_or(&[])
        .iter()
        .map(|&b| {
            if b.is_ascii() {
                char::from(b)
            } else {
                '\u{fffd}'
            }
        })
        .collect()
}

/// Python's `int()` of a token: optional sign, digits with single underscores between them.
fn py_int(token: &[u8]) -> Option<i64> {
    let (neg, digits) = match token.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, token),
    };
    if digits.is_empty() || digits.first() == Some(&b'_') || digits.last() == Some(&b'_') {
        return None;
    }
    let mut v: i64 = 0;
    let mut prev_underscore = false;
    for &b in digits {
        if b == b'_' {
            if prev_underscore {
                return None;
            }
            prev_underscore = true;
            continue;
        }
        prev_underscore = false;
        if !b.is_ascii_digit() {
            return None;
        }
        v = v
            .checked_mul(10)?
            .checked_add(i64::from(b.wrapping_sub(b'0')))?;
    }
    Some(if neg { v.checked_neg()? } else { v })
}

fn text(b: &[u8]) -> String {
    b.iter()
        .map(|&c| {
            if c.is_ascii() {
                char::from(c)
            } else {
                '\u{fffd}'
            }
        })
        .collect()
}

/// Reads the vertex element of a binary 3DGS PLY.
///
/// # Errors
/// [`PlyError`] when the file isn't a binary PLY splat v1 would read.
#[allow(clippy::too_many_lines)]
pub fn read(raw: &[u8]) -> Result<Ply, PlyError> {
    let marker = find(raw, b"end_header");
    let Some(marker) = marker.filter(|_| raw.starts_with(b"ply")) else {
        return Err(PlyError::NotPly);
    };
    let nl = raw
        .get(marker..)
        .and_then(|r| r.iter().position(|&b| b == b'\n'))
        .ok_or(PlyError::NoHeaderEnd)?;
    let end = marker
        .checked_add(nl)
        .and_then(|e| e.checked_add(1))
        .ok_or(PlyError::NoHeaderEnd)?;
    let header = raw.get(..end).ok_or(PlyError::NoHeaderEnd)?;
    let lines = lines(header);

    // fmt = next(ln.split()[1] for ln in lines if ln.startswith("format "))
    let mut format: Option<String> = None;
    for ln in &lines {
        if ln.starts_with(b"format ") {
            let t = tokens(ln);
            let second = t.get(1).ok_or_else(|| PlyError::Malformed(stripped(ln)))?;
            format = Some(text(second));
            break;
        }
    }
    let format = format.unwrap_or_default();
    let little = match format.as_str() {
        "binary_little_endian" => true,
        "binary_big_endian" => false,
        _ => return Err(PlyError::Format(format)),
    };

    let mut count: i64 = 0;
    let mut props: Vec<Property> = Vec::new();
    let mut in_vertex = false;
    for ln in &lines {
        let t = tokens(ln);
        match t.first().copied() {
            Some(b"element") => {
                if in_vertex {
                    break;
                }
                let kind = t.get(1).ok_or_else(|| PlyError::Malformed(stripped(ln)))?;
                if *kind != b"vertex" {
                    return Err(PlyError::VertexNotFirst);
                }
                let n = t
                    .get(2)
                    .and_then(|n| py_int(n))
                    .ok_or_else(|| PlyError::Malformed(stripped(ln)))?;
                in_vertex = true;
                count = n;
            }
            Some(b"property") if in_vertex => {
                let kind = t.get(1).ok_or_else(|| PlyError::Malformed(stripped(ln)))?;
                let ty = (kind != b"list")
                    .then(|| std::str::from_utf8(kind).ok().and_then(Scalar::from_name))
                    .flatten()
                    .ok_or_else(|| PlyError::Unsupported(stripped(ln)))?;
                let name = t.get(2).ok_or_else(|| PlyError::Malformed(stripped(ln)))?;
                props.push(Property {
                    name: text(name),
                    ty,
                });
            }
            _ => {}
        }
    }
    let missing: Vec<String> = REQUIRED
        .iter()
        .filter(|r| !props.iter().any(|p| p.name == **r))
        .map(|r| (*r).to_string())
        .collect();
    if !missing.is_empty() {
        return Err(PlyError::Missing(missing));
    }
    if count == 0 {
        return Err(PlyError::Empty);
    }
    for (i, p) in props.iter().enumerate() {
        if props.iter().take(i).any(|q| q.name == p.name) {
            return Err(PlyError::Duplicate(p.name.clone()));
        }
    }
    let count = usize::try_from(count)
        .map_err(|_| PlyError::Malformed(format!("element vertex {count}")))?;
    let stride: usize = props.iter().map(|p| p.ty.size()).sum();
    let body = raw.get(end..).unwrap_or(&[]);
    let need = count.checked_mul(stride).ok_or(PlyError::Truncated)?;
    if body.len() < need {
        return Err(PlyError::Truncated);
    }
    let mut columns: Vec<Vec<f64>> = props.iter().map(|_| Vec::with_capacity(count)).collect();
    let mut offsets = Vec::with_capacity(props.len());
    let mut at = 0usize;
    for p in &props {
        offsets.push(at);
        at = at.saturating_add(p.ty.size());
    }
    for row in body.chunks_exact(stride.max(1)).take(count) {
        for ((p, col), &off) in props.iter().zip(columns.iter_mut()).zip(&offsets) {
            let v = row
                .get(off..)
                .and_then(|b| p.ty.read(b, little))
                .ok_or(PlyError::Truncated)?;
            col.push(v);
        }
    }
    Ok(Ply {
        count,
        props,
        columns,
    })
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

impl Ply {
    /// The index of a property.
    #[must_use]
    pub fn index(&self, name: &str) -> Option<usize> {
        self.props.iter().position(|p| p.name == name)
    }

    /// A property's values.
    #[must_use]
    pub fn column(&self, name: &str) -> Option<&[f64]> {
        self.index(name)
            .and_then(|i| self.columns.get(i))
            .map(Vec::as_slice)
    }

    /// Drops the named properties (v1's `_drop`): the others keep their order.
    pub fn drop_props(&mut self, names: &[&str]) {
        let mut i = 0;
        while i < self.props.len() {
            let gone = self
                .props
                .get(i)
                .is_some_and(|p| names.contains(&p.name.as_str()));
            if gone {
                self.props.remove(i);
                if i < self.columns.len() {
                    self.columns.remove(i);
                }
            } else {
                i = i.saturating_add(1);
            }
        }
    }

    /// The splat as v1's `write_ply` writes it: binary little-endian, every property a float.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut header = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex {}\n",
            self.count
        );
        for p in &self.props {
            header.push_str("property float ");
            header.push_str(&p.name);
            header.push('\n');
        }
        header.push_str("end_header\n");
        let n = self.props.len();
        let mut out = Vec::with_capacity(
            header
                .len()
                .saturating_add(self.count.saturating_mul(n).saturating_mul(4)),
        );
        out.extend_from_slice(header.as_bytes());
        for i in 0..self.count {
            for col in &self.columns {
                let v = col.get(i).copied().unwrap_or(0.0) as f32;
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    clippy::format_push_string,
    clippy::cast_precision_loss
)]
mod tests {
    use super::*;

    fn splat(props: &[(&str, &str)], rows: &[Vec<f32>]) -> Vec<u8> {
        let mut h = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex {}\n",
            rows.len()
        );
        for (t, n) in props {
            h.push_str(&format!("property {t} {n}\n"));
        }
        h.push_str("end_header\n");
        let mut out = h.into_bytes();
        for r in rows {
            for v in r {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    fn standard(rows: &[Vec<f32>]) -> Vec<u8> {
        let props: Vec<(&str, &str)> = REQUIRED.iter().map(|n| ("float", *n)).collect();
        splat(&props, rows)
    }

    #[test]
    fn reads_and_writes_the_standard_properties() {
        let rows = vec![
            (0..14).map(|i| i as f32 * 0.5).collect::<Vec<_>>(),
            vec![1.0; 14],
        ];
        let ply = read(&standard(&rows)).unwrap();
        assert_eq!(ply.count, 2);
        assert_eq!(ply.column("f_dc_0").unwrap(), &[1.5, 1.0]);
        assert_eq!(ply.to_bytes(), standard(&rows));
    }

    #[test]
    fn refuses_what_v1_refuses() {
        assert_eq!(read(b"nope end_header\n"), Err(PlyError::NotPly));
        assert_eq!(
            read(b"ply\nformat ascii 1.0\nend_header\n"),
            Err(PlyError::Format("ascii".into()))
        );
        assert_eq!(
            read(b"ply\nend_header\n"),
            Err(PlyError::Format(String::new()))
        );
        assert_eq!(
            read(b"ply\nformat binary_little_endian 1.0\nelement face 1\nend_header\n"),
            Err(PlyError::VertexNotFirst)
        );
        let list = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty list uchar int x\nend_header\n";
        assert_eq!(
            read(list),
            Err(PlyError::Unsupported("property list uchar int x".into()))
        );
        let few = splat(&[("float", "x")], &[vec![1.0]]);
        assert!(matches!(read(&few), Err(PlyError::Missing(m)) if m.len() == 13 && m[0] == "y"));
        let empty = standard(&[]);
        assert_eq!(read(&empty), Err(PlyError::Empty));
        let mut cut = standard(&[vec![0.0; 14]]);
        cut.pop();
        assert_eq!(read(&cut), Err(PlyError::Truncated));
    }

    #[test]
    fn big_endian_doubles_and_extra_elements() {
        let mut h = String::from(
            "ply\r\nformat binary_big_endian 1.0\r\ncomment x\r\nelement vertex 1\r\n",
        );
        for n in REQUIRED {
            h.push_str(&format!("property double {n}\r\n"));
        }
        h.push_str("element face 0\r\nproperty list uchar int vertex_indices\r\nend_header\n");
        let mut b = h.into_bytes();
        for i in 0..14 {
            b.extend_from_slice(&(f64::from(i) + 0.25).to_be_bytes());
        }
        let ply = read(&b).unwrap();
        assert_eq!(ply.props[0].ty, Scalar::F64);
        assert_eq!(ply.column("rot_3").unwrap(), &[13.25]);
    }

    #[test]
    fn python_int_counts() {
        assert_eq!(py_int(b"1_000"), Some(1000));
        assert_eq!(py_int(b"+7"), Some(7));
        assert_eq!(py_int(b"1__0"), None);
        assert_eq!(py_int(b"x"), None);
    }

    #[test]
    fn drop_keeps_order() {
        let props: Vec<(&str, &str)> = [("float", "nx")]
            .into_iter()
            .chain(REQUIRED.iter().map(|n| ("float", *n)))
            .collect();
        let mut ply = read(&splat(&props, &[vec![9.0; 15]])).unwrap();
        ply.drop_props(&["nx"]);
        assert_eq!(ply.props.len(), 14);
        assert_eq!(ply.props[0].name, "x");
    }
}
