//! A stripped file as a plan: the ranges of the input it keeps, in order, and the few bytes the strip writes itself
//! (a rewritten JPEG JFIF header). [`jpeg::strip_plan`](crate::jpeg::strip_plan) and
//! [`png::strip_plan`](crate::png::strip_plan) return one; `strip` applies it. A caller that already holds the input
//! (Node, through `core/js/node.ts`) can assemble or write the output from its own buffer without the bytes crossing
//! the wasm boundary again: only the plan does.

/// One piece of the output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    /// The input's bytes `start..end`.
    Copy {
        /// First byte.
        start: usize,
        /// One past the last byte.
        end: usize,
    },
    /// Bytes that aren't a range of the input.
    Bytes(Vec<u8>),
}

/// The pieces of an output, in order. Adjacent copies are merged, so a file that keeps everything is one piece.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// The pieces.
    pub pieces: Vec<Piece>,
}

impl Plan {
    /// Appends `start..end` of the input, merged with the previous piece when that one ends at `start`.
    pub(crate) fn copy(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        if let Some(Piece::Copy { end: last, .. }) = self.pieces.last_mut()
            && *last == start
        {
            *last = end;
            return;
        }
        self.pieces.push(Piece::Copy { start, end });
    }

    /// Appends bytes of the strip's own.
    pub(crate) fn bytes(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.pieces.push(Piece::Bytes(bytes.to_vec()));
        }
    }

    /// The output's length.
    #[must_use]
    pub fn len(&self) -> usize {
        self.pieces.iter().fold(0usize, |n, p| {
            n.saturating_add(match p {
                Piece::Copy { start, end } => end.saturating_sub(*start),
                Piece::Bytes(b) => b.len(),
            })
        })
    }

    /// The output is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The plan keeps `data` exactly as it is (one piece, the whole input).
    #[must_use]
    pub fn is_identity(&self, data: &[u8]) -> bool {
        match self.pieces.as_slice() {
            [Piece::Copy { start: 0, end }] => *end == data.len(),
            [] => data.is_empty(),
            _ => false,
        }
    }

    /// The output: the pieces of `data` (the input the plan was made from) and the plan's own bytes, in order. A copy
    /// outside `data` contributes nothing (it can't happen for a plan made from `data`).
    #[must_use]
    pub fn apply(&self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len());
        for p in &self.pieces {
            match p {
                Piece::Copy { start, end } => {
                    out.extend_from_slice(data.get(*start..*end).unwrap_or_default());
                }
                Piece::Bytes(b) => out.extend_from_slice(b),
            }
        }
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn copies_merge_and_apply() {
        let data = b"0123456789";
        let mut p = Plan::default();
        p.copy(0, 2);
        p.copy(2, 4);
        p.copy(5, 5);
        p.bytes(b"ab");
        p.copy(6, 10);
        assert_eq!(p.pieces.len(), 3);
        assert_eq!(p.apply(data), b"0123ab6789");
        assert_eq!(p.len(), 10);
        assert!(!p.is_identity(data));
        let mut q = Plan::default();
        q.copy(0, 4);
        q.copy(4, 10);
        assert!(q.is_identity(data));
    }
}
