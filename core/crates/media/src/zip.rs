//! Which entries of an uploaded OBJ zip may be extracted (contract §2.8 Bodies: "Zips: only `.obj .mtl .png .jpg
//! .jpeg` extracted; no absolute paths, `..` or links; at most 500 MB unpacked and 1,000 entries", and one `.obj`).
//!
//! The decision is made from the central directory's entries, as the caller's zip reader lists them, before anything
//! is extracted; a zip that breaks any rule is refused whole. The caller must then extract exactly the planned
//! entries and stop each one at its declared size (v1: `extract` in `pipeline/src/midstudy_pipeline/objzip.py`).
//! v1: `zip_problem` in `planner/serve.py` (the messages below are its sentences) and `check` in `objzip.py`.

/// At most this many central-directory entries (directories and skipped entries count).
pub const MAX_ENTRIES: usize = 1000;
/// At most this many bytes unpacked, summed over the entries that would be extracted.
pub const MAX_UNPACKED: u64 = 500 * 1024 * 1024;
/// The extensions that may be extracted (compared in lowercase).
pub const ALLOWED: [&str; 5] = [".obj", ".mtl", ".png", ".jpg", ".jpeg"];

/// One central-directory entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry<'a> {
    /// The file name as stored.
    pub name: &'a [u8],
    /// General-purpose flag bit 11: the name is UTF-8 (else code page 437).
    pub utf8: bool,
    /// The uncompressed size (from the zip64 extra field when the 32-bit one is `0xFFFFFFFF`).
    pub size: u64,
    /// The external file attributes (Unix mode in the upper 16 bits).
    pub external_attr: u32,
}

/// What to do with an entry that breaks no rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Extract it; `obj` when it is the `.obj`.
    Extract {
        /// The entry is an `.obj`.
        obj: bool,
    },
    /// A directory, or macOS's `__MACOSX/` and `.DS_Store` metadata: never extracted.
    Skip,
}

/// The rule an entry breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// A name with a NUL, or flagged UTF-8 but not UTF-8 (v1 cut a name at its NUL, or crashed on bad UTF-8).
    BadName,
    /// Starts with `/` or `\`, has a drive letter (`C:`), or holds a backslash.
    Absolute,
    /// A `..` segment.
    Climbs,
    /// A symbolic link.
    Link,
    /// An extension other than `.obj .mtl .png .jpg .jpeg`.
    NotAllowed,
}

/// Why a zip is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// More than [`MAX_ENTRIES`] entries.
    TooManyEntries {
        /// How many there are.
        count: usize,
    },
    /// The first entry (in central-directory order) that breaks a rule.
    Entry {
        /// Its position in the central directory.
        index: usize,
        /// Its name, decoded as the zip says (UTF-8 or code page 437).
        name: String,
        /// The rule.
        problem: Problem,
    },
    /// The extracted entries would unpack to more than [`MAX_UNPACKED`] bytes.
    TooBig {
        /// Their total size.
        total: u64,
    },
    /// Not exactly one `.obj`.
    ObjCount {
        /// How many there are.
        found: usize,
    },
}

/// `total / 1e6` rounded half to even, as Python's `f"{total / 1e6:.0f}"` prints it.
pub(crate) fn megabytes(total: u64) -> u64 {
    let q = total / 1_000_000;
    let r = total % 1_000_000;
    if r > 500_000 || (r == 500_000 && q % 2 == 1) {
        q.saturating_add(1)
    } else {
        q
    }
}

impl core::fmt::Display for Refusal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Refusal::TooManyEntries { count } => {
                write!(
                    f,
                    "the zip has {count} entries, at most {MAX_ENTRIES} are allowed"
                )
            }
            Refusal::Entry { name, problem, .. } => match problem {
                Problem::BadName => write!(
                    f,
                    "the zip holds a file name that can't be read ({name}): re-zip the folder"
                ),
                Problem::Absolute => {
                    write!(
                        f,
                        "the zip holds an absolute path ({name}): zip the folder's contents instead"
                    )
                }
                Problem::Climbs => write!(
                    f,
                    "the zip holds a path that climbs out of it ({name}): re-zip the folder"
                ),
                Problem::Link => write!(
                    f,
                    "the zip holds a link ({name}): zip the real files instead"
                ),
                Problem::NotAllowed => {
                    write!(
                        f,
                        "the zip holds {name}: only .obj, .mtl, .png, .jpg and .jpeg files are allowed"
                    )
                }
            },
            Refusal::TooBig { total } => {
                write!(
                    f,
                    "the zip unpacks to {} MB, at most 500 MB is allowed",
                    megabytes(*total)
                )
            }
            Refusal::ObjCount { found } => {
                write!(
                    f,
                    "the zip must hold exactly one .obj with its .mtl and textures (found {found})"
                )
            }
        }
    }
}

