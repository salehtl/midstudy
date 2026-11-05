//! The envelope encoding (see the crate docs).

/// No offset.
pub(crate) const NO_OFFSET: u32 = u32::MAX;

/// Builds an envelope.
#[derive(Debug, Default)]
pub(crate) struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    /// An `ok` envelope, payload to follow.
    pub(crate) fn ok() -> Self {
        Writer { buf: vec![0] }
    }

    /// A `u32`.
    pub(crate) fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    /// A size or count as a `u32` (exact in wasm32, where a `usize` is 32 bits; saturates natively above 4 GiB).
    pub(crate) fn size(&mut self, v: usize) -> &mut Self {
        self.u32(u32::try_from(v).unwrap_or(u32::MAX))
    }

    /// A `u64` as two `u32`s, low first.
    pub(crate) fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    /// A boolean as a `u32` (0 or 1).
    pub(crate) fn flag(&mut self, v: bool) -> &mut Self {
        self.u32(u32::from(v))
    }

    /// Raw bytes (only as the last field: their length is the rest of the envelope).
    pub(crate) fn rest(&mut self, bytes: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(bytes);
        self
    }

    /// The envelope.
    pub(crate) fn finish(&mut self) -> Vec<u8> {
        core::mem::take(&mut self.buf)
    }
}

/// An `error` envelope: a kebab-case code, an optional offset and a one-sentence message.
pub(crate) fn error(code: &str, offset: Option<usize>, message: &str) -> Vec<u8> {
    let code = code.get(..usize::from(u8::MAX)).unwrap_or(code);
    let mut buf = Vec::with_capacity(code.len().saturating_add(message.len()).saturating_add(6));
    buf.push(1);
    let offset = offset.map_or(NO_OFFSET, |o| u32::try_from(o).unwrap_or(NO_OFFSET));
    buf.extend_from_slice(&offset.to_le_bytes());
    buf.push(u8::try_from(code.len()).unwrap_or(u8::MAX));
    buf.extend_from_slice(code.as_bytes());
    buf.extend_from_slice(message.as_bytes());
    buf
}

/// Reads the packed inputs the TypeScript face sends (little-endian `u32`s and length-prefixed byte strings).
#[derive(Debug)]
pub(crate) struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Reader { data, at: 0 }
    }

    pub(crate) fn done(&self) -> bool {
        self.at >= self.data.len()
    }

    pub(crate) fn u32(&mut self) -> Option<u32> {
        let v = self
            .data
            .get(self.at..)?
            .first_chunk::<4>()
            .map(|b| u32::from_le_bytes(*b))?;
        self.at = self.at.checked_add(4)?;
        Some(v)
    }

    pub(crate) fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = usize::try_from(self.u32()?).ok()?;
        let end = self.at.checked_add(len)?;
        let v = self.data.get(self.at..end)?;
        self.at = end;
        Some(v)
    }
}
