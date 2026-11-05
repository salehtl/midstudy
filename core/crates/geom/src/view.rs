//! The 2D view of the photo on screen (v1 planner/engine.js `viewParams`, `clientToPhoto`, `photoToClient`): client
//! (CSS) pixels are `o + s · photo px`. Zoom and pan only change `s` and `o` (contract §4.1: 2D only).

/// `client = o + s · photo`: `s` CSS pixels per photo pixel, `o` the client position of photo pixel (0, 0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    /// CSS pixels per photo pixel (the fit scale times the zoom).
    pub s: f64,
    /// Client x of the photo's left edge.
    pub ox: f64,
    /// Client y of the photo's top edge.
    pub oy: f64,
}

impl View {
    /// v1's `clientToPhoto`: `((x − ox) / s, (y − oy) / s)`.
    #[must_use]
    pub fn client_to_photo(&self, x: f64, y: f64) -> [f64; 2] {
        [(x - self.ox) / self.s, (y - self.oy) / self.s]
    }

    /// v1's `photoToClient`: `(ox + s · px, oy + s · py)`.
    #[must_use]
    pub fn photo_to_client(&self, px: f64, py: f64) -> [f64; 2] {
        [self.ox + self.s * px, self.oy + self.s * py]
    }
}