/// Code page 437, 0x80–0xFF (0x00–0x7F are ASCII), as Python's `cp437` codec decodes it.
const CP437_HIGH: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ', 'Æ',
    'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú', 'ñ', 'Ñ',
    'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕',
    '╣', '║', '╗', '╝', '╜', '╛', '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦',
    '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐',
    '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', '≡', '±',
    '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u{A0}',
];

/// Decodes a code page 437 name (every byte is one character).
#[must_use]
pub fn decode_cp437(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b.is_ascii() {
                char::from(b)
            } else {
                CP437_HIGH
                    .get(usize::from(b & 0x7F))
                    .copied()
                    .unwrap_or('\u{FFFD}')
            }
        })
        .collect()
}

/// The entry's name as Python's `zipfile` decodes it, or `None` (bad UTF-8, or a NUL).
fn decode_name(entry: &Entry<'_>) -> Option<String> {
    if entry.name.contains(&0) {
        return None;
    }
    if entry.utf8 {
        String::from_utf8(entry.name.to_vec()).ok()
    } else {
        Some(decode_cp437(entry.name))
    }
}

/// `PurePosixPath(name).name`: the last segment that isn't empty or `.`.
fn last_segment(name: &str) -> &str {
    name.split('/')
        .rfind(|s| !s.is_empty() && *s != ".")
        .unwrap_or_default()
}

