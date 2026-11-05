//! Static paths: normalisation and the allowlist.
//!
//! - [`normalize`] (contract §2.9 Paths: "static paths are normalized (percent-decoding, `.` and `..`) **before**
//!   any rule about what is served"): v1's `clean_path` in `planner/serve.py`: the query and fragment cut off, the
//!   rest percent-decoded as `urllib.parse.unquote` does (UTF-8, invalid bytes replaced), then `.`, `..` and repeated
//!   slashes resolved under the root, a trailing slash kept. A NUL or a backslash anywhere is refused.
//! - [`route`] and [`static_route`] (§2.1 "Static is an allowlist", §2.8 "What `/library/` serves", §4.4 Static):
//!   v1's `translate_path`, `hidden` and the `/` redirect in `do_GET`. Only these are served: `/planner/…` (the app's
//!   own files), `/library/library.json` and `/library/<id>/{model.glb,splat.ply,splat.spz,thumb.jpg}`,
//!   `/scenes/<name>/{photo.jpg,depth.png,thumb.jpg}` and `/renders/<file>`; nothing whose path has a segment
//!   starting with `.`. Everything else, whatever its spelling, is not found.
//!
//! **Case.** APFS is case-insensitive, so `/Library/costs.csv` would reach `library/costs.csv` through any rule that
//! matched spellings loosely. Every rule here matches the exact lowercase spelling of an allowed name and nothing else
//! (`/LIBRARY/library.json`, `/library/x/MODEL.GLB` and `/Planner/` are all not found), so no case variant of a path
//! outside the allowlist can be served. Inside `/planner/` and `/renders/` the rest of the path goes to the file
//! system as it is: both folders hold only public files.

use crate::slug::is_slug;

/// Why [`normalize`] refused a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathRefusal {
    /// A NUL character (`%00`) can't name a file.
    Nul,
    /// A backslash (`\` or `%5C`) can't name a file (and would be a separator elsewhere).
    Backslash,
}

impl core::fmt::Display for PathRefusal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            PathRefusal::Nul => write!(f, "the path holds a NUL character"),
            PathRefusal::Backslash => write!(f, "the path holds a backslash"),
        }
    }
}

const fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(c.wrapping_sub(b'a').wrapping_add(10)),
        b'A'..=b'F' => Some(c.wrapping_sub(b'A').wrapping_add(10)),
        _ => None,
    }
}

/// Percent-decodes one run of ASCII text (two hex digits after `%`, either case; anything else kept as it is).
fn unquote_ascii(run: &[u8], out: &mut String) {
    let mut bytes = Vec::with_capacity(run.len());
    let mut i = 0usize;
    while let Some(&c) = run.get(i) {
        if c == b'%'
            && let (Some(hi), Some(lo)) = (
                run.get(i.saturating_add(1)).copied().and_then(hex),
                run.get(i.saturating_add(2)).copied().and_then(hex),
            )
        {
            bytes.push(hi.wrapping_shl(4) | lo);
            i = i.saturating_add(3);
            continue;
        }
        bytes.push(c);
        i = i.saturating_add(1);
    }
    out.push_str(&String::from_utf8_lossy(&bytes));
}

/// `urllib.parse.unquote(s)` (encoding UTF-8, errors "replace"): runs of ASCII are percent-decoded and decoded as
/// UTF-8 with replacement characters; other characters pass through as they are.
#[must_use]
pub fn unquote(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut run_start: Option<usize> = None;
    for (at, c) in s.char_indices() {
        if c.is_ascii() {
            run_start.get_or_insert(at);
        } else {
            if let Some(start) = run_start.take() {
                unquote_ascii(s.as_bytes().get(start..at).unwrap_or_default(), &mut out);
            }
            out.push(c);
        }
    }
    if let Some(start) = run_start {
        unquote_ascii(s.as_bytes().get(start..).unwrap_or_default(), &mut out);
    }
    out
}

/// Resolves `.`, `..` and empty segments of an already decoded path under the root, keeping a trailing slash
/// (`posixpath.normpath("/" + path.lstrip("/"))` with v1's trailing-slash rule): the second half of [`normalize`].
/// It decodes nothing, so it is idempotent, and its result never has a `.` or `..` segment or a `//`.
#[must_use]
pub fn resolve(decoded: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let mut clean = String::with_capacity(decoded.len().saturating_add(1));
    for part in &parts {
        clean.push('/');
        clean.push_str(part);
    }
    if clean.is_empty() || decoded.ends_with('/') {
        clean.push('/');
    }
    clean
}

