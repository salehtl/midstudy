//! The JPEG decoder, as Pillow drives libjpeg-turbo for `Image.open(…).load()` (no draft, no scaling): baseline and
//! progressive Huffman scans, the accurate integer IDCT (`jidctint.c`), fancy upsampling (`jdsample.c`: h2v1, h1v2,
//! h2v2 with the image edges replicated, box replication otherwise), and the colour conversions of `jdcolor.c` into
//! what Pillow asks for: L for one component, RGB for three, CMYK for four (then inverted, Pillow's "CMYK;I").
//!
//! Also what Pillow's `JpegImagePlugin` collects on the way: the first EXIF APP1, the XMP APP1 and the ICC profile
//! from APP2 chunks seen before the frame header.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::many_single_char_names,
    clippy::similar_names,
    clippy::too_many_lines,
    clippy::needless_range_loop
)]

use super::NATURAL_ORDER;
use super::huffman::{Decoder, LOOKAHEAD, Spec};

/// Pillow's mode for the decoded pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    L,
    Rgb,
    Cmyk,
}

impl Mode {
    #[must_use]
    pub fn channels(self) -> usize {
        match self {
            Mode::L => 1,
            Mode::Rgb => 3,
            Mode::Cmyk => 4,
        }
    }
}

/// A decoded JPEG and the metadata Pillow keeps in `info`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub mode: Mode,
    pub pixels: Vec<u8>,
    /// The first APP1 segment that starts with `Exif\0\0`, whole.
    pub exif: Option<Vec<u8>>,
    /// The XMP packet of an APP1 `http://ns.adobe.com/xap/1.0/\0` segment.
    pub xmp: Option<Vec<u8>>,
    /// The ICC profile reassembled from APP2 chunks (Pillow's rule: sorted, complete or nothing).
    pub icc: Option<Vec<u8>>,
}

/// What the frame header says (Pillow's `Image.open` reads only this far).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub width: usize,
    pub height: usize,
    pub mode: Mode,
    pub progressive: bool,
}

/// Why a JPEG couldn't be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JpegError {
    /// Doesn't start with FF D8 FF.
    NotJpeg,
    /// No frame header before the first scan, or no scan.
    NoFrame,
    /// The data ends before the image does (Pillow: "image file is truncated").
    Truncated,
    /// A coding process Pillow's libjpeg-turbo reads but this decoder doesn't (arithmetic, lossless, 12-bit).
    Unsupported(&'static str),
    /// Malformed segments or tables.
    Corrupt(&'static str),
    /// More pixels than the decoder takes.
    TooLarge,
}

/// The most pixels decoded (Pillow's decompression-bomb error starts at 2 × 89,478,485).
pub const MAX_PIXELS: usize = 178_956_970;

#[derive(Clone, Debug)]
struct Component {
    id: u8,
    h: usize,
    v: usize,
    tq: usize,
    /// Blocks per row and rows of blocks the image needs.
    width_in_blocks: usize,
    height_in_blocks: usize,
    /// Samples per row and rows at this component's resolution.
    ds_width: usize,
    ds_height: usize,
    /// The allocated block grid (whole MCUs).
    bw: usize,
    bh: usize,
    coefs: Vec<i16>,
    quant: Option<[u16; 64]>,
}

struct Frame {
    width: usize,
    height: usize,
    progressive: bool,
    comps: Vec<Component>,
    max_h: usize,
    max_v: usize,
    mcus_x: usize,
    mcus_y: usize,
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    acc: u64,
    n: u32,
    /// A marker met in the entropy-coded data (after it, zeros are read).
    marker: Option<u8>,
    /// The data ran out without a marker.
    eof: bool,
    /// Zero bits appended after the data ran out.
    pad: u32,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Bits {
            data,
            pos,
            acc: 0,
            n: 0,
            marker: None,
            eof: false,
            pad: 0,
        }
    }

    fn fill(&mut self) {
        while self.n <= 56 {
            if self.marker.is_some() || self.eof {
                self.acc <<= 8;
                self.n += 8;
                if self.eof && self.marker.is_none() {
                    self.pad += 8;
                }
                continue;
            }
            let Some(&b) = self.data.get(self.pos) else {
                self.eof = true;
                continue;
            };
            self.pos += 1;
            if b == 0xFF {
                // FF fill bytes before a marker; FF 00 is a data FF.
                let mut c = 0xFF;
                while c == 0xFF {
                    let Some(&x) = self.data.get(self.pos) else {
                        self.eof = true;
                        break;
                    };
                    self.pos += 1;
                    c = x;
                }
                if self.eof {
                    continue;
                }
                if c == 0 {
                    self.acc = (self.acc << 8) | 0xFF;
                    self.n += 8;
                } else {
                    self.marker = Some(c);
                }
                continue;
            }
            self.acc = (self.acc << 8) | u64::from(b);
            self.n += 8;
        }
    }

    /// Whether bits past the end of the data were used (the file is cut short).
    fn overran(&self) -> bool {
        self.pad > self.n
    }

    fn bits(&mut self, k: u32) -> u32 {
        if k == 0 {
            return 0;
        }
        if self.n < k {
            self.fill();
        }
        self.n -= k;
        ((self.acc >> self.n) & ((1u64 << k) - 1)) as u32
    }

    fn peek(&mut self, k: u32) -> u32 {
        if self.n < k {
            self.fill();
        }
        ((self.acc >> (self.n - k)) & ((1u64 << k) - 1)) as u32
    }

    fn decode(&mut self, t: &Decoder) -> u8 {
        let look = self.peek(LOOKAHEAD) as usize;
        let (len, sym) = t.fast[look];
        if len > 0 {
            self.n -= u32::from(len);
            return sym;
        }
        // jpeg_huff_decode: one bit at a time past the lookahead
        let mut code = i64::from(self.bits(1));
        let mut l = 1usize;
        while l <= 16 && code > t.maxcode[l] {
            code = (code << 1) | i64::from(self.bits(1));
            l += 1;
        }
        if l > 16 {
            return 0; // a bad code: libjpeg warns and decodes 0
        }
        let idx = code + t.valoffset[l];
        usize::try_from(idx)
            .ok()
            .and_then(|i| t.values.get(i))
            .copied()
            .unwrap_or(0)
    }

    /// Drops the bits left in the buffer and finds the next marker (for a restart): the one already met, or the
    /// next FF xx in the data.
    fn restart_marker(&mut self) -> Option<u8> {
        self.acc = 0;
        self.n = 0;
        self.pad = 0;
        if let Some(m) = self.marker.take() {
            return Some(m);
        }
        while let Some(&b) = self.data.get(self.pos) {
            self.pos += 1;
            if b == 0xFF {
                while self.data.get(self.pos) == Some(&0xFF) {
                    self.pos += 1;
                }
                if let Some(&c) = self.data.get(self.pos) {
                    self.pos += 1;
                    if c != 0 {
                        return Some(c);
                    }
                }
            }
        }
        self.eof = true;
        None
    }
}

