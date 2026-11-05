//! A strict JSON reader (RFC 8259) for a glTF document.
//!
//! It validates the whole text and records where a few values are (byte spans into the text): `asset.version` and
//! the members of `images[*]`, `bufferViews[*]` and `buffers[*]` that the GLB rewrite needs. The rewrite then splices
//! new numbers and strings into the original text, so every other byte of the document is kept (no re-serialising,
//! no float reformatting). Keys are compared as `JSON.parse` compares them (UTF-16 code units, escapes decoded), and a
//! duplicate key anywhere is refused: `JSON.parse` keeps the last, and a reader that kept the first could draw an
//! image other than the one cleaned.

/// How deep arrays and objects may nest.
pub(crate) const MAX_DEPTH: usize = 256;

/// Why the JSON chunk isn't acceptable JSON. Offsets are into the chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonError {
    /// Not JSON at this offset.
    Syntax {
        /// Offset.
        at: usize,
    },
    /// Nested deeper than 256 arrays and objects.
    TooDeep {
        /// Offset.
        at: usize,
    },
    /// A key that already appeared in the same object.
    DuplicateKey {
        /// Offset of the second occurrence.
        at: usize,
    },
}

impl core::fmt::Display for JsonError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            JsonError::Syntax { at } => write!(f, "invalid JSON at byte {at}"),
            JsonError::TooDeep { at } => {
                write!(f, "JSON nested deeper than {MAX_DEPTH} levels at byte {at}")
            }
            JsonError::DuplicateKey { at } => write!(f, "a duplicate JSON key at byte {at}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}

/// A value's kind and its byte span `text[start..end]` (strings include their quotes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Value {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
}

/// The members of an entry the rewrite reads (a superset over images, bufferViews and buffers).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Fields {
    pub buffer_view: Option<Value>,
    pub uri: Option<Value>,
    pub buffer: Option<Value>,
    pub byte_offset: Option<Value>,
    pub byte_length: Option<Value>,
    pub extensions: Option<Value>,
}

/// One element of `images`, `bufferViews` or `buffers`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Item {
    pub value: Value,
    pub fields: Fields,
}

