//! Bounds-checked reads: every accessor returns `None` past the end instead of panicking.

/// The byte at `at`.
pub(crate) fn byte(data: &[u8], at: usize) -> Option<u8> {
    data.get(at).copied()
}

/// The big-endian `u16` at `at`.
pub(crate) fn be16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..)?
        .first_chunk::<2>()
        .map(|b| u16::from_be_bytes(*b))
}

/// The big-endian `u32` at `at`.
pub(crate) fn be32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..)?
        .first_chunk::<4>()
        .map(|b| u32::from_be_bytes(*b))
}

/// The little-endian `u32` at `at`.
pub(crate) fn le32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..)?
        .first_chunk::<4>()
        .map(|b| u32::from_le_bytes(*b))
}

/// `n` as a `usize` (always exact on the 32- and 64-bit targets this crate is built for).
pub(crate) fn usize_from(n: u32) -> Option<usize> {
    usize::try_from(n).ok()
}