/// The canonical form of a request target's path: the query and fragment cut off, percent-decoded once
/// ([`unquote`]), then [`resolve`]d (`.` and `..` never above `/`, repeated slashes collapsed, a trailing slash kept
/// except on `/` itself).
///
/// The result is final: it is a fixed point of [`resolve`], and the allowlist ([`route`]) reads it literally. It may
/// hold a literal `%`, `?` or `#` (from `%25`, `%3F`, `%23`), so it must never be decoded again: a second decoding
/// would turn `%252e%252e` into `..` after the check.
///
/// # Errors
/// [`PathRefusal`]: the decoded path holds a NUL or a backslash.
pub fn normalize(target: &str) -> Result<String, PathRefusal> {
    let path = target.split(['?', '#']).next().unwrap_or_default();
    let decoded = unquote(path);
    if decoded.contains('\0') {
        return Err(PathRefusal::Nul);
    }
    if decoded.contains('\\') {
        return Err(PathRefusal::Backslash);
    }
    Ok(resolve(&decoded))
}

/// A library item asset `/library/` serves (contract §2.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LibraryFile {
    /// `model.glb`.
    Model,
    /// `splat.ply`.
    SplatPly,
    /// `splat.spz`.
    SplatSpz,
    /// `thumb.jpg`.
    Thumb,
}

impl LibraryFile {
    /// The file name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            LibraryFile::Model => "model.glb",
            LibraryFile::SplatPly => "splat.ply",
            LibraryFile::SplatSpz => "splat.spz",
            LibraryFile::Thumb => "thumb.jpg",
        }
    }
}

/// A scene asset `/scenes/` serves (contract §4.4 Static).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SceneFile {
    /// `photo.jpg`.
    Photo,
    /// `depth.png`.
    Depth,
    /// `thumb.jpg`.
    Thumb,
}

impl SceneFile {
    /// The file name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            SceneFile::Photo => "photo.jpg",
            SceneFile::Depth => "depth.png",
            SceneFile::Thumb => "thumb.jpg",
        }
    }
}

/// What a static path serves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// `302` to `/planner/` (the request target's path was exactly `/`).
    RedirectToPlanner,
    /// A file under the planner's folder: `rel` is the path after `/planner/` (empty for the folder itself);
    /// `trailing_slash` says the request asked for a folder (v1 then served its `index.html`, and redirected a folder
    /// asked for without the slash).
    Planner {
        /// The path inside the planner folder, segments joined by `/`.
        rel: String,
        /// The normalized path ended with `/`.
        trailing_slash: bool,
    },
    /// `/library/library.json` (an empty library when the file doesn't exist yet, §2.2).
    LibraryJson,
    /// `/library/<id>/<file>`.
    Library {
        /// The item id (a slug).
        id: String,
        /// Which asset.
        file: LibraryFile,
    },
    /// `/scenes/<name>/<file>`.
    Scene {
        /// The scene name (a slug).
        name: String,
        /// Which asset.
        file: SceneFile,
    },
    /// `/renders/<file>`: one path segment that doesn't start with `.`.
    Render {
        /// The file name.
        file: String,
    },
    /// Anything else: `404`.
    NotFound,
}

fn library_file(name: &str) -> Option<LibraryFile> {
    match name {
        "model.glb" => Some(LibraryFile::Model),
        "splat.ply" => Some(LibraryFile::SplatPly),
        "splat.spz" => Some(LibraryFile::SplatSpz),
        "thumb.jpg" => Some(LibraryFile::Thumb),
        _ => None,
    }
}

fn scene_file(name: &str) -> Option<SceneFile> {
    match name {
        "photo.jpg" => Some(SceneFile::Photo),
        "depth.png" => Some(SceneFile::Depth),
        "thumb.jpg" => Some(SceneFile::Thumb),
        _ => None,
    }
}

/// The route for an already [`normalize`]d path (v1's `hidden` check, then `translate_path`).
#[must_use]
pub fn route(clean: &str) -> Route {
    if clean.split('/').any(|seg| seg.starts_with('.')) {
        return Route::NotFound;
    }
    if let Some(file) = clean.strip_prefix("/renders/") {
        if file.is_empty() || file.contains('/') || file.contains('\\') {
            return Route::NotFound;
        }
        return Route::Render {
            file: file.to_owned(),
        };
    }
    if clean == "/scenes" || clean.starts_with("/scenes/") {
        let rest = clean.get("/scenes/".len()..).unwrap_or_default();
        return match rest.split_once('/') {
            Some((name, file)) if is_slug(name) => {
                scene_file(file).map_or(Route::NotFound, |file| Route::Scene {
                    name: name.to_owned(),
                    file,
                })
            }
            _ => Route::NotFound,
        };
    }
    if let Some(rel) = clean.strip_prefix("/library/") {
        if rel == "library.json" {
            return Route::LibraryJson;
        }
        return match rel.split_once('/') {
            Some((id, file)) if is_slug(id) => {
                library_file(file).map_or(Route::NotFound, |file| Route::Library {
                    id: id.to_owned(),
                    file,
                })
            }
            _ => Route::NotFound,
        };
    }
    let mut parts = clean.split('/').filter(|s| !s.is_empty());
    if parts.next() == Some("planner") {
        let rel = parts.collect::<Vec<_>>().join("/");
        return Route::Planner {
            rel,
            trailing_slash: clean.ends_with('/'),
        };
    }
    Route::NotFound
}