/// Where the values the rewrite needs are.
#[derive(Clone, Debug, Default)]
pub(crate) struct Index {
    pub root: Option<Value>,
    pub asset: Option<Value>,
    pub version: Option<Value>,
    pub images: Option<Value>,
    pub buffer_views: Option<Value>,
    pub buffers: Option<Value>,
    pub image_items: Vec<Item>,
    pub view_items: Vec<Item>,
    pub buffer_items: Vec<Item>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum List {
    Images,
    BufferViews,
    Buffers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ctx {
    Root,
    Asset,
    List(List),
    Entry(List),
    Skip,
}

/// `key` (UTF-16 code units) equals the ASCII `name`.
fn key_is(key: &[u16], name: &str) -> bool {
    key.len() == name.len()
        && key
            .iter()
            .zip(name.bytes())
            .all(|(&k, b)| k == u16::from(b))
}

fn child_ctx(ctx: Ctx, key: &[u16]) -> Ctx {
    if ctx != Ctx::Root {
        return Ctx::Skip;
    }
    if key_is(key, "asset") {
        Ctx::Asset
    } else if key_is(key, "images") {
        Ctx::List(List::Images)
    } else if key_is(key, "bufferViews") {
        Ctx::List(List::BufferViews)
    } else if key_is(key, "buffers") {
        Ctx::List(List::Buffers)
    } else {
        Ctx::Skip
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    index: Index,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn bump(&mut self) {
        self.i = self.i.saturating_add(1);
    }

    fn syntax(&self) -> JsonError {
        JsonError::Syntax { at: self.i }
    }

    fn eat(&mut self, c: u8) -> Result<(), JsonError> {
        if self.peek() == Some(c) {
            self.bump();
            Ok(())
        } else {
            Err(self.syntax())
        }
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.bump();
        }
    }

    fn list_mut(&mut self, list: List) -> &mut Vec<Item> {
        match list {
            List::Images => &mut self.index.image_items,
            List::BufferViews => &mut self.index.view_items,
            List::Buffers => &mut self.index.buffer_items,
        }
    }

    fn value(&mut self, ctx: Ctx, depth: usize) -> Result<Value, JsonError> {
        let start = self.i;
        let kind = match self.peek() {
            Some(b'{') => {
                self.object(ctx, depth)?;
                Kind::Object
            }
            Some(b'[') => {
                self.array(ctx, depth)?;
                Kind::Array
            }
            Some(b'"') => {
                self.string()?;
                Kind::String
            }
            Some(b't') => {
                self.literal(b"true")?;
                Kind::Bool
            }
            Some(b'f') => {
                self.literal(b"false")?;
                Kind::Bool
            }
            Some(b'n') => {
                self.literal(b"null")?;
                Kind::Null
            }
            Some(b'-' | b'0'..=b'9') => {
                self.number()?;
                Kind::Number
            }
            _ => return Err(self.syntax()),
        };
        Ok(Value {
            kind,
            start,
            end: self.i,
        })
    }

    fn enter(&self, depth: usize) -> Result<usize, JsonError> {
        let deeper = depth.saturating_add(1);
        if deeper > MAX_DEPTH {
            Err(JsonError::TooDeep { at: self.i })
        } else {
            Ok(deeper)
        }
    }

    fn object(&mut self, ctx: Ctx, depth: usize) -> Result<(), JsonError> {
        let depth = self.enter(depth)?;
        self.bump();
        self.ws();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(());
        }
        let mut keys: Vec<(Vec<u16>, usize)> = Vec::new();
        loop {
            self.ws();
            let key_at = self.i;
            if self.peek() != Some(b'"') {
                return Err(self.syntax());
            }
            self.string()?;
            let key = utf16(
                self.s,
                Value {
                    kind: Kind::String,
                    start: key_at,
                    end: self.i,
                },
            );
            self.ws();
            self.eat(b':')?;
            self.ws();
            let v = self.value(child_ctx(ctx, &key), depth)?;
            self.record(ctx, &key, v);
            keys.push((key, key_at));
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b'}') => {
                    self.bump();
                    break;
                }
                _ => return Err(self.syntax()),
            }
        }
        keys.sort_unstable();
        for pair in keys.windows(2) {
            if let [(a, _), (b, at)] = pair
                && a == b
            {
                return Err(JsonError::DuplicateKey { at: *at });
            }
        }
        Ok(())
    }

    fn array(&mut self, ctx: Ctx, depth: usize) -> Result<(), JsonError> {
        let depth = self.enter(depth)?;
        self.bump();
        self.ws();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(());
        }
        loop {
            self.ws();
            let child = if let Ctx::List(list) = ctx {
                let at = self.i;
                self.list_mut(list).push(Item {
                    value: Value {
                        kind: Kind::Null,
                        start: at,
                        end: at,
                    },
                    fields: Fields::default(),
                });
                Ctx::Entry(list)
            } else {
                Ctx::Skip
            };
            let v = self.value(child, depth)?;
            if let Ctx::List(list) = ctx
                && let Some(item) = self.list_mut(list).last_mut()
            {
                item.value = v;
            }
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b']') => {
                    self.bump();
                    break;
                }
                _ => return Err(self.syntax()),
            }
        }
        Ok(())
    }

    fn record(&mut self, ctx: Ctx, key: &[u16], v: Value) {
        match ctx {
            Ctx::Root => {
                let slot = if key_is(key, "asset") {
                    &mut self.index.asset
                } else if key_is(key, "images") {
                    &mut self.index.images
                } else if key_is(key, "bufferViews") {
                    &mut self.index.buffer_views
                } else if key_is(key, "buffers") {
                    &mut self.index.buffers
                } else {
                    return;
                };
                *slot = Some(v);
            }
            Ctx::Asset => {
                if key_is(key, "version") {
                    self.index.version = Some(v);
                }
            }
            Ctx::Entry(list) => {
                let Some(item) = self.list_mut(list).last_mut() else {
                    return;
                };
                let f = &mut item.fields;
                let slot = match list {
                    List::Images if key_is(key, "bufferView") => &mut f.buffer_view,
                    List::Images | List::Buffers if key_is(key, "uri") => &mut f.uri,
                    List::BufferViews if key_is(key, "buffer") => &mut f.buffer,
                    List::BufferViews if key_is(key, "byteOffset") => &mut f.byte_offset,
                    List::BufferViews | List::Buffers if key_is(key, "byteLength") => {
                        &mut f.byte_length
                    }
                    List::BufferViews if key_is(key, "extensions") => &mut f.extensions,
                    _ => return,
                };
                *slot = Some(v);
            }
            Ctx::List(_) | Ctx::Skip => {}
        }
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), JsonError> {
        if self
            .s
            .get(self.i..)
            .is_some_and(|rest| rest.starts_with(word))
        {
            self.i = self.i.saturating_add(word.len());
            Ok(())
        } else {
            Err(self.syntax())
        }
    }

    fn digits(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.bump();
        }
    }

    fn digits1(&mut self) -> Result<(), JsonError> {
        if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
            return Err(self.syntax());
        }
        self.digits();
        Ok(())
    }

    fn number(&mut self) -> Result<(), JsonError> {
        if self.peek() == Some(b'-') {
            self.bump();
        }
        match self.peek() {
            Some(b'0') => self.bump(),
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.syntax()),
        }
        if self.peek() == Some(b'.') {
            self.bump();
            self.digits1()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            self.digits1()?;
        }
        Ok(())
    }

    fn string(&mut self) -> Result<(), JsonError> {
        self.bump();
        loop {
            let rest = self.s.get(self.i..).ok_or(self.syntax())?;
            let skip = rest
                .iter()
                .position(|&c| c == b'"' || c == b'\\' || c < 0x20)
                .ok_or(JsonError::Syntax { at: self.s.len() })?;
            self.i = self.i.saturating_add(skip);
            match self.peek() {
                Some(b'"') => {
                    self.bump();
                    return Ok(());
                }
                Some(b'\\') => {
                    self.bump();
                    match self.peek() {
                        Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => self.bump(),
                        Some(b'u') => {
                            self.bump();
                            for _ in 0..4 {
                                if !self.peek().is_some_and(|h| h.is_ascii_hexdigit()) {
                                    return Err(self.syntax());
                                }
                                self.bump();
                            }
                        }
                        _ => return Err(self.syntax()),
                    }
                }
                _ => return Err(self.syntax()),
            }
        }
    }
}