fn extend(v: u32, s: u32) -> i32 {
    if s == 0 {
        return 0;
    }
    let v = v as i32;
    if v < (1 << (s - 1)) {
        v + ((-1i32) << s) + 1
    } else {
        v
    }
}

fn be16(d: &[u8], at: usize) -> Option<usize> {
    Some(usize::from(u16::from_be_bytes([
        *d.get(at)?,
        *d.get(at + 1)?,
    ])))
}

/// Pillow's ICC reassembly: the chunks sorted (by their bytes, so by sequence number), joined when the first says
/// there are as many as there are.
fn icc_profile(chunks: &mut [Vec<u8>]) -> Option<Vec<u8>> {
    if chunks.is_empty() {
        return None;
    }
    chunks.sort();
    let want = usize::from(*chunks.first()?.get(13)?);
    if want != chunks.len() {
        return None;
    }
    let mut out = Vec::new();
    for c in chunks.iter() {
        out.extend_from_slice(c.get(14..).unwrap_or(&[]));
    }
    Some(out)
}

struct Parsed<'a> {
    data: &'a [u8],
    frame: Option<Frame>,
    exif: Option<Vec<u8>>,
    xmp: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
    jfif: bool,
    adobe: Option<u8>,
}

/// Reads the frame header and what precedes the first scan, as Pillow's `Image.open` does.
///
/// # Errors
/// [`JpegError`] when Pillow couldn't open it as a JPEG.
pub fn header(data: &[u8]) -> Result<Header, JpegError> {
    let mut d = Decoder8::new(data)?;
    d.run(true)?;
    let f = d.p.frame.as_ref().ok_or(JpegError::NoFrame)?;
    Ok(Header {
        width: f.width,
        height: f.height,
        mode: d.mode(),
        progressive: f.progressive,
    })
}

/// Decodes a JPEG into Pillow's pixels.
///
/// # Errors
/// [`JpegError`] for what Pillow couldn't load, or what this decoder doesn't support.
pub fn decode(data: &[u8]) -> Result<Decoded, JpegError> {
    let mut d = Decoder8::new(data)?;
    d.run(false)?;
    d.finish()
}

struct Decoder8<'a> {
    p: Parsed<'a>,
    qt: [Option<[u16; 64]>; 4],
    dc: [Option<Decoder>; 4],
    ac: [Option<Decoder>; 4],
    restart: usize,
    icc_chunks: Vec<Vec<u8>>,
    scans: usize,
}

