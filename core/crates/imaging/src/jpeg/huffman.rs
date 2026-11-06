//! Huffman tables (JPEG Annex C and F; libjpeg's `jpeg_make_d_derived_tbl` and `jpeg_make_c_derived_tbl`) and the
//! standard tables of Annex K, which libjpeg-turbo's encoder uses unless asked to optimize (Pillow doesn't).

/// A table as a DHT segment gives it: `bits[l]` codes of length `l` (1–16), then the symbols in code order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Spec {
    pub bits: [u8; 17],
    pub values: Vec<u8>,
}

/// Lookahead bits for the fast decode path.
pub(crate) const LOOKAHEAD: u32 = 9;

/// A decoding table.
#[derive(Clone, Debug)]
pub(crate) struct Decoder {
    /// For each `LOOKAHEAD`-bit prefix: (code length, symbol), length 0 when the code is longer.
    pub fast: Vec<(u8, u8)>,
    /// The largest code of each length (−1 when none), with `maxcode[17]` a sentinel.
    pub maxcode: [i64; 18],
    pub valoffset: [i64; 18],
    pub values: Vec<u8>,
}

/// Why a table is unusable (libjpeg's `JERR_BAD_HUFF_TABLE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BadTable;

/// The code lengths and codes of every symbol, in table order (Figures C.1 and C.2).
fn codes(spec: &Spec) -> Result<Vec<(u8, u32)>, BadTable> {
    let mut sizes = Vec::new();
    for l in 1..=16u8 {
        for _ in 0..spec.bits[usize::from(l)] {
            sizes.push(l);
        }
    }
    if sizes.len() > 256 || sizes.len() > spec.values.len() {
        return Err(BadTable);
    }
    let mut out = Vec::with_capacity(sizes.len());
    let mut code: u32 = 0;
    let mut si = sizes.first().copied().unwrap_or(0);
    let mut p = 0;
    while p < sizes.len() {
        while p < sizes.len() && sizes[p] == si {
            out.push((si, code));
            code += 1;
            p += 1;
        }
        if u64::from(code) >= 1u64 << si {
            return Err(BadTable);
        }
        code <<= 1;
        si += 1;
    }
    Ok(out)
}

impl Decoder {
    pub(crate) fn new(spec: &Spec) -> Result<Decoder, BadTable> {
        let codes = codes(spec)?;
        let mut maxcode = [-1i64; 18];
        let mut valoffset = [0i64; 18];
        let mut p = 0usize;
        for l in 1..=16usize {
            let n = usize::from(spec.bits[l]);
            if n > 0 {
                valoffset[l] = i64::try_from(p).unwrap_or(0) - i64::from(codes[p].1);
                p += n;
                maxcode[l] = i64::from(codes[p - 1].1);
            }
        }
        maxcode[17] = 0xF_FFFF;
        let mut fast = vec![(0u8, 0u8); 1 << LOOKAHEAD];
        for (k, &(len, code)) in codes.iter().enumerate() {
            if u32::from(len) <= LOOKAHEAD {
                let shift = LOOKAHEAD - u32::from(len);
                let base = (code << shift) as usize;
                for i in 0..(1usize << shift) {
                    fast[base + i] = (len, spec.values[k]);
                }
            }
        }
        Ok(Decoder {
            fast,
            maxcode,
            valoffset,
            values: spec.values.clone(),
        })
    }
}

/// An encoding table: the code and its length for each symbol.
#[derive(Clone, Debug)]
pub(crate) struct Encoder {
    pub code: [u32; 256],
    pub size: [u8; 256],
}

impl Encoder {
    pub(crate) fn new(spec: &Spec) -> Encoder {
        let mut code = [0u32; 256];
        let mut size = [0u8; 256];
        if let Ok(codes) = codes(spec) {
            for (k, &(len, c)) in codes.iter().enumerate() {
                let sym = usize::from(spec.values[k]);
                code[sym] = c;
                size[sym] = len;
            }
        }
        Encoder { code, size }
    }
}

fn spec(bits: [u8; 17], values: &[u8]) -> Spec {
    Spec {
        bits,
        values: values.to_vec(),
    }
}

pub(crate) fn std_dc_luminance() -> Spec {
    spec(
        [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
        &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    )
}

pub(crate) fn std_dc_chrominance() -> Spec {
    spec(
        [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
        &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    )
}

pub(crate) fn std_ac_luminance() -> Spec {
    spec(
        [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
        &[
            0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51,
            0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1,
            0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18,
            0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
            0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57,
            0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
            0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
            0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
            0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
            0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
            0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2,
            0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
        ],
    )
}

pub(crate) fn std_ac_chrominance() -> Spec {
    spec(
        [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
        &[
            0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07,
            0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09,
            0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25,
            0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
            0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
            0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
            0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
            0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
            0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
            0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2,
            0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
        ],
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn standard_tables_are_complete() {
        for s in [
            std_dc_luminance(),
            std_dc_chrominance(),
            std_ac_luminance(),
            std_ac_chrominance(),
        ] {
            let n: usize = s.bits.iter().map(|&b| usize::from(b)).sum();
            assert_eq!(n, s.values.len());
            Decoder::new(&s).unwrap();
        }
        let e = Encoder::new(&std_dc_luminance());
        assert_eq!((e.code[0], e.size[0]), (0b00, 2));
        assert_eq!((e.code[11], e.size[11]), (0b1_1111_1110, 9));
    }
}