/// Validates `text` as one JSON value (surrounded by optional whitespace) and indexes it.
pub(crate) fn parse(text: &[u8]) -> Result<Index, JsonError> {
    if let Err(e) = core::str::from_utf8(text) {
        return Err(JsonError::Syntax {
            at: e.valid_up_to(),
        });
    }
    let mut p = Parser {
        s: text,
        i: 0,
        index: Index::default(),
    };
    p.ws();
    let root = p.value(Ctx::Root, 0)?;
    p.ws();
    if p.i != text.len() {
        return Err(p.syntax());
    }
    p.index.root = Some(root);
    Ok(p.index)
}

/// A validated string token's contents as UTF-16 code units (escapes decoded; lone surrogates kept, as in JS).
pub(crate) fn utf16(text: &[u8], v: Value) -> Vec<u16> {
    let inner = text
        .get(v.start.saturating_add(1)..v.end.saturating_sub(1))
        .unwrap_or_default();
    let Ok(inner) = core::str::from_utf8(inner) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(inner.len());
    let mut buf = [0u16; 2];
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.extend_from_slice(c.encode_utf16(&mut buf));
            continue;
        }
        match chars.next() {
            Some('b') => out.push(0x08),
            Some('f') => out.push(0x0C),
            Some('n') => out.push(0x0A),
            Some('r') => out.push(0x0D),
            Some('t') => out.push(0x09),
            Some('u') => {
                let mut unit: u16 = 0;
                for _ in 0..4 {
                    let digit = chars
                        .next()
                        .and_then(|h| h.to_digit(16))
                        .and_then(|d| u16::try_from(d).ok())
                        .unwrap_or(0);
                    unit = unit.wrapping_shl(4) | digit;
                }
                out.push(unit);
            }
            Some(other) => out.extend_from_slice(other.encode_utf16(&mut buf)),
            None => {}
        }
    }
    out
}