impl<'a> Decoder8<'a> {
    fn new(data: &'a [u8]) -> Result<Self, JpegError> {
        if !data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Err(JpegError::NotJpeg);
        }
        Ok(Decoder8 {
            p: Parsed {
                data,
                frame: None,
                exif: None,
                xmp: None,
                icc: None,
                jfif: false,
                adobe: None,
            },
            qt: [None; 4],
            dc: [None, None, None, None],
            ac: [None, None, None, None],
            restart: 0,
            icc_chunks: Vec::new(),
            scans: 0,
        })
    }

    fn mode(&self) -> Mode {
        match self.p.frame.as_ref().map_or(0, |f| f.comps.len()) {
            1 => Mode::L,
            4 => Mode::Cmyk,
            _ => Mode::Rgb,
        }
    }

    /// Walks the segments; decodes each scan unless `header_only` (then it stops at the first SOS).
    fn run(&mut self, header_only: bool) -> Result<(), JpegError> {
        let data = self.p.data;
        let mut pos = 2usize;
        loop {
            // next marker: skip anything that isn't FF, then FF fill bytes
            let mut m;
            loop {
                let Some(&b) = data.get(pos) else {
                    // the data ends: a missing EOI after complete scans is fine (libjpeg has every row)
                    return if self.scans > 0 && !header_only {
                        Ok(())
                    } else if self.p.frame.is_some() {
                        Err(JpegError::Truncated)
                    } else {
                        Err(JpegError::NoFrame)
                    };
                };
                pos += 1;
                if b != 0xFF {
                    continue;
                }
                m = 0xFF;
                while m == 0xFF {
                    m = *data.get(pos).ok_or(JpegError::Truncated)?;
                    pos += 1;
                }
                if m != 0 {
                    break;
                }
            }
            match m {
                0xD8 | 0x01 | 0xD0..=0xD7 => {}
                0xD9 => {
                    return if self.scans > 0 {
                        Ok(())
                    } else {
                        Err(JpegError::NoFrame)
                    };
                }
                _ => {
                    let len = be16(data, pos).ok_or(JpegError::Truncated)?;
                    if len < 2 {
                        return Err(JpegError::Corrupt("bad marker length"));
                    }
                    let seg = data.get(pos + 2..pos + len).ok_or(JpegError::Truncated)?;
                    pos += len;
                    match m {
                        0xC0..=0xC2 => self.sof(m, seg)?,
                        0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                            return Err(JpegError::Unsupported(
                                "an arithmetic-coded, lossless or hierarchical JPEG",
                            ));
                        }
                        0xC4 => self.dht(seg)?,
                        0xDB => self.dqt(seg)?,
                        0xDD => {
                            self.restart = be16(seg, 0).ok_or(JpegError::Corrupt("bad DRI"))?;
                        }
                        0xE0 if seg.len() >= 14 && seg.starts_with(b"JFIF\0") => self.p.jfif = true,
                        0xE1 if seg.starts_with(b"Exif\0\0") && self.p.exif.is_none() => {
                            self.p.exif = Some(seg.to_vec());
                        }
                        0xE1 if seg.starts_with(b"Exif\0\0") => {}
                        0xE1 if seg.starts_with(b"http://ns.adobe.com/xap/1.0/\0") => {
                            let at = seg
                                .iter()
                                .position(|&b| b == 0)
                                .map_or(seg.len(), |i| i + 1);
                            self.p.xmp = Some(seg.get(at..).unwrap_or(&[]).to_vec());
                        }
                        0xE2 if seg.starts_with(b"ICC_PROFILE\0") && self.p.frame.is_none() => {
                            self.icc_chunks.push(seg.to_vec());
                        }
                        0xEE if seg.len() >= 12 && seg.starts_with(b"Adobe") => {
                            self.p.adobe = seg.get(11).copied();
                        }
                        0xDA => {
                            if self.p.frame.is_none() {
                                return Err(JpegError::NoFrame);
                            }
                            if header_only {
                                return Ok(());
                            }
                            pos = self.sos(seg, pos)?;
                            self.scans += 1;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    fn sof(&mut self, m: u8, s: &[u8]) -> Result<(), JpegError> {
        if self.p.frame.is_some() {
            return Err(JpegError::Corrupt("two frame headers"));
        }
        let precision = *s.first().ok_or(JpegError::Corrupt("bad SOF"))?;
        if precision != 8 {
            return Err(JpegError::Unsupported("a 12-bit JPEG"));
        }
        let height = be16(s, 1).ok_or(JpegError::Corrupt("bad SOF"))?;
        let width = be16(s, 3).ok_or(JpegError::Corrupt("bad SOF"))?;
        let nc = usize::from(*s.get(5).ok_or(JpegError::Corrupt("bad SOF"))?);
        if !matches!(nc, 1 | 3 | 4) {
            return Err(JpegError::Unsupported(
                "a JPEG that isn't grey, RGB or CMYK",
            ));
        }
        if width == 0 || height == 0 {
            return Err(JpegError::Corrupt("empty image"));
        }
        if width.saturating_mul(height) > MAX_PIXELS {
            return Err(JpegError::TooLarge);
        }
        let mut comps = Vec::with_capacity(nc);
        for i in 0..nc {
            let c = s
                .get(6 + 3 * i..9 + 3 * i)
                .ok_or(JpegError::Corrupt("bad SOF"))?;
            let (h, v) = (usize::from(c[1] >> 4), usize::from(c[1] & 15));
            if !(1..=4).contains(&h) || !(1..=4).contains(&v) || c[2] > 3 {
                return Err(JpegError::Corrupt("bad sampling factors"));
            }
            comps.push(Component {
                id: c[0],
                h,
                v,
                tq: usize::from(c[2]),
                width_in_blocks: 0,
                height_in_blocks: 0,
                ds_width: 0,
                ds_height: 0,
                bw: 0,
                bh: 0,
                coefs: Vec::new(),
                quant: None,
            });
        }
        let max_h = comps.iter().map(|c| c.h).max().unwrap_or(1);
        let max_v = comps.iter().map(|c| c.v).max().unwrap_or(1);
        if comps
            .iter()
            .any(|c| !max_h.is_multiple_of(c.h) || !max_v.is_multiple_of(c.v))
        {
            return Err(JpegError::Unsupported("fractional chroma sampling"));
        }
        let mcus_x = width.div_ceil(8 * max_h);
        let mcus_y = height.div_ceil(8 * max_v);
        for c in &mut comps {
            c.ds_width = (width * c.h).div_ceil(max_h);
            c.ds_height = (height * c.v).div_ceil(max_v);
            c.width_in_blocks = (width * c.h).div_ceil(max_h * 8);
            c.height_in_blocks = (height * c.v).div_ceil(max_v * 8);
            c.bw = mcus_x * c.h;
            c.bh = mcus_y * c.v;
            c.coefs = vec![0; c.bw * c.bh * 64];
        }
        self.p.frame = Some(Frame {
            width,
            height,
            progressive: m == 0xC2,
            comps,
            max_h,
            max_v,
            mcus_x,
            mcus_y,
        });
        let mut chunks = std::mem::take(&mut self.icc_chunks);
        self.p.icc = icc_profile(&mut chunks);
        Ok(())
    }

    fn dht(&mut self, mut s: &[u8]) -> Result<(), JpegError> {
        while !s.is_empty() {
            let tc = s[0];
            let mut bits = [0u8; 17];
            let counts = s.get(1..17).ok_or(JpegError::Corrupt("bad DHT"))?;
            bits[1..].copy_from_slice(counts);
            let n: usize = counts.iter().map(|&b| usize::from(b)).sum();
            if n > 256 {
                return Err(JpegError::Corrupt("bad DHT"));
            }
            let values = s
                .get(17..17 + n)
                .ok_or(JpegError::Corrupt("bad DHT"))?
                .to_vec();
            let table = Decoder::new(&Spec { bits, values })
                .map_err(|_| JpegError::Corrupt("bad Huffman table"))?;
            let idx = usize::from(tc & 15);
            if idx > 3 {
                return Err(JpegError::Corrupt("bad DHT"));
            }
            if tc >> 4 == 0 {
                self.dc[idx] = Some(table);
            } else {
                self.ac[idx] = Some(table);
            }
            s = &s[17 + n..];
        }
        Ok(())
    }

    fn dqt(&mut self, mut s: &[u8]) -> Result<(), JpegError> {
        while !s.is_empty() {
            let pq = s[0] >> 4;
            let tq = usize::from(s[0] & 15);
            if tq > 3 {
                return Err(JpegError::Corrupt("bad DQT"));
            }
            let mut t = [0u16; 64];
            let size = if pq == 0 { 64 } else { 128 };
            let body = s.get(1..1 + size).ok_or(JpegError::Corrupt("bad DQT"))?;
            for i in 0..64 {
                let v = if pq == 0 {
                    u16::from(body[i])
                } else {
                    u16::from_be_bytes([body[2 * i], body[2 * i + 1]])
                };
                t[NATURAL_ORDER[i]] = v;
            }
            self.qt[tq] = Some(t);
            s = &s[1 + size..];
        }
        Ok(())
    }

    /// Decodes one scan; returns where the data after it starts (at its marker).
    fn sos(&mut self, s: &[u8], data_pos: usize) -> Result<usize, JpegError> {
        let ns = usize::from(*s.first().ok_or(JpegError::Corrupt("bad SOS"))?);
        if ns == 0 || ns > 4 {
            return Err(JpegError::Corrupt("bad SOS"));
        }
        let frame = self.p.frame.as_mut().ok_or(JpegError::NoFrame)?;
        let mut members = Vec::with_capacity(ns);
        for i in 0..ns {
            let c = s
                .get(1 + 2 * i..3 + 2 * i)
                .ok_or(JpegError::Corrupt("bad SOS"))?;
            let ci = frame
                .comps
                .iter()
                .position(|x| x.id == c[0])
                .ok_or(JpegError::Corrupt("bad SOS component"))?;
            members.push((ci, usize::from(c[1] >> 4), usize::from(c[1] & 15)));
        }
        let tail = s
            .get(1 + 2 * ns..4 + 2 * ns)
            .ok_or(JpegError::Corrupt("bad SOS"))?;
        let (ss, se, ah, al) = (
            usize::from(tail[0]),
            usize::from(tail[1]),
            u32::from(tail[2] >> 4),
            u32::from(tail[2] & 15),
        );
        // latch each component's quantization table at its first scan (jdinput.c latch_quant_tables)
        for &(ci, _, _) in &members {
            let c = &mut frame.comps[ci];
            if c.quant.is_none() {
                c.quant =
                    Some(self.qt[c.tq].ok_or(JpegError::Corrupt("missing quantization table"))?);
            }
        }
        let progressive = frame.progressive;
        if progressive
            && (se > 63 || ss > se || (ss == 0 && se != 0) || (ss > 0 && ns != 1) || al > 13)
        {
            return Err(JpegError::Corrupt("bad progressive scan"));
        }
        let mut bits = Bits::new(self.p.data, data_pos);
        let mut pred = [0i32; 4];
        let mut eobrun: u32 = 0;
        let interleaved = ns > 1;
        let (mcus_x, mcus_y) = if interleaved {
            (frame.mcus_x, frame.mcus_y)
        } else {
            let c = &frame.comps[members[0].0];
            (c.width_in_blocks, c.height_in_blocks)
        };
        let total = mcus_x * mcus_y;
        let restart = self.restart;
        let tables_dc: Vec<Option<&Decoder>> =
            members.iter().map(|m| self.dc[m.1].as_ref()).collect();
        let tables_ac: Vec<Option<&Decoder>> =
            members.iter().map(|m| self.ac[m.2].as_ref()).collect();
        // the tables each kind of scan reads: baseline DC and AC, a first DC scan DC, an AC scan AC
        let need_dc = !progressive || (ss == 0 && ah == 0);
        let need_ac = !progressive || ss > 0;
        for k in 0..members.len() {
            if (need_dc && tables_dc[k].is_none()) || (need_ac && tables_ac[k].is_none()) {
                return Err(JpegError::Corrupt("missing Huffman table"));
            }
        }
        for mcu in 0..total {
            if restart > 0 && mcu > 0 && mcu % restart == 0 {
                // an RSTn resumes the data; any other marker (or the end) leaves the rest of the scan as zeros
                if let Some(m) = bits.restart_marker().filter(|m| !(0xD0..=0xD7).contains(m)) {
                    bits.marker = Some(m);
                }
                pred = [0; 4];
                eobrun = 0;
            }
            let (mx, my) = (mcu % mcus_x, mcu / mcus_x);
            for (k, &(ci, _, _)) in members.iter().enumerate() {
                let comp = &mut frame.comps[ci];
                let (bh, bv) = if interleaved {
                    (comp.h, comp.v)
                } else {
                    (1, 1)
                };
                for v in 0..bv {
                    for h in 0..bh {
                        let (bx, by) = if interleaved {
                            (mx * comp.h + h, my * comp.v + v)
                        } else {
                            (mx, my)
                        };
                        let at = (by * comp.bw + bx) * 64;
                        let block = &mut comp.coefs[at..at + 64];
                        if !progressive {
                            baseline_block(
                                &mut bits,
                                tables_dc[k],
                                tables_ac[k],
                                &mut pred[k],
                                block,
                            );
                        } else if ss == 0 {
                            if ah == 0 {
                                if let Some(t) = tables_dc[k] {
                                    let sym = u32::from(bits.decode(t));
                                    let diff = extend(bits.bits(sym), sym);
                                    pred[k] = pred[k].wrapping_add(diff);
                                    block[0] = (pred[k] << al) as i16;
                                }
                            } else if bits.bits(1) != 0 {
                                block[0] |= (1i32 << al) as i16;
                            }
                        } else if let Some(t) = tables_ac[k] {
                            if ah == 0 {
                                ac_first(&mut bits, t, block, ss, se, al, &mut eobrun);
                            } else {
                                ac_refine(&mut bits, t, block, ss, se, al, &mut eobrun);
                            }
                        }
                    }
                }
            }
            if bits.overran() {
                return Err(JpegError::Truncated);
            }
        }
        // where the scan's data ends: the marker met, or the next one in the data
        let mut pos = bits.pos;
        if bits.marker.is_some() {
            // bits.pos is just past the marker byte: step back to its FF
            pos = pos.saturating_sub(2);
            while pos > 0 && self.p.data.get(pos) != Some(&0xFF) {
                pos -= 1;
            }
        }
        Ok(pos)
    }

    fn finish(self) -> Result<Decoded, JpegError> {
        let mode = self.mode();
        let frame = self.p.frame.ok_or(JpegError::NoFrame)?;
        let (w, h) = (frame.width, frame.height);
        let mut planes = Vec::with_capacity(frame.comps.len());
        for c in &frame.comps {
            let q = c.quant.unwrap_or([1; 64]);
            planes.push(upsample(&idct_plane(c, &q), c, &frame));
        }
        let range = RangeLimit::new();
        let mut pixels = vec![0u8; w * h * mode.channels()];
        match frame.comps.len() {
            1 => pixels.copy_from_slice(&planes[0]),
            3 => {
                // jdapimin.c default_decompress_parms: JFIF means YCbCr; else Adobe's transform (0: RGB); else the
                // component ids ('R' 'G' 'B': RGB); else YCbCr
                let ycc = if self.p.jfif {
                    true
                } else if let Some(t) = self.p.adobe {
                    t != 0
                } else {
                    !(frame.comps[0].id == 82 && frame.comps[1].id == 71 && frame.comps[2].id == 66)
                };
                if ycc {
                    let t = YccTables::new();
                    for i in 0..w * h {
                        let (r, g, b) = t.rgb(planes[0][i], planes[1][i], planes[2][i], &range);
                        pixels[3 * i] = r;
                        pixels[3 * i + 1] = g;
                        pixels[3 * i + 2] = b;
                    }
                } else {
                    for i in 0..w * h {
                        pixels[3 * i] = planes[0][i];
                        pixels[3 * i + 1] = planes[1][i];
                        pixels[3 * i + 2] = planes[2][i];
                    }
                }
            }
            _ => {
                let ycck = self.p.adobe.is_some_and(|t| t != 0);
                let t = YccTables::new();
                for i in 0..w * h {
                    let (c0, c1, c2) = if ycck {
                        let (r, g, b) = t.rgb_unclamped(planes[0][i], planes[1][i], planes[2][i]);
                        (
                            range.simple(255 - r),
                            range.simple(255 - g),
                            range.simple(255 - b),
                        )
                    } else {
                        (planes[0][i], planes[1][i], planes[2][i])
                    };
                    // Pillow's "CMYK;I": Adobe CMYK is stored inverted
                    pixels[4 * i] = 255 - c0;
                    pixels[4 * i + 1] = 255 - c1;
                    pixels[4 * i + 2] = 255 - c2;
                    pixels[4 * i + 3] = 255 - planes[3][i];
                }
            }
        }
        Ok(Decoded {
            width: w,
            height: h,
            mode,
            pixels,
            exif: self.p.exif,
            xmp: self.p.xmp,
            icc: self.p.icc,
        })
    }
}

fn baseline_block(
    bits: &mut Bits<'_>,
    dc: Option<&Decoder>,
    ac: Option<&Decoder>,
    pred: &mut i32,
    block: &mut [i16],
) {
    if let Some(t) = dc {
        let s = u32::from(bits.decode(t));
        let diff = extend(bits.bits(s), s);
        *pred = pred.wrapping_add(diff);
        block[0] = *pred as i16;
    }
    if let Some(t) = ac {
        let mut k = 1usize;
        while k < 64 {
            let rs = bits.decode(t);
            let r = usize::from(rs >> 4);
            let s = u32::from(rs & 15);
            if s != 0 {
                k += r;
                let v = extend(bits.bits(s), s);
                block[NATURAL_ORDER[k.min(79)]] = v as i16;
            } else {
                if r != 15 {
                    break;
                }
                k += 15;
            }
            k += 1;
        }
    }
}

fn ac_first(
    bits: &mut Bits<'_>,
    t: &Decoder,
    block: &mut [i16],
    ss: usize,
    se: usize,
    al: u32,
    eobrun: &mut u32,
) {
    if *eobrun > 0 {
        *eobrun -= 1;
        return;
    }
    let mut k = ss;
    while k <= se {
        let rs = bits.decode(t);
        let r = u32::from(rs >> 4);
        let s = u32::from(rs & 15);
        if s != 0 {
            k += r as usize;
            let v = extend(bits.bits(s), s);
            block[NATURAL_ORDER[k.min(79)]] = (v << al) as i16;
        } else if r == 15 {
            k += 15;
        } else {
            *eobrun = 1 << r;
            if r > 0 {
                *eobrun += bits.bits(r);
            }
            *eobrun -= 1;
            break;
        }
        k += 1;
    }
}

fn ac_refine(
    bits: &mut Bits<'_>,
    t: &Decoder,
    block: &mut [i16],
    ss: usize,
    se: usize,
    al: u32,
    eobrun: &mut u32,
) {
    let p1: i16 = (1i32 << al) as i16;
    let m1: i16 = ((-1i32) << al) as i16;
    let mut k = ss;
    if *eobrun == 0 {
        while k <= se {
            let rs = bits.decode(t);
            let mut r = i32::from(rs >> 4);
            let mut s = i32::from(rs & 15);
            if s != 0 {
                s = if bits.bits(1) != 0 {
                    i32::from(p1)
                } else {
                    i32::from(m1)
                };
            } else if r != 15 {
                *eobrun = 1 << r;
                if r > 0 {
                    *eobrun += bits.bits(r as u32);
                }
                break;
            }
            loop {
                let pos = NATURAL_ORDER[k.min(79)];
                let coef = block[pos];
                if coef != 0 {
                    if bits.bits(1) != 0 && (coef & p1) == 0 {
                        block[pos] = if coef >= 0 {
                            coef.wrapping_add(p1)
                        } else {
                            coef.wrapping_add(m1)
                        };
                    }
                } else {
                    r -= 1;
                    if r < 0 {
                        break;
                    }
                }
                k += 1;
                if k > se {
                    break;
                }
            }
            if s != 0 {
                let pos = NATURAL_ORDER[k.min(79)];
                block[pos] = s as i16;
            }
            k += 1;
        }
    }
    if *eobrun > 0 {
        while k <= se {
            let pos = NATURAL_ORDER[k];
            let coef = block[pos];
            if coef != 0 && bits.bits(1) != 0 && (coef & p1) == 0 {
                block[pos] = if coef >= 0 {
                    coef.wrapping_add(p1)
                } else {
                    coef.wrapping_add(m1)
                };
            }
            k += 1;
        }
        *eobrun -= 1;
    }
}

/// libjpeg's `sample_range_limit` table and its post-IDCT view (`IDCT_range_limit`, indexed `& RANGE_MASK`).
struct RangeLimit {
    /// Index `i` is the simple table at `i − 256`: 0 below 0, the identity on 0–255, 255 above (to 639).
    table: Vec<u8>,
}

impl RangeLimit {
    fn new() -> Self {
        // 5 × 256 + 128 entries, as prepare_range_limit_table lays them out (offset 256 = sample_range_limit[0])
        let mut t = vec![0u8; 5 * 256 + 128];
        for i in 0..256 {
            t[256 + i] = i as u8;
        }
        // post-IDCT table starts at sample_range_limit + 128 (index 384)
        for i in 128..512 {
            t[384 + i] = 255;
        }
        // [384 + 512, 384 + 512 + 384) stays 0; then the last 128 copy sample_range_limit[0..128]
        for i in 0..128 {
            t[384 + 1024 - 128 + i] = i as u8;
        }
        RangeLimit { table: t }
    }

    /// `sample_range_limit[x]` for x in −256…639.
    fn simple(&self, x: i32) -> u8 {
        let i = (x + 256).clamp(0, (self.table.len() - 1) as i32) as usize;
        self.table[i]
    }

    /// `IDCT_range_limit[x & RANGE_MASK]`.
    fn idct(&self, x: i64) -> u8 {
        self.table[384 + (x & 1023) as usize]
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

/// `jpeg_idct_islow` of one block into 8 rows of 8 samples.
fn idct_islow(coef: &[i16], q: &[u16; 64], range: &RangeLimit, out: &mut [u8], stride: usize) {
    let mut ws = [0i64; 64];
    for col in 0..8 {
        let c = |r: usize| i64::from(coef[r * 8 + col]) * i64::from(q[r * 8 + col]);
        if (1..8).all(|r| coef[r * 8 + col] == 0) {
            let dc = c(0) << PASS1_BITS;
            for r in 0..8 {
                ws[r * 8 + col] = dc;
            }
            continue;
        }
        let z2 = c(2);
        let z3 = c(6);
        let z1 = (z2 + z3) * FIX_0_541196100;
        let tmp2 = z1 + z3 * -FIX_1_847759065;
        let tmp3 = z1 + z2 * FIX_0_765366865;
        let z2 = c(0);
        let z3 = c(4);
        let tmp0 = (z2 + z3) << CONST_BITS;
        let tmp1 = (z2 - z3) << CONST_BITS;
        let tmp10 = tmp0 + tmp3;
        let tmp13 = tmp0 - tmp3;
        let tmp11 = tmp1 + tmp2;
        let tmp12 = tmp1 - tmp2;
        let (mut t0, mut t1, mut t2, mut t3) = (c(7), c(5), c(3), c(1));
        let z1 = t0 + t3;
        let z2 = t1 + t2;
        let z3 = t0 + t2;
        let z4 = t1 + t3;
        let z5 = (z3 + z4) * FIX_1_175875602;
        t0 *= FIX_0_298631336;
        t1 *= FIX_2_053119869;
        t2 *= FIX_3_072711026;
        t3 *= FIX_1_501321110;
        let z1 = z1 * -FIX_0_899976223;
        let z2 = z2 * -FIX_2_562915447;
        let z3 = z3 * -FIX_1_961570560 + z5;
        let z4 = z4 * -FIX_0_390180644 + z5;
        t0 += z1 + z3;
        t1 += z2 + z4;
        t2 += z2 + z3;
        t3 += z1 + z4;
        let n = CONST_BITS - PASS1_BITS;
        ws[col] = i64::from(descale(tmp10 + t3, n) as i32);
        ws[7 * 8 + col] = i64::from(descale(tmp10 - t3, n) as i32);
        ws[8 + col] = i64::from(descale(tmp11 + t2, n) as i32);
        ws[6 * 8 + col] = i64::from(descale(tmp11 - t2, n) as i32);
        ws[2 * 8 + col] = i64::from(descale(tmp12 + t1, n) as i32);
        ws[5 * 8 + col] = i64::from(descale(tmp12 - t1, n) as i32);
        ws[3 * 8 + col] = i64::from(descale(tmp13 + t0, n) as i32);
        ws[4 * 8 + col] = i64::from(descale(tmp13 - t0, n) as i32);
    }
    for row in 0..8 {
        let w = &ws[row * 8..row * 8 + 8];
        let o = &mut out[row * stride..row * stride + 8];
        if w[1..].iter().all(|&v| v == 0) {
            let v = range.idct(descale(w[0], PASS1_BITS + 3));
            o.fill(v);
            continue;
        }
        let z2 = w[2];
        let z3 = w[6];
        let z1 = (z2 + z3) * FIX_0_541196100;
        let tmp2 = z1 + z3 * -FIX_1_847759065;
        let tmp3 = z1 + z2 * FIX_0_765366865;
        let tmp0 = (w[0] + w[4]) << CONST_BITS;
        let tmp1 = (w[0] - w[4]) << CONST_BITS;
        let tmp10 = tmp0 + tmp3;
        let tmp13 = tmp0 - tmp3;
        let tmp11 = tmp1 + tmp2;
        let tmp12 = tmp1 - tmp2;
        let (mut t0, mut t1, mut t2, mut t3) = (w[7], w[5], w[3], w[1]);
        let z1 = t0 + t3;
        let z2 = t1 + t2;
        let z3 = t0 + t2;
        let z4 = t1 + t3;
        let z5 = (z3 + z4) * FIX_1_175875602;
        t0 *= FIX_0_298631336;
        t1 *= FIX_2_053119869;
        t2 *= FIX_3_072711026;
        t3 *= FIX_1_501321110;
        let z1 = z1 * -FIX_0_899976223;
        let z2 = z2 * -FIX_2_562915447;
        let z3 = z3 * -FIX_1_961570560 + z5;
        let z4 = z4 * -FIX_0_390180644 + z5;
        t0 += z1 + z3;
        t1 += z2 + z4;
        t2 += z2 + z3;
        t3 += z1 + z4;
        let n = CONST_BITS + PASS1_BITS + 3;
        o[0] = range.idct(descale(tmp10 + t3, n));
        o[7] = range.idct(descale(tmp10 - t3, n));
        o[1] = range.idct(descale(tmp11 + t2, n));
        o[6] = range.idct(descale(tmp11 - t2, n));
        o[2] = range.idct(descale(tmp12 + t1, n));
        o[5] = range.idct(descale(tmp12 - t1, n));
        o[3] = range.idct(descale(tmp13 + t0, n));
        o[4] = range.idct(descale(tmp13 - t0, n));
    }
}

/// A component's samples (`width_in_blocks × 8` per row), its real blocks only.
struct Plane {
    stride: usize,
    data: Vec<u8>,
}

fn idct_plane(c: &Component, q: &[u16; 64]) -> Plane {
    let range = RangeLimit::new();
    let stride = c.width_in_blocks * 8;
    let mut data = vec![0u8; stride * c.height_in_blocks * 8];
    for by in 0..c.height_in_blocks {
        for bx in 0..c.width_in_blocks {
            let at = (by * c.bw + bx) * 64;
            let out_at = by * 8 * stride + bx * 8;
            idct_islow(
                &c.coefs[at..at + 64],
                q,
                &range,
                &mut data[out_at..],
                stride,
            );
        }
    }
    Plane { stride, data }
}

/// The component at full size (`frame.width × frame.height`), as jdsample.c upsamples it with fancy upsampling on.
fn upsample(p: &Plane, c: &Component, f: &Frame) -> Vec<u8> {
    let (w, h) = (f.width, f.height);
    let hx = f.max_h / c.h;
    let vx = f.max_v / c.v;
    let at = |x: usize, y: usize| -> i32 { i32::from(p.data[y * p.stride + x]) };
    let dw = c.ds_width;
    let dh = c.ds_height;
    let mut out = vec![0u8; w * h];
    let fancy_h = dw > 2;
    let exact = f.max_h.is_multiple_of(c.h) && f.max_v.is_multiple_of(c.v);
    if hx == 1 && vx == 1 {
        for y in 0..h {
            out[y * w..y * w + w].copy_from_slice(&p.data[y * p.stride..y * p.stride + w]);
        }
    } else if hx == 2 && vx == 1 && fancy_h {
        let mut row = vec![0u8; 2 * dw];
        for y in 0..h {
            h2v1_fancy(&p.data[y * p.stride..y * p.stride + dw], &mut row);
            out[y * w..y * w + w].copy_from_slice(&row[..w]);
        }
    } else if hx == 1 && vx == 2 {
        for y in 0..h {
            let r = y / 2;
            let (near, far, bias) = if y % 2 == 0 {
                (r, r.saturating_sub(1), 1)
            } else {
                (r, (r + 1).min(dh - 1), 2)
            };
            for x in 0..w {
                out[y * w + x] = ((at(x, near) * 3 + at(x, far) + bias) >> 2) as u8;
            }
        }
    } else if hx == 2 && vx == 2 && fancy_h {
        let mut row = vec![0u8; 2 * dw];
        for y in 0..h {
            let r = y / 2;
            let other = if y % 2 == 0 {
                r.saturating_sub(1)
            } else {
                (r + 1).min(dh - 1)
            };
            h2v2_fancy_row(
                &p.data[r * p.stride..r * p.stride + dw],
                &p.data[other * p.stride..other * p.stride + dw],
                &mut row,
            );
            out[y * w..y * w + w].copy_from_slice(&row[..w]);
        }
    } else if exact {
        for y in 0..h {
            let sy = (y / vx).min(c.height_in_blocks * 8 - 1);
            for x in 0..w {
                let sx = (x / hx).min(p.stride - 1);
                out[y * w + x] = p.data[sy * p.stride + sx];
            }
        }
    }
    out
}

fn h2v1_fancy(input: &[u8], out: &mut [u8]) {
    let n = input.len();
    let v = |i: usize| i32::from(input[i]);
    out[0] = input[0];
    out[1] = ((v(0) * 3 + v(1) + 2) >> 2) as u8;
    for i in 1..n - 1 {
        let iv = v(i) * 3;
        out[2 * i] = ((iv + v(i - 1) + 1) >> 2) as u8;
        out[2 * i + 1] = ((iv + v(i + 1) + 2) >> 2) as u8;
    }
    out[2 * n - 2] = ((v(n - 1) * 3 + v(n - 2) + 1) >> 2) as u8;
    out[2 * n - 1] = input[n - 1];
}

/// One output row of `h2v2_fancy_upsample`: `near` is the nearer input row, `far` the next nearer.
fn h2v2_fancy_row(near: &[u8], far: &[u8], out: &mut [u8]) {
    let n = near.len();
    let col = |i: usize| i32::from(near[i]) * 3 + i32::from(far[i]);
    let mut this = col(0);
    let mut next = col(1);
    out[0] = ((this * 4 + 8) >> 4) as u8;
    out[1] = ((this * 3 + next + 7) >> 4) as u8;
    let mut last = this;
    this = next;
    for i in 1..n - 1 {
        next = col(i + 1);
        out[2 * i] = ((this * 3 + last + 8) >> 4) as u8;
        out[2 * i + 1] = ((this * 3 + next + 7) >> 4) as u8;
        last = this;
        this = next;
    }
    out[2 * n - 2] = ((this * 3 + last + 8) >> 4) as u8;
    out[2 * n - 1] = ((this * 4 + 7) >> 4) as u8;
}

/// jdcolor.c's YCbCr → RGB tables (16 fractional bits, rounded).
struct YccTables {
    cr_r: [i32; 256],
    cb_b: [i32; 256],
    cr_g: [i64; 256],
    cb_g: [i64; 256],
}

impl YccTables {
    fn new() -> Self {
        const SCALEBITS: i64 = 16;
        const ONE_HALF: i64 = 1 << (SCALEBITS - 1);
        let fix = |x: f64| (x * f64::from(1u32 << SCALEBITS) + 0.5) as i64;
        let mut t = YccTables {
            cr_r: [0; 256],
            cb_b: [0; 256],
            cr_g: [0; 256],
            cb_g: [0; 256],
        };
        for i in 0..256usize {
            let x = i as i64 - 128;
            t.cr_r[i] = ((fix(1.402_00) * x + ONE_HALF) >> SCALEBITS) as i32;
            t.cb_b[i] = ((fix(1.772_00) * x + ONE_HALF) >> SCALEBITS) as i32;
            t.cr_g[i] = -fix(0.714_14) * x;
            t.cb_g[i] = -fix(0.344_14) * x + ONE_HALF;
        }
        t
    }

    fn rgb_unclamped(&self, y: u8, cb: u8, cr: u8) -> (i32, i32, i32) {
        let y = i32::from(y);
        let (cb, cr) = (usize::from(cb), usize::from(cr));
        (
            y + self.cr_r[cr],
            y + ((self.cb_g[cb] + self.cr_g[cr]) >> 16) as i32,
            y + self.cb_b[cb],
        )
    }

    fn rgb(&self, y: u8, cb: u8, cr: u8, range: &RangeLimit) -> (u8, u8, u8) {
        let (r, g, b) = self.rgb_unclamped(y, cb, cr);
        (range.simple(r), range.simple(g), range.simple(b))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn range_limit_tables() {
        let r = RangeLimit::new();
        assert_eq!(
            (r.simple(-5), r.simple(0), r.simple(200), r.simple(300)),
            (0, 0, 200, 255)
        );
        // post-IDCT: x → clamp(x + 128)
        assert_eq!(
            (
                r.idct(-200),
                r.idct(-128),
                r.idct(-1),
                r.idct(0),
                r.idct(127),
                r.idct(300)
            ),
            (0, 0, 127, 128, 255, 255)
        );
    }

    #[test]
    fn refuses_non_jpegs() {
        assert_eq!(decode(b"\x89PNG"), Err(JpegError::NotJpeg));
        assert_eq!(header(&[0xFF, 0xD8, 0xFF, 0xD9]), Err(JpegError::NoFrame));
    }
}