/// `PurePosixPath(name).suffix`, ASCII-lowercased (exact for comparing with [`ALLOWED`]: no non-ASCII character
/// lowercases to the ASCII letters they use).
fn suffix(name: &str) -> String {
    let last = last_segment(name);
    match last.rfind('.') {
        Some(i) if i > 0 && i.saturating_add(1) < last.len() => {
            last.get(i..).unwrap_or_default().to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

const S_IFMT: u32 = 0o170_000;
const S_IFLNK: u32 = 0o120_000;

/// The decision for one entry, with its decoded name (v1's per-entry checks, in v1's order).
///
/// # Errors
/// The [`Problem`] and the decoded name (the raw name as code page 437 when it can't be decoded).
pub fn decide(entry: &Entry<'_>) -> Result<Action, (Problem, String)> {
    let Some(name) = decode_name(entry) else {
        return Err((Problem::BadName, decode_cp437(entry.name)));
    };
    let second_is_colon = name.chars().nth(1) == Some(':');
    if name.starts_with('/') || name.starts_with('\\') || second_is_colon || name.contains('\\') {
        return Err((Problem::Absolute, name));
    }
    if name.split('/').any(|s| s == "..") {
        return Err((Problem::Climbs, name));
    }
    if entry.external_attr.wrapping_shr(16) & S_IFMT == S_IFLNK {
        return Err((Problem::Link, name));
    }
    if name.ends_with('/') || name.starts_with("__MACOSX/") || last_segment(&name) == ".DS_Store" {
        return Ok(Action::Skip);
    }
    let ext = suffix(&name);
    if !ALLOWED.contains(&ext.as_str()) {
        return Err((Problem::NotAllowed, name));
    }
    Ok(Action::Extract { obj: ext == ".obj" })
}

/// The entries to extract, in central-directory order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Positions of the entries to extract.
    pub extract: Vec<usize>,
    /// Positions of the entries skipped (directories, `__MACOSX/`, `.DS_Store`).
    pub skip: Vec<usize>,
    /// Position of the one `.obj`.
    pub obj: usize,
    /// Their total unpacked size.
    pub total: u64,
}

/// The plan for a whole zip, or the first rule it breaks (v1's order: the entry count, then each entry in order,
/// then the unpacked size, then the `.obj` count).
///
/// # Errors
/// [`Refusal`]: the first broken rule.
pub fn plan(entries: &[Entry<'_>]) -> Result<Plan, Refusal> {
    if entries.len() > MAX_ENTRIES {
        return Err(Refusal::TooManyEntries {
            count: entries.len(),
        });
    }
    let mut out = Plan {
        extract: Vec::new(),
        skip: Vec::new(),
        obj: 0,
        total: 0,
    };
    let mut objs = 0usize;
    for (index, entry) in entries.iter().enumerate() {
        match decide(entry) {
            Err((problem, name)) => {
                return Err(Refusal::Entry {
                    index,
                    name,
                    problem,
                });
            }
            Ok(Action::Skip) => out.skip.push(index),
            Ok(Action::Extract { obj }) => {
                if obj {
                    objs = objs.saturating_add(1);
                    out.obj = index;
                }
                out.total = out.total.saturating_add(entry.size);
                out.extract.push(index);
            }
        }
    }
    if out.total > MAX_UNPACKED {
        return Err(Refusal::TooBig { total: out.total });
    }
    if objs != 1 {
        return Err(Refusal::ObjCount { found: objs });
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn e(name: &str) -> Entry<'_> {
        Entry {
            name: name.as_bytes(),
            utf8: true,
            size: 10,
            external_attr: 0o100_644 << 16,
        }
    }

    #[test]
    fn entries() {
        assert_eq!(decide(&e("chair.obj")), Ok(Action::Extract { obj: true }));
        assert_eq!(
            decide(&e("tex/Wood.JPG")),
            Ok(Action::Extract { obj: false })
        );
        assert_eq!(decide(&e("tex/")), Ok(Action::Skip));
        assert_eq!(decide(&e("__MACOSX/._chair.obj")), Ok(Action::Skip));
        assert_eq!(decide(&e("a/.DS_Store")), Ok(Action::Skip));
        assert_eq!(
            decide(&e("/etc/x.obj")).map_err(|p| p.0),
            Err(Problem::Absolute)
        );
        assert_eq!(
            decide(&e("C:x.obj")).map_err(|p| p.0),
            Err(Problem::Absolute)
        );
        assert_eq!(
            decide(&e("é:x.obj")).map_err(|p| p.0),
            Err(Problem::Absolute)
        );
        assert_eq!(
            decide(&e("a\\b.obj")).map_err(|p| p.0),
            Err(Problem::Absolute)
        );
        assert_eq!(
            decide(&e("a/../../b.obj")).map_err(|p| p.0),
            Err(Problem::Climbs)
        );
        assert_eq!(
            decide(&e("x.exe")).map_err(|p| p.0),
            Err(Problem::NotAllowed)
        );
        assert_eq!(
            decide(&e(".obj")).map_err(|p| p.0),
            Err(Problem::NotAllowed)
        );
        assert_eq!(decide(&e("a.obj/.")), Ok(Action::Extract { obj: true }));
        let link = Entry {
            external_attr: 0o120_777 << 16,
            ..e("l.png")
        };
        assert_eq!(decide(&link).map_err(|p| p.0), Err(Problem::Link));
        let nul = Entry {
            name: b"a.obj\0.exe",
            ..e("")
        };
        assert_eq!(decide(&nul).map_err(|p| p.0), Err(Problem::BadName));
        let bad_utf8 = Entry {
            name: b"\xff.obj",
            ..e("")
        };
        assert_eq!(decide(&bad_utf8).map_err(|p| p.0), Err(Problem::BadName));
        let cp437 = Entry {
            name: b"\x80.obj",
            utf8: false,
            ..e("")
        };
        assert_eq!(decide(&cp437), Ok(Action::Extract { obj: true }));
    }

    #[test]
    fn plans() {
        let ok = [e("m/"), e("m/chair.obj"), e("m/chair.mtl"), e("m/wood.png")];
        let p = plan(&ok).unwrap();
        assert_eq!(
            (p.extract, p.skip, p.obj, p.total),
            (vec![1, 2, 3], vec![0], 1, 30)
        );
        assert_eq!(plan(&[e("a.mtl")]), Err(Refusal::ObjCount { found: 0 }));
        assert_eq!(
            plan(&[e("a.obj"), e("b.obj")]),
            Err(Refusal::ObjCount { found: 2 })
        );
        let big = Entry {
            size: MAX_UNPACKED + 1,
            ..e("a.obj")
        };
        assert_eq!(
            plan(&[big]).unwrap_err().to_string(),
            "the zip unpacks to 524 MB, at most 500 MB is allowed"
        );
        let many = vec![e("a.obj"); MAX_ENTRIES + 1];
        assert_eq!(plan(&many), Err(Refusal::TooManyEntries { count: 1001 }));
        let r = plan(&[e("a.obj"), e("../b.png")]).unwrap_err();
        assert_eq!(
            r.to_string(),
            "the zip holds a path that climbs out of it (../b.png): re-zip the folder"
        );
    }

    #[test]
    fn megabytes_round_half_even() {
        assert_eq!(megabytes(524_500_000), 524);
        assert_eq!(megabytes(525_500_000), 526);
        assert_eq!(megabytes(524_500_001), 525);
        assert_eq!(megabytes(524_499_999), 524);
    }
}
