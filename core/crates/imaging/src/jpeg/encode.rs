//! The JPEG encoder, as Pillow 13 drives libjpeg-turbo 3 for `im.save(f, "JPEG", quality=q[, icc_profile=…])` on an
//! RGB image: `jpeg_set_defaults` + `jpeg_set_quality(q, force_baseline)`, YCbCr 4:2:0 (libjpeg's default
//! sampling), the accurate integer forward DCT (`jfdctint.c`), libjpeg-turbo's reciprocal quantizer, the standard
//! Huffman tables, a JFIF 1.01 header with no density, Pillow's ICC APP2 chunks after it, then DQT, SOF0, DHT, SOS.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::cast_lossless,
    clippy::many_single_char_names,
    clippy::similar_names,
    clippy::too_many_lines,
    clippy::needless_range_loop
)]

use super::NATURAL_ORDER;
use super::huffman::{
    Encoder, Spec, std_ac_chrominance, std_ac_luminance, std_dc_chrominance, std_dc_luminance,
};

const STD_LUMINANCE: [u32; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
    92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMINANCE: [u32; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/// `jpeg_set_quality(quality, TRUE)`'s table (natural order).
fn quant_table(base: &[u32; 64], quality: u8) -> [u16; 64] {
    let q = u32::from(quality.clamp(1, 100));
    let scale = if q < 50 { 5000 / q } else { 200 - q * 2 };
    let mut out = [0u16; 64];
    for i in 0..64 {
        let t = ((base[i] * scale + 50) / 100).clamp(1, 255);
        out[i] = t as u16;
    }
    out
}

/// libjpeg-turbo's `compute_reciprocal` for a 16-bit DCTELEM: (reciprocal, correction, shift).
fn reciprocal(divisor: u32) -> (u32, u32, u32) {
    let b = divisor.ilog2(); // flss(divisor) - 1
    let mut r = 16 + b;
    let mut fq = (1u32 << r) / divisor;
    let fr = (1u32 << r) % divisor;
    let mut c = divisor / 2;
    if fr == 0 {
        fq >>= 1;
        r -= 1;
    } else if fr <= divisor / 2 {
        c += 1;
    } else {
        fq += 1;
    }
    (fq & 0xFFFF, c & 0xFFFF, r)
}

struct Divisors {
    recip: [u32; 64],
    corr: [u32; 64],
    shift: [u32; 64],
}

impl Divisors {
    fn new(q: &[u16; 64]) -> Self {
        let mut d = Divisors {
            recip: [0; 64],
            corr: [0; 64],
            shift: [0; 64],
        };
        for i in 0..64 {
            let (r, c, s) = reciprocal(u32::from(q[i]) << 3);
            d.recip[i] = r;
            d.corr[i] = c;
            d.shift[i] = s;
        }
        d
    }

    /// jcdctmgr.c `quantize` (16-bit DCTELEM, 32-bit product).
    fn quantize(&self, ws: &[i32; 64], out: &mut [i16; 64]) {
        for i in 0..64 {
            let t = ws[i] as i16;
            let mag = i32::from(t).unsigned_abs();
            let prod = (mag + self.corr[i]).wrapping_mul(self.recip[i]);
            let v = (prod >> self.shift[i]) as i16;
            out[i] = if t < 0 { v.wrapping_neg() } else { v };
        }
    }
}

const CONST_BITS: i64 = 13;
const PASS1_BITS: i64 = 2;
const FIX_0_298631336: i64 = 2446;
const FIX_0_390180644: i64 = 3196;
const FIX_0_541196100: i64 = 4433;
const FIX_0_765366865: i64 = 6270;
const FIX_0_899976223: i64 = 7373;
const FIX_1_175875602: i64 = 9633;
const FIX_1_501321110: i64 = 12299;
const FIX_1_847759065: i64 = 15137;
const FIX_1_961570560: i64 = 16069;
const FIX_2_053119869: i64 = 16819;
const FIX_2_562915447: i64 = 20995;
const FIX_3_072711026: i64 = 25172;

fn descale(x: i64, n: i64) -> i64 {
    (x + (1 << (n - 1))) >> n
}

/// `jpeg_fdct_islow` in place (values stored back as 16-bit DCTELEMs).
fn fdct_islow(d: &mut [i32; 64]) {
    let st = |v: i64| -> i32 { i32::from(v as i16) };
    for row in 0..8 {
        let p = &mut d[row * 8..row * 8 + 8];
        let (d0, d1, d2, d3, d4, d5, d6, d7) = (
            i64::from(p[0]),
            i64::from(p[1]),
            i64::from(p[2]),
            i64::from(p[3]),
            i64::from(p[4]),
            i64::from(p[5]),
            i64::from(p[6]),
            i64::from(p[7]),
        );
        let tmp0 = d0 + d7;
        let tmp7 = d0 - d7;
        let tmp1 = d1 + d6;
        let tmp6 = d1 - d6;
        let tmp2 = d2 + d5;
        let tmp5 = d2 - d5;
        let tmp3 = d3 + d4;
        let tmp4 = d3 - d4;
        let tmp10 = tmp0 + tmp3;
        let tmp13 = tmp0 - tmp3;
        let tmp11 = tmp1 + tmp2;
        let tmp12 = tmp1 - tmp2;
        p[0] = st((tmp10 + tmp11) << PASS1_BITS);
        p[4] = st((tmp10 - tmp11) << PASS1_BITS);
        let z1 = (tmp12 + tmp13) * FIX_0_541196100;
        p[2] = st(descale(
            z1 + tmp13 * FIX_0_765366865,
            CONST_BITS - PASS1_BITS,
        ));
        p[6] = st(descale(
            z1 + tmp12 * -FIX_1_847759065,
            CONST_BITS - PASS1_BITS,
        ));
        let z1 = tmp4 + tmp7;
        let z2 = tmp5 + tmp6;
        let z3 = tmp4 + tmp6;
        let z4 = tmp5 + tmp7;
        let z5 = (z3 + z4) * FIX_1_175875602;
        let t4 = tmp4 * FIX_0_298631336;
        let t5 = tmp5 * FIX_2_053119869;
        let t6 = tmp6 * FIX_3_072711026;
        let t7 = tmp7 * FIX_1_501321110;
        let z1 = z1 * -FIX_0_899976223;
        let z2 = z2 * -FIX_2_562915447;
        let z3 = z3 * -FIX_1_961570560 + z5;
        let z4 = z4 * -FIX_0_390180644 + z5;
        p[7] = st(descale(t4 + z1 + z3, CONST_BITS - PASS1_BITS));
        p[5] = st(descale(t5 + z2 + z4, CONST_BITS - PASS1_BITS));
        p[3] = st(descale(t6 + z2 + z3, CONST_BITS - PASS1_BITS));
        p[1] = st(descale(t7 + z1 + z4, CONST_BITS - PASS1_BITS));
    }
    for col in 0..8 {
        let g = |r: usize| i64::from(d[r * 8 + col]);
        let tmp0 = g(0) + g(7);
        let tmp7 = g(0) - g(7);
        let tmp1 = g(1) + g(6);
        let tmp6 = g(1) - g(6);
        let tmp2 = g(2) + g(5);
        let tmp5 = g(2) - g(5);
        let tmp3 = g(3) + g(4);
        let tmp4 = g(3) - g(4);
        let tmp10 = tmp0 + tmp3;
        let tmp13 = tmp0 - tmp3;
        let tmp11 = tmp1 + tmp2;
        let tmp12 = tmp1 - tmp2;
        d[col] = st(descale(tmp10 + tmp11, PASS1_BITS));
        d[4 * 8 + col] = st(descale(tmp10 - tmp11, PASS1_BITS));
        let z1 = (tmp12 + tmp13) * FIX_0_541196100;
        d[2 * 8 + col] = st(descale(
            z1 + tmp13 * FIX_0_765366865,
            CONST_BITS + PASS1_BITS,
        ));
        d[6 * 8 + col] = st(descale(
            z1 + tmp12 * -FIX_1_847759065,
            CONST_BITS + PASS1_BITS,
        ));
        let z1 = tmp4 + tmp7;
        let z2 = tmp5 + tmp6;
        let z3 = tmp4 + tmp6;
        let z4 = tmp5 + tmp7;
        let z5 = (z3 + z4) * FIX_1_175875602;
        let t4 = tmp4 * FIX_0_298631336;
        let t5 = tmp5 * FIX_2_053119869;
        let t6 = tmp6 * FIX_3_072711026;
        let t7 = tmp7 * FIX_1_501321110;
        let z1 = z1 * -FIX_0_899976223;
        let z2 = z2 * -FIX_2_562915447;
        let z3 = z3 * -FIX_1_961570560 + z5;
        let z4 = z4 * -FIX_0_390180644 + z5;
        d[7 * 8 + col] = st(descale(t4 + z1 + z3, CONST_BITS + PASS1_BITS));
        d[5 * 8 + col] = st(descale(t5 + z2 + z4, CONST_BITS + PASS1_BITS));
        d[3 * 8 + col] = st(descale(t6 + z2 + z3, CONST_BITS + PASS1_BITS));
        d[8 + col] = st(descale(t7 + z1 + z4, CONST_BITS + PASS1_BITS));
    }
}

/// jccolor.c's RGB → YCbCr tables.
struct RgbYcc {
    tab: Vec<i64>,
}

impl RgbYcc {
    const R_Y: usize = 0;
    const G_Y: usize = 256;
    const B_Y: usize = 512;
    const R_CB: usize = 768;
    const G_CB: usize = 1024;
    const B_CB: usize = 1280;
    const G_CR: usize = 1536;
    const B_CR: usize = 1792;

    fn new() -> Self {
        const SCALEBITS: i64 = 16;
        const ONE_HALF: i64 = 1 << (SCALEBITS - 1);
        const CBCR_OFFSET: i64 = 128 << SCALEBITS;
        let fix = |x: f64| (x * f64::from(1u32 << SCALEBITS) + 0.5) as i64;
        let mut tab = vec![0i64; 8 * 256];
        for i in 0..256usize {
            let v = i as i64;
            tab[Self::R_Y + i] = fix(0.299_00) * v;
            tab[Self::G_Y + i] = fix(0.587_00) * v;
            tab[Self::B_Y + i] = fix(0.114_00) * v + ONE_HALF;
            tab[Self::R_CB + i] = -fix(0.168_74) * v;
            tab[Self::G_CB + i] = -fix(0.331_26) * v;
            tab[Self::B_CB + i] = fix(0.500_00) * v + CBCR_OFFSET + ONE_HALF - 1;
            tab[Self::G_CR + i] = -fix(0.418_69) * v;
            tab[Self::B_CR + i] = -fix(0.081_31) * v;
        }
        RgbYcc { tab }
    }

    fn convert(&self, r: u8, g: u8, b: u8) -> (u8, u8, u8) {
        let (r, g, b) = (usize::from(r), usize::from(g), usize::from(b));
        let t = &self.tab;
        let y = (t[Self::R_Y + r] + t[Self::G_Y + g] + t[Self::B_Y + b]) >> 16;
        let cb = (t[Self::R_CB + r] + t[Self::G_CB + g] + t[Self::B_CB + b]) >> 16;
        // R → Cr shares the B → Cb table
        let cr = (t[Self::B_CB + r] + t[Self::G_CR + g] + t[Self::B_CR + b]) >> 16;
        (y as u8, cb as u8, cr as u8)
    }
}

struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    n: u32,
}

impl BitWriter {
    fn put(&mut self, code: u32, size: u32) {
        if size == 0 {
            return;
        }
        self.acc = (self.acc << size) | u64::from(code & ((1u32 << size) - 1));
        self.n += size;
        while self.n >= 8 {
            self.n -= 8;
            let b = (self.acc >> self.n) as u8;
            self.out.push(b);
            if b == 0xFF {
                self.out.push(0);
            }
        }
    }

    fn flush(&mut self) {
        if self.n > 0 {
            let b = ((self.acc << (8 - self.n)) as u8) | (0xFFu8 >> self.n);
            self.out.push(b);
            if b == 0xFF {
                self.out.push(0);
            }
            self.n = 0;
            self.acc = 0;
        }
    }
}

fn nbits(v: u32) -> u32 {
    32 - v.leading_zeros()
}

fn encode_block(
    w: &mut BitWriter,
    block: &[i16; 64],
    last_dc: &mut i32,
    dc: &Encoder,
    ac: &Encoder,
) {
    let mut temp = i32::from(block[0]) - *last_dc;
    *last_dc = i32::from(block[0]);
    let mut temp2 = temp;
    if temp < 0 {
        temp = -temp;
        temp2 -= 1;
    }
    let nb = nbits(temp as u32);
    w.put(dc.code[nb as usize], u32::from(dc.size[nb as usize]));
    w.put(temp2 as u32, nb);
    let mut r = 0u32;
    for k in 1..64 {
        let mut temp = i32::from(block[NATURAL_ORDER[k]]);
        if temp == 0 {
            r += 1;
            continue;
        }
        while r > 15 {
            w.put(ac.code[0xF0], u32::from(ac.size[0xF0]));
            r -= 16;
        }
        let mut temp2 = temp;
        if temp < 0 {
            temp = -temp;
            temp2 -= 1;
        }
        let nb = nbits(temp as u32);
        let i = ((r << 4) + nb) as usize;
        w.put(ac.code[i], u32::from(ac.size[i]));
        w.put(temp2 as u32, nb);
        r = 0;
    }
    if r > 0 {
        w.put(ac.code[0], u32::from(ac.size[0]));
    }
}

fn marker(out: &mut Vec<u8>, m: u8, body: &[u8]) {
    out.extend_from_slice(&[0xFF, m]);
    out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(body);
}

fn dht(out: &mut Vec<u8>, class_index: u8, spec: &Spec) {
    let mut body = vec![class_index];
    body.extend_from_slice(&spec.bits[1..]);
    body.extend_from_slice(&spec.values);
    marker(out, 0xC4, &body);
}

/// Pillow's ICC APP2 markers: chunks of at most 65,519 bytes, numbered from 1.
fn icc_markers(icc: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let chunks: Vec<&[u8]> = icc.chunks(65_533 - 14).collect();
    let total = chunks.len() as u8;
    for (i, c) in chunks.iter().enumerate() {
        let mut body = b"ICC_PROFILE\0".to_vec();
        body.push((i + 1) as u8);
        body.push(total);
        body.extend_from_slice(c);
        marker(&mut out, 0xE2, &body);
    }
    out
}

/// Encodes an RGB image (3 bytes a pixel, rows top to bottom) as Pillow saves it with `quality` (and `icc_profile`).
///
/// # Panics
/// Never for consistent inputs: `rgb` must hold `width × height × 3` bytes, both dimensions 1–65,535.
#[must_use]
pub fn encode_rgb(
    width: usize,
    height: usize,
    rgb: &[u8],
    quality: u8,
    icc: Option<&[u8]>,
) -> Vec<u8> {
    let (w, h) = (width, height);
    let conv = RgbYcc::new();
    // full-size planes
    let mut yp = vec![0u8; w * h];
    let mut cbp = vec![0u8; w * h];
    let mut crp = vec![0u8; w * h];
    for i in 0..w * h {
        let (y, cb, cr) = conv.convert(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
        yp[i] = y;
        cbp[i] = cb;
        crp[i] = cr;
    }
    let mcus_x = w.div_ceil(16);
    let mcus_y = h.div_ceil(16);
    let y_wb = w.div_ceil(8);
    let y_hb = h.div_ceil(8);
    // Y padded: right edge and bottom rows replicated
    let ypw = y_wb * 8;
    let yph = mcus_y * 16;
    let mut ypad = vec![0u8; ypw * yph];
    for yy in 0..yph {
        let sy = yy.min(h - 1);
        for xx in 0..ypw {
            ypad[yy * ypw + xx] = yp[sy * w + xx.min(w - 1)];
        }
    }
    // chroma: h2v2_downsample over the edge-expanded rows, then the last row replicated to the iMCU height
    let cw = mcus_x * 8;
    let ch = mcus_y * 8;
    let real_rows = h.div_ceil(2);
    let down = |p: &[u8]| -> Vec<u8> {
        let mut out = vec![0u8; cw * ch];
        for cy in 0..ch {
            let ry = cy.min(real_rows - 1);
            let (r0, r1) = ((2 * ry).min(h - 1), (2 * ry + 1).min(h - 1));
            let mut bias = 1u32;
            for cx in 0..cw {
                let (c0, c1) = ((2 * cx).min(w - 1), (2 * cx + 1).min(w - 1));
                let s = u32::from(p[r0 * w + c0])
                    + u32::from(p[r0 * w + c1])
                    + u32::from(p[r1 * w + c0])
                    + u32::from(p[r1 * w + c1]);
                out[cy * cw + cx] = ((s + bias) >> 2) as u8;
                bias ^= 3;
            }
        }
        out
    };
    let cbd = down(&cbp);
    let crd = down(&crp);

    let ql = quant_table(&STD_LUMINANCE, quality);
    let qc = quant_table(&STD_CHROMINANCE, quality);
    let dl = Divisors::new(&ql);
    let dcq = Divisors::new(&qc);
    let (sdl, sdc, sal, sac) = (
        std_dc_luminance(),
        std_dc_chrominance(),
        std_ac_luminance(),
        std_ac_chrominance(),
    );
    let (edl, edc, eal, eac) = (
        Encoder::new(&sdl),
        Encoder::new(&sdc),
        Encoder::new(&sal),
        Encoder::new(&sac),
    );

    let mut out = Vec::with_capacity(w * h / 2 + 1024);
    out.extend_from_slice(&[0xFF, 0xD8]);
    marker(
        &mut out,
        0xE0,
        &[b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    );
    if let Some(icc) = icc.filter(|i| !i.is_empty()) {
        out.extend_from_slice(&icc_markers(icc));
    }
    for (idx, q) in [(0u8, &ql), (1u8, &qc)] {
        let mut body = vec![idx];
        for i in 0..64 {
            body.push(q[NATURAL_ORDER[i]] as u8);
        }
        marker(&mut out, 0xDB, &body);
    }
    let mut sof = vec![8];
    sof.extend_from_slice(&(h as u16).to_be_bytes());
    sof.extend_from_slice(&(w as u16).to_be_bytes());
    sof.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    marker(&mut out, 0xC0, &sof);
    dht(&mut out, 0x00, &sdl);
    dht(&mut out, 0x10, &sal);
    dht(&mut out, 0x01, &sdc);
    dht(&mut out, 0x11, &sac);
    marker(&mut out, 0xDA, &[3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

    let mut bw = BitWriter { out, acc: 0, n: 0 };
    let mut last = [0i32; 3];
    let mut ws = [0i32; 64];
    let mut q = [0i16; 64];
    let fdct_block = |plane: &[u8],
                      stride: usize,
                      x0: usize,
                      y0: usize,
                      d: &Divisors,
                      ws: &mut [i32; 64],
                      q: &mut [i16; 64]| {
        for r in 0..8 {
            for c in 0..8 {
                ws[r * 8 + c] = i32::from(plane[(y0 + r) * stride + x0 + c]) - 128;
            }
        }
        fdct_islow(ws);
        d.quantize(ws, q);
    };
    for my in 0..mcus_y {
        for mx in 0..mcus_x {
            // Y: 2 × 2 blocks; dummy blocks past width_in_blocks / height_in_blocks keep the previous DC
            let mut y_blocks = [[0i16; 64]; 4];
            for v in 0..2 {
                for hh in 0..2 {
                    let (bx, by) = (mx * 2 + hh, my * 2 + v);
                    let k = v * 2 + hh;
                    if by < y_hb || my + 1 < mcus_y {
                        if bx < y_wb {
                            fdct_block(&ypad, ypw, bx * 8, by * 8, &dl, &mut ws, &mut q);
                            y_blocks[k] = q;
                        } else {
                            let prev = y_blocks[k - 1][0];
                            y_blocks[k] = [0; 64];
                            y_blocks[k][0] = prev;
                        }
                    } else {
                        // a dummy row at the bottom: every block takes the DC of the block before the row
                        let prev = y_blocks[v * 2 - 1][0];
                        y_blocks[k] = [0; 64];
                        y_blocks[k][0] = prev;
                    }
                }
            }
            for b in &y_blocks {
                encode_block(&mut bw, b, &mut last[0], &edl, &eal);
            }
            fdct_block(&cbd, cw, mx * 8, my * 8, &dcq, &mut ws, &mut q);
            encode_block(&mut bw, &q, &mut last[1], &edc, &eac);
            fdct_block(&crd, cw, mx * 8, my * 8, &dcq, &mut ws, &mut q);
            encode_block(&mut bw, &q, &mut last[2], &edc, &eac);
        }
    }
    bw.flush();
    let mut out = bw.out;
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn quality_tables() {
        let q = quant_table(&STD_LUMINANCE, 92);
        assert_eq!(&q[..4], &[3, 2, 2, 3]);
        let q = quant_table(&STD_LUMINANCE, 75);
        assert_eq!(&q[..4], &[8, 6, 5, 8]);
    }

    #[test]
    fn reciprocal_rounds_like_division() {
        for d in [8u32, 16, 24, 88, 792, 2040] {
            let (r, c, s) = reciprocal(d);
            for t in 0..20000u32 {
                let q = ((t + c) * r) >> s;
                let want = (t + d / 2) / d;
                assert!(
                    q == want || q + 1 == want || q == want + 1,
                    "{d} {t}: {q} vs {want}"
                );
            }
        }
    }

    #[test]
    fn decodes_back() {
        let (w, h) = (37usize, 21usize);
        let mut rgb = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = 3 * (y * w + x);
                rgb[i] = (x * 6) as u8;
                rgb[i + 1] = (y * 11) as u8;
                rgb[i + 2] = 128;
            }
        }
        let jpg = encode_rgb(w, h, &rgb, 92, None);
        let d = super::super::decode::decode(&jpg).unwrap();
        assert_eq!((d.width, d.height), (w, h));
        let err: u32 = d
            .pixels
            .iter()
            .zip(&rgb)
            .map(|(a, b)| u32::from(a.abs_diff(*b)))
            .max()
            .unwrap();
        assert!(err < 24, "max error {err}");
    }
}
