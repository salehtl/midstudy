//! JPEG, exactly as v1's Pillow 13 reads and writes it through libjpeg-turbo 3: the decoder ([`decode`]) and the
//! encoder ([`encode`]) reproduce libjpeg-turbo's integer arithmetic (the accurate "islow" DCTs, fancy upsampling,
//! h2v2 downsampling with its alternating bias, the fixed-point colour conversions, the reciprocal quantizer, the
//! standard Huffman tables and marker order), so the same pixels give the same bytes as v1's `engine-input.jpg`,
//! `thumb.jpg` and the rug texture.

pub mod decode;
pub mod encode;
mod huffman;

/// The natural (row-major) index of each zigzag position, with libjpeg's 16 extra entries for corrupt data.
pub(crate) const NATURAL_ORDER: [usize; 80] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63,
    63, 63, 63, 63, 63, 63,
];