/// A request target with its leading slashes reduced to one when it starts with `//`, as Python's `http.server`
/// does before anything else (gh-87389: browsers read `//host/x` as another site). v1 routed every request,
/// `/api` included, after this; v2's server should too.
#[must_use]
pub fn reduce_leading_slashes(target: &str) -> &str {
    if !target.starts_with("//") {
        return target;
    }
    let rest = target.trim_start_matches('/');
    target
        .get(target.len().saturating_sub(rest.len()).saturating_sub(1)..)
        .unwrap_or(target)
}

/// The route for a request target as it arrived: leading slashes reduced ([`reduce_leading_slashes`]), then a path
/// of exactly `/` (before any query or fragment) redirects, and everything else is normalized and routed (a refused
/// path is not found). API paths (`/api`, `/api/…`) are the server's own and never reach this.
#[must_use]
pub fn static_route(target: &str) -> Route {
    let target = reduce_leading_slashes(target);
    if target.split(['?', '#']).next() == Some("/") {
        return Route::RedirectToPlanner;
    }
    normalize(target).map_or(Route::NotFound, |clean| route(&clean))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_like_v1() {
        let cases = [
            ("/", "/"),
            ("", "/"),
            ("/./library/costs.csv", "/library/costs.csv"),
            ("/planner/../library/costs.csv", "/library/costs.csv"),
            ("/../../etc/passwd", "/etc/passwd"),
            ("//library//library.json", "/library/library.json"),
            ("/%2e%2e/%2E/x", "/x"),
            ("/planner/", "/planner/"),
            ("/planner/.", "/planner"),
            ("/a/..", "/"),
            ("/a/../", "/"),
            ("/x%3Fy?q#f", "/x?y"),
            ("/%zz%4", "/%zz%4"),
            ("/%%41", "/%A"),
            ("/%C3%A9", "/é"),
            ("/%C3", "/\u{FFFD}"),
            ("/é%41", "/éA"),
            ("/...", "/..."),
        ];
        for (raw, want) in cases {
            assert_eq!(normalize(raw).as_deref(), Ok(want), "{raw:?}");
        }
        assert_eq!(normalize("/a%00b"), Err(PathRefusal::Nul));
        assert_eq!(normalize("/a%5Cb"), Err(PathRefusal::Backslash));
        assert_eq!(normalize("/a\\b"), Err(PathRefusal::Backslash));
    }

    #[test]
    fn routes() {
        assert_eq!(static_route("/"), Route::RedirectToPlanner);
        assert_eq!(static_route("/?x"), Route::RedirectToPlanner);
        assert_eq!(static_route("/./"), Route::NotFound);
        assert_eq!(static_route("//?x"), Route::RedirectToPlanner);
        assert_eq!(
            static_route("///planner/a"),
            Route::Planner {
                rel: "a".into(),
                trailing_slash: false
            }
        );
        assert_eq!(reduce_leading_slashes("///x//y"), "/x//y");
        assert_eq!(reduce_leading_slashes("/x"), "/x");
        assert_eq!(
            static_route("/planner/"),
            Route::Planner {
                rel: String::new(),
                trailing_slash: true
            }
        );
        assert_eq!(
            static_route("/planner/js/../main.js"),
            Route::Planner {
                rel: "main.js".into(),
                trailing_slash: false
            }
        );
        assert_eq!(static_route("/library/library.json"), Route::LibraryJson);
        assert_eq!(
            static_route("/library/chair/model.glb"),
            Route::Library {
                id: "chair".into(),
                file: LibraryFile::Model
            }
        );
        assert_eq!(
            static_route("/scenes/s-1/photo.jpg"),
            Route::Scene {
                name: "s-1".into(),
                file: SceneFile::Photo
            }
        );
        assert_eq!(
            static_route("/renders/render-1.jpg"),
            Route::Render {
                file: "render-1.jpg".into()
            }
        );
        for hidden in [
            "/library/costs.csv",
            "/Library/costs.csv",
            "/LIBRARY/library.json",
            "/library/chair/source.jpg",
            "/library/chair/MODEL.GLB",
            "/library/chair/raw/engine-input.jpg",
            "/library/.trash/x/model.glb",
            "/library/.lock",
            "/scenes/s/source.heic",
            "/scenes/s/calib.json",
            "/scenes/s/",
            "/scenes",
            "/scenes/.trash/s/photo.jpg",
            "/renders/",
            "/renders/.hidden",
            "/renders/a/b.jpg",
            "/Planner/index.html",
            "/.env",
            "/planner/.git/config",
            "/%2e%65nv",
            "/fixtures/photos/x.jpg",
            "/IMG_0042",
            "/planner%00/x",
            "/api/scenes",
        ] {
            assert_eq!(static_route(hidden), Route::NotFound, "{hidden}");
        }
    }
}
