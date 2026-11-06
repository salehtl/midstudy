//! The EXIF orientation, as Pillow's `ImageOps.exif_transpose` finds it: tag 0x0112 of IFD0 in the TIFF structure
//! of the EXIF block (after any `Exif\0\0` prefixes), else `tiff:Orientation="N"` (or `>N`) in the XMP packet.
//! Pillow raises on an EXIF block that isn't TIFF; here such a block simply has no orientation.

/// The orientation (1–8 in practice), or `None` when there's none.
#[must_use]
pub fn orientation(exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Option<u32> {
    match exif.map_or(Tag::Absent, tiff_orientation) {
        Tag::Value(v) => Some(v),
        Tag::Other => None,
        Tag::Absent => xmp.and_then(xmp_orientation),
    }
}

/// What IFD0 says about the orientation.
enum Tag {
    /// No tag (or no readable TIFF): the XMP may say.
    Absent,
    /// One integer.
    Value(u32),
    /// The tag with another shape: Pillow finds no transpose for it.
    Other,
}

fn u16_at(d: &[u8], at: usize, le: bool) -> Option<u32> {
    let b = d.get(at..at + 2)?;
    Some(u32::from(if le {
        u16::from_le_bytes([b[0], b[1]])
    } else {
        u16::from_be_bytes([b[0], b[1]])
    }))
}

fn u32_at(d: &[u8], at: usize, le: bool) -> Option<u32> {
    let b = d.get(at..at + 4)?;
    let a = [b[0], b[1], b[2], b[3]];
    Some(if le {
        u32::from_le_bytes(a)
    } else {
        u32::from_be_bytes(a)
    })
}

fn tiff_orientation(d: &[u8]) -> Tag {
    tiff_tag(d).unwrap_or(Tag::Absent)
}

fn tiff_tag(mut d: &[u8]) -> Option<Tag> {
    while d.starts_with(b"Exif\0\0") {
        d = &d[6..];
    }
    let le = match d.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let ifd = usize::try_from(u32_at(d, 4, le)?).ok()?;
    let n = usize::try_from(u16_at(d, ifd, le)?).ok()?;
    for i in 0..n {
        let e = ifd + 2 + 12 * i;
        if u16_at(d, e, le)? != 0x0112 {
            continue;
        }
        let ty = u16_at(d, e + 2, le)?;
        let count = u32_at(d, e + 4, le)?;
        if count != 1 {
            return Some(Tag::Other);
        }
        let v = match ty {
            1 | 6 | 7 => d.get(e + 8).map(|&b| u32::from(b)),
            3 | 8 => u16_at(d, e + 8, le),
            4 | 9 => u32_at(d, e + 8, le),
            _ => None,
        };
        return Some(v.map_or(Tag::Other, Tag::Value));
    }
    None
}

/// Pillow's `re.search(rb'tiff:Orientation(="|>)([0-9])', xmp)`.
fn xmp_orientation(xmp: &[u8]) -> Option<u32> {
    let key = b"tiff:Orientation";
    let mut at = 0;
    while let Some(i) = xmp.get(at..)?.windows(key.len()).position(|w| w == key) {
        let start = at + i + key.len();
        let rest = xmp.get(start..).unwrap_or(&[]);
        let digit = if rest.starts_with(b"=\"") {
            rest.get(2)
        } else if rest.starts_with(b">") {
            rest.get(1)
        } else {
            None
        };
        if let Some(&c) = digit.filter(|c| c.is_ascii_digit()) {
            return Some(u32::from(c - b'0'));
        }
        at = start;
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn exif(le: bool, ty: u16, count: u32, value: u32) -> Vec<u8> {
        let mut d = b"Exif\0\0".to_vec();
        let w16 = |d: &mut Vec<u8>, v: u16| {
            d.extend_from_slice(&if le { v.to_le_bytes() } else { v.to_be_bytes() });
        };
        let w32 = |d: &mut Vec<u8>, v: u32| {
            d.extend_from_slice(&if le { v.to_le_bytes() } else { v.to_be_bytes() });
        };
        d.extend_from_slice(if le { b"II*\0" } else { b"MM\0*" });
        w32(&mut d, 8);
        w16(&mut d, 1);
        w16(&mut d, 0x0112);
        w16(&mut d, ty);
        w32(&mut d, count);
        if ty == 3 {
            w16(&mut d, u16::try_from(value).unwrap());
            w16(&mut d, 0);
        } else {
            w32(&mut d, value);
        }
        w32(&mut d, 0);
        d
    }

    #[test]
    fn reads_both_byte_orders() {
        assert_eq!(orientation(Some(&exif(true, 3, 1, 6)), None), Some(6));
        assert_eq!(orientation(Some(&exif(false, 3, 1, 8)), None), Some(8));
        assert_eq!(orientation(Some(&exif(true, 4, 1, 3)), None), Some(3));
        assert_eq!(
            orientation(Some(&exif(true, 3, 2, 3)), Some(b"tiff:Orientation=\"6\"")),
            None
        );
    }

    #[test]
    fn falls_back_to_xmp() {
        assert_eq!(
            orientation(None, Some(b"<x tiff:Orientation=\"6\"/>")),
            Some(6)
        );
        assert_eq!(
            orientation(None, Some(b"<tiff:Orientation>3</tiff:Orientation>")),
            Some(3)
        );
        assert_eq!(
            orientation(Some(b"Exif\0\0junk"), Some(b"tiff:Orientation=\"8\"")),
            Some(8)
        );
        assert_eq!(orientation(None, None), None);
    }
}
