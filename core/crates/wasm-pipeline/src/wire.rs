//! The envelope encoding (see the crate docs).

/// No offset.
pub(crate) const NO_OFFSET: u32 = u32::MAX;

/// Builds an `ok` envelope.
#[derive(Debug)]
pub(crate) struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub(crate) fn ok() -> Self {
        Writer { buf: vec![0] }
    }

    pub(crate) fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    /// A size or count (exact in wasm32; saturates natively above 4 GiB).
    pub(crate) fn size(&mut self, v: usize) -> &mut Self {
        self.u32(u32::try_from(v).unwrap_or(u32::MAX))
    }

    pub(crate) fn flag(&mut self, v: bool) -> &mut Self {
        self.u32(u32::from(v))
    }

    pub(crate) fn f64(&mut self, v: f64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }

    /// Raw bytes, last: their length is the rest of the envelope.
    pub(crate) fn rest(&mut self, bytes: &[u8]) -> &mut Self {
        self.buf.reserve(bytes.len());
        self.buf.extend_from_slice(bytes);
        self
    }

    pub(crate) fn finish(&mut self) -> Vec<u8> {
        core::mem::take(&mut self.buf)
    }
}

/// An `error` envelope: a kebab-case code, an optional offset and a detail.
pub(crate) fn error(code: &str, offset: Option<usize>, detail: &str) -> Vec<u8> {
    let code = code.get(..usize::from(u8::MAX)).unwrap_or(code);
    let mut buf = Vec::with_capacity(code.len().saturating_add(detail.len()).saturating_add(6));
    buf.push(1);
    let offset = offset.map_or(NO_OFFSET, |o| u32::try_from(o).unwrap_or(NO_OFFSET));
    buf.extend_from_slice(&offset.to_le_bytes());
    buf.push(u8::try_from(code.len()).unwrap_or(u8::MAX));
    buf.extend_from_slice(code.as_bytes());
    buf.extend_from_slice(detail.as_bytes());
    buf
}