/// A string value's text, or `None` when it isn't a string or holds a lone surrogate.
pub(crate) fn string(text: &[u8], v: Value) -> Option<String> {
    if v.kind != Kind::String {
        return None;
    }
    String::from_utf16(&utf16(text, v)).ok()
}

/// A number value written as a plain non-negative integer (no sign, fraction or exponent) that fits a `usize`.
pub(crate) fn index(text: &[u8], v: Value) -> Option<usize> {
    if v.kind != Kind::Number {
        return None;
    }
    let token = text.get(v.start..v.end)?;
    if token.is_empty() || !token.iter().all(u8::is_ascii_digit) {
        return None;
    }
    token.iter().try_fold(0usize, |n, &d| {
        n.checked_mul(10)?
            .checked_add(usize::from(d.wrapping_sub(b'0')))
    })
}

/// `s` as a JSON string literal (quotes added; `"`, `\` and control characters escaped).
pub(crate) fn quote(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(s.len().saturating_add(2));
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < ' ' => {
                let b = u8::try_from(u32::from(c)).unwrap_or(0);
                out.push_str("\\u00");
                for nibble in [b.wrapping_shr(4), b & 0x0F] {
                    out.push(
                        HEX.get(usize::from(nibble))
                            .copied()
                            .map_or('0', char::from),
                    );
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn indexes_the_gltf_fields() {
        let text = br#" {"asset":{"version":"2.0"},"images":[{"bufferView":3,"mimeType":"image/jpeg"},{"uri":"data:x"}],
            "bufferViews":[{"buffer":0,"byteLength":10,"extensions":{}}],"buffers":[{"byteLength":12}],
            "extras":{"images":[{"bufferView":9}]}} "#;
        let ix = parse(text).unwrap();
        assert_eq!(string(text, ix.version.unwrap()).as_deref(), Some("2.0"));
        assert_eq!(ix.image_items.len(), 2);
        assert_eq!(
            index(text, ix.image_items[0].fields.buffer_view.unwrap()),
            Some(3)
        );
        assert_eq!(
            string(text, ix.image_items[1].fields.uri.unwrap()).as_deref(),
            Some("data:x")
        );
        assert_eq!(ix.view_items.len(), 1);
        assert!(ix.view_items[0].fields.extensions.is_some());
        assert_eq!(
            index(text, ix.buffer_items[0].fields.byte_length.unwrap()),
            Some(12)
        );
    }

    #[test]
    fn escaped_keys_are_keys() {
        let text = br#"{"images":[{"buffer\u0056iew":1}]}"#;
        let ix = parse(text).unwrap();
        assert_eq!(
            index(text, ix.image_items[0].fields.buffer_view.unwrap()),
            Some(1)
        );
        assert_eq!(
            parse(br#"{"a":1,"\u0061":2}"#).unwrap_err(),
            JsonError::DuplicateKey { at: 7 }
        );
    }

    #[test]
    fn refuses_bad_json() {
        for bad in [
            &b""[..],
            b"{",
            b"{\"a\":}",
            b"[1,]",
            b"01",
            b"1.",
            b"\"\x01\"",
            b"{\"a\":1}\0",
            b"nul",
            b"\"\\x\"",
            b"\xff",
        ] {
            assert!(parse(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
        let deep = "[".repeat(MAX_DEPTH + 1) + &"]".repeat(MAX_DEPTH + 1);
        assert!(matches!(
            parse(deep.as_bytes()),
            Err(JsonError::TooDeep { .. })
        ));
        let ok = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
        assert!(parse(ok.as_bytes()).is_ok());
    }

    #[test]
    fn numbers_and_strings() {
        let text = br#"[0, 12, -1, 1.5, 1e3, "a\"b\u00e9\ud83d\ude00", "\ud800"]"#;
        let ix = parse(text).unwrap();
        assert!(ix.root.is_some());
        let v = |s: usize, e: usize, kind| Value {
            kind,
            start: s,
            end: e,
        };
        assert_eq!(index(text, v(1, 2, Kind::Number)), Some(0));
        assert_eq!(index(text, v(4, 6, Kind::Number)), Some(12));
        assert_eq!(index(text, v(8, 10, Kind::Number)), None);
        assert_eq!(quote("a\"\\\u{1}é"), "\"a\\\"\\\\\\u0001é\"");
    }
}
