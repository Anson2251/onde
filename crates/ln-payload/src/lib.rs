//! The onde payload: a flat, read-only map of ES modules linked into an executable.
//!
//! A standalone onde app is one binary plus one buffer. The buffer is the *payload*: every module
//! the app needs, keyed by the bundler's output filename, plus three facts about the engine that
//! produced it (bytecode version, byte order, atom table). This crate owns that format — build it,
//! parse it, validate it — and nothing else. The runtime reads it; `ondec` writes it; neither
//! re-implements the layout.
//!
//! ```text
//! header (36 bytes, little-endian)
//!   magic "ONDEPAY\0" | format u16 | flags u16
//!   bc_version u8 | endian u8 | reserved u16
//!   atom_hash u32
//!   module_count u32 | entry_index u32 | table_offset u32 | total_len u32
//!
//! table (module_count entries, sorted by key so lookup is a binary search)
//!   key_len u16 | key (utf8, POSIX, relative)
//!   kind u8     1 = esm-bytecode, 2 = esm-source
//!   flags u8
//!   offset u32 | len u32
//!
//! bodies
//! ```
//!
//! # Design notes
//!
//! **Keys are names, not paths.** A key is exactly the bundler's asset filename relative to the
//! project root (`index.js`, `chunks/a-3f2c1d.js`), which is what `__filename`, `import.meta.url`
//! and stack traces show. The map is flat; a directory exists only as a prefix inside a key,
//! which is all the module resolver needs.
//!
//! **There is no checksum.** The payload is inside the executable, so its integrity is the
//! executable's integrity. The header keeps `bc_version`, `endian` and `atom_hash` because those
//! are compatibility, not integrity: loading bytecode compiled by another engine is unsafe and
//! must fail before the first `JS_ReadObject`.
//!
//! **Structure is validated, not trusted.** `JS_READ_OBJ_BYTECODE` on a truncated stream is
//! undefined behaviour, so both ends check the same O(1) invariants: magic, format, flags, every
//! table offset and length inside the body region, `entry_index` in range, `total_len` consistent.
//! A clear "bad payload" beats a crash — but this guards against bugs and corruption, not an
//! attacker who can already rewrite the binary.
//!
//! **Compression is opt-in and whole-region.** The flag says "everything after the header is a
//! zlib stream of the uncompressed image"; [`Payload::parse`] hands that stream back instead of
//! inflating it, so this crate stays dependency-free and the caller decides whether the ~1.4 ms
//! per MiB is worth it. Compression is off by default because the rule for this project is that
//! startup performance is not traded for package size.

use std::fmt;

use ln_abi::Stamp;

/// An uncompressed payload starts with these bytes.
pub const MAGIC: [u8; 8] = *b"ONDEPAY\0";

/// The payload format this crate reads and writes.
pub const FORMAT: u16 = 1;

/// Size of the fixed header.
pub const HEADER_LEN: usize = 36;

/// Flag bit: the bytes after the header are a compressed stream of the uncompressed image.
pub const FLAG_COMPRESSED: u16 = 1;

/// Where the codec id starts in `flags` (two bits: zlib, zstd, and two reserved).
const CODEC_SHIFT: u16 = 1;

/// The codec id field.
const CODEC_MASK: u16 = 0b11 << CODEC_SHIFT;

/// Every flag bit this version defines; any other bit is a corrupt payload.
const KNOWN_FLAGS: u16 = FLAG_COMPRESSED | CODEC_MASK;

/// How a compressed payload's bodies are encoded.
///
/// The codec id lives in the header's flags, next to the "compressed" bit, so a payload always
/// says what it is before any decoder is chosen. `zlib` is the historical default and the one a
/// runtime already links for `node:zlib`; `zstd` compresses better and decompresses faster but
/// costs a decoder in the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    /// zlib (RFC 1950): what `node:zlib` already provides.
    Zlib = 0,
    /// zstd (RFC 8878): better ratio, faster decompression, a new decoder.
    Zstd = 1,
}

impl Codec {
    /// The id stored in the header.
    pub fn id(self) -> u16 {
        self as u16
    }

    /// Parse an id.
    pub fn from_id(id: u16) -> Option<Codec> {
        match id {
            0 => Some(Codec::Zlib),
            1 => Some(Codec::Zstd),
            _ => None,
        }
    }

    /// The name used in diagnostics and `--compress`.
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::Zlib => "zlib",
            Codec::Zstd => "zstd",
        }
    }

    /// The flag word for a compressed payload in this codec.
    fn flags(self) -> u16 {
        FLAG_COMPRESSED | (self.id() << CODEC_SHIFT)
    }

    /// The codec of a payload whose flags say it is compressed.
    fn from_flags(flags: u16) -> Option<Codec> {
        if flags & FLAG_COMPRESSED == 0 {
            return None;
        }
        Codec::from_id((flags & CODEC_MASK) >> CODEC_SHIFT)
    }
}

/// The payload is bounded to 4 GiB by its 32-bit lengths.
pub const MAX_LEN: u64 = u32::MAX as u64;

/// How a module is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// QuickJS module bytecode, loaded with `JS_ReadObject`.
    Bytecode = 1,
    /// ES module source, declared and compiled at startup (`--no-bytecode`).
    Source = 2,
}

impl Kind {
    fn from_byte(byte: u8) -> Option<Kind> {
        match byte {
            1 => Some(Kind::Bytecode),
            2 => Some(Kind::Source),
            _ => None,
        }
    }

    /// Human name, for diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Bytecode => "bytecode",
            Kind::Source => "source",
        }
    }
}

/// The fixed header, decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// Payload format version.
    pub format: u16,
    /// [`FLAG_COMPRESSED`] or zero.
    pub flags: u16,
    /// The engine's `BC_VERSION`.
    pub bc_version: u8,
    /// 0 = little-endian, 1 = big-endian.
    pub endian: u8,
    /// FNV-1a of the engine's atom table, the same value as the ABI stamp.
    pub atom_hash: u32,
    /// Number of modules.
    pub module_count: u32,
    /// Index of the entry module in the (sorted) table.
    pub entry_index: u32,
    /// Where the table starts; [`HEADER_LEN`] in this version.
    pub table_offset: u32,
    /// Length of the *uncompressed* image.
    pub total_len: u32,
}

/// One module in the payload.
#[derive(Debug, Clone, Copy)]
pub struct Entry<'a> {
    /// The bundler's filename relative to the project root, POSIX separators.
    pub key: &'a str,
    /// Bytecode or source.
    pub kind: Kind,
    /// Reserved; zero in this version.
    pub flags: u8,
    /// The module's bytes, borrowed from the payload.
    pub body: &'a [u8],
}

/// A parsed payload.
#[derive(Debug)]
pub struct Payload<'a> {
    header: Header,
    entries: Vec<Entry<'a>>,
}

/// The two things [`Payload::parse`] can find.
#[derive(Debug)]
pub enum Parsed<'a> {
    /// An uncompressed payload, ready to use.
    Image(Payload<'a>),
    /// A compressed payload: inflate `stream` to exactly `total_len` bytes, then parse that image.
    Compressed {
        /// Length the uncompressed image must have.
        total_len: usize,
        /// How the stream is encoded.
        codec: Codec,
        /// The compressed body (everything after the header).
        stream: &'a [u8],
    },
}

/// Why a payload could not be built or read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl Error {
    fn new(message: impl Into<String>) -> Error {
        Error(message.into())
    }

    /// An error from outside this crate (a compressor, a caller's own validation).
    pub fn from_message(message: impl Into<String>) -> Error {
        Error(message.into())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Error {
        Error(message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl<'a> Payload<'a> {
    /// Read a payload.
    ///
    /// A compressed payload is *not* inflated here; the caller gets [`Parsed::Compressed`] and
    /// calls back with the inflated image. That keeps the format crate free of a decompressor and
    /// keeps the "is this even a payload?" check ahead of spending CPU on the stream.
    pub fn parse(raw: &'a [u8]) -> Result<Parsed<'a>, Error> {
        let header = Header::parse(raw)?;

        if header.flags & FLAG_COMPRESSED != 0 {
            let total_len = header.total_len as usize;
            if total_len < HEADER_LEN {
                return Err(Error::new(format!(
                    "payload header claims {total_len} bytes, less than the header"
                )));
            }
            let codec = Codec::from_flags(header.flags).ok_or_else(|| {
                Error::new(format!(
                    "payload claims compressed data with codec id {}; this build knows zlib and zstd",
                    (header.flags & CODEC_MASK) >> CODEC_SHIFT
                ))
            })?;
            return Ok(Parsed::Compressed {
                total_len,
                codec,
                stream: &raw[HEADER_LEN..],
            });
        }

        let entries = parse_image(raw, &header)?;
        Ok(Parsed::Image(Payload { header, entries }))
    }

    /// The decoded header.
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// Every module, in key order.
    pub fn entries(&self) -> &[Entry<'a>] {
        &self.entries
    }

    /// The module the process starts from.
    pub fn entry(&self) -> &Entry<'a> {
        &self.entries[self.header.entry_index as usize]
    }

    /// Look up a module by key.
    pub fn get(&self, key: &str) -> Option<&Entry<'a>> {
        self.entries
            .binary_search_by(|entry| entry.key.cmp(key))
            .ok()
            .map(|index| &self.entries[index])
    }

    /// Is this key present?
    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Keys, in order.
    pub fn keys(&self) -> impl Iterator<Item = &'a str> + '_ {
        self.entries.iter().map(|entry| entry.key)
    }

    /// Check the payload against the engine that is about to run it.
    ///
    /// This is the check that has to happen before `JS_ReadObject`: equal bytecode version, byte
    /// order and atom table. The error names what differs, because "the app was built for a
    /// different version of onde" is only actionable with the two versions in it.
    pub fn check_engine(&self, stamp: &Stamp) -> Result<(), Error> {
        let mut differences = Vec::new();
        if self.header.bc_version != stamp.bc as u8 {
            differences.push(format!(
                "bytecode version {} (payload) vs {} (runtime)",
                self.header.bc_version, stamp.bc
            ));
        }
        let endian = if self.header.endian == 0 { "le" } else { "be" };
        if endian != stamp.endian.as_str() {
            differences.push(format!(
                "endianness {endian} (payload) vs {} (runtime)",
                stamp.endian
            ));
        }
        if self.header.atom_hash != stamp.atom {
            differences.push(format!(
                "atom table {:08x} (payload) vs {:08x} (runtime)",
                self.header.atom_hash, stamp.atom
            ));
        }
        if differences.is_empty() {
            Ok(())
        } else {
            Err(Error::new(differences.join("; ")))
        }
    }
}

impl Header {
    fn parse(raw: &[u8]) -> Result<Header, Error> {
        if raw.len() < HEADER_LEN {
            return Err(Error::new(format!(
                "{} bytes is too short for a payload header ({HEADER_LEN} needed)",
                raw.len()
            )));
        }
        if raw[..8] != MAGIC {
            return Err(Error::new("not an onde payload (bad magic)"));
        }
        let format = u16::from_le_bytes([raw[8], raw[9]]);
        if format != FORMAT {
            return Err(Error::new(format!(
                "payload format {format}, this runtime reads {FORMAT}"
            )));
        }
        let flags = u16::from_le_bytes([raw[10], raw[11]]);
        if flags & !KNOWN_FLAGS != 0 {
            return Err(Error::new(format!(
                "payload flags {flags:#06x} name features this runtime does not have"
            )));
        }
        let bc_version = raw[12];
        let endian = raw[13];
        if endian > 1 {
            return Err(Error::new(format!(
                "payload byte order {endian} is not 0 or 1"
            )));
        }
        let reserved = u16::from_le_bytes([raw[14], raw[15]]);
        if reserved != 0 {
            return Err(Error::new(format!(
                "payload reserved field is {reserved}, not 0"
            )));
        }
        let header = Header {
            format,
            flags,
            bc_version,
            endian,
            atom_hash: u32::from_le_bytes([raw[16], raw[17], raw[18], raw[19]]),
            module_count: u32::from_le_bytes([raw[20], raw[21], raw[22], raw[23]]),
            entry_index: u32::from_le_bytes([raw[24], raw[25], raw[26], raw[27]]),
            table_offset: u32::from_le_bytes([raw[28], raw[29], raw[30], raw[31]]),
            total_len: u32::from_le_bytes([raw[32], raw[33], raw[34], raw[35]]),
        };
        Ok(header)
    }
}

fn parse_image<'a>(raw: &'a [u8], header: &Header) -> Result<Vec<Entry<'a>>, Error> {
    if header.total_len as usize != raw.len() {
        return Err(Error::new(format!(
            "payload header claims {} bytes but the image is {}",
            header.total_len,
            raw.len()
        )));
    }
    if header.module_count == 0 {
        return Err(Error::new("payload has no modules"));
    }
    if header.entry_index >= header.module_count {
        return Err(Error::new(format!(
            "payload entry index {} is outside the {} modules",
            header.entry_index, header.module_count
        )));
    }
    if header.table_offset as usize != HEADER_LEN {
        return Err(Error::new(format!(
            "payload table offset {}, expected {HEADER_LEN}",
            header.table_offset
        )));
    }

    struct Slot<'a> {
        key: &'a str,
        kind: Kind,
        flags: u8,
        offset: usize,
        len: usize,
    }

    let mut cursor = HEADER_LEN;
    let mut slots = Vec::with_capacity(header.module_count as usize);
    for index in 0..header.module_count {
        let key_len = read_u16(raw, &mut cursor, "key length")? as usize;
        if key_len == 0 {
            return Err(Error::new(format!("module {index} has an empty key")));
        }
        let key_end = cursor
            .checked_add(key_len)
            .filter(|end| *end <= raw.len())
            .ok_or_else(|| Error::new(format!("module {index} key runs past the payload")))?;
        let key = std::str::from_utf8(&raw[cursor..key_end])
            .map_err(|_| Error::new(format!("module {index} key is not UTF-8")))?;
        validate_key(key)?;
        if let Some(previous) = slots.last() {
            let previous: &Slot = previous;
            if previous.key >= key {
                return Err(Error::new(format!(
                    "module keys are not sorted: {key} follows {}",
                    previous.key
                )));
            }
        }
        cursor = key_end;

        let kind = Kind::from_byte(read_u8(raw, &mut cursor, "kind")?)
            .ok_or_else(|| Error::new(format!("module {index} has an unknown kind")))?;
        let flags = read_u8(raw, &mut cursor, "module flags")?;
        if flags != 0 {
            return Err(Error::new(format!(
                "module {index} ({key}) has flags {flags}, not 0"
            )));
        }
        let offset = read_u32(raw, &mut cursor, "body offset")? as usize;
        let len = read_u32(raw, &mut cursor, "body length")? as usize;

        slots.push(Slot {
            key,
            kind,
            flags,
            offset,
            len,
        });
    }

    // The bodies start after the table, so their bounds are only knowable now.
    let table_end = cursor;
    let mut entries = Vec::with_capacity(slots.len());
    for (index, slot) in slots.into_iter().enumerate() {
        if slot.offset < table_end {
            return Err(Error::new(format!(
                "module {index} ({}) body starts at {}, inside the table (ends {table_end})",
                slot.key, slot.offset
            )));
        }
        let end = slot
            .offset
            .checked_add(slot.len)
            .filter(|end| *end <= raw.len())
            .ok_or_else(|| {
                Error::new(format!(
                    "module {index} ({}) body {}..{} runs past the image",
                    slot.key,
                    slot.offset,
                    slot.offset.saturating_add(slot.len)
                ))
            })?;
        entries.push(Entry {
            key: slot.key,
            kind: slot.kind,
            flags: slot.flags,
            body: &raw[slot.offset..end],
        });
    }

    Ok(entries)
}

fn read_u8(raw: &[u8], cursor: &mut usize, what: &str) -> Result<u8, Error> {
    let byte = raw
        .get(*cursor)
        .copied()
        .ok_or_else(|| Error::new(format!("payload ends while reading {what}")))?;
    *cursor += 1;
    Ok(byte)
}

fn read_u16(raw: &[u8], cursor: &mut usize, what: &str) -> Result<u16, Error> {
    let bytes = raw
        .get(*cursor..*cursor + 2)
        .ok_or_else(|| Error::new(format!("payload ends while reading {what}")))?;
    *cursor += 2;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(raw: &[u8], cursor: &mut usize, what: &str) -> Result<u32, Error> {
    let bytes = raw
        .get(*cursor..*cursor + 4)
        .ok_or_else(|| Error::new(format!("payload ends while reading {what}")))?;
    *cursor += 4;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// A payload key is a POSIX, root-relative path with no `.`/`..`/empty segments.
///
/// Rejecting these at build time is what lets the runtime treat a key as an opaque name instead
/// of parsing it again at every import. The error is specific because the key came from a file
/// the user can see.
pub fn validate_key(key: &str) -> Result<(), Error> {
    if key.is_empty() {
        return Err(Error::new("payload key is empty"));
    }
    if key.len() > u16::MAX as usize {
        return Err(Error::new(format!(
            "payload key of {} bytes is longer than 65535",
            key.len()
        )));
    }
    if key.contains('\0') {
        return Err(Error::new(format!("payload key {key:?} contains a NUL")));
    }
    if key.contains('\\') {
        return Err(Error::new(format!(
            "payload key {key:?} contains a backslash; keys are POSIX paths"
        )));
    }
    if key.starts_with('/') {
        return Err(Error::new(format!(
            "payload key {key:?} is absolute; keys are relative to the project root"
        )));
    }
    if key.ends_with('/') {
        return Err(Error::new(format!("payload key {key:?} ends with '/'")));
    }
    for segment in key.split('/') {
        match segment {
            "" => {
                return Err(Error::new(format!(
                    "payload key {key:?} has an empty path segment"
                )))
            }
            "." | ".." => {
                return Err(Error::new(format!(
                    "payload key {key:?} contains a {segment:?} segment"
                )))
            }
            _ => {}
        }
    }
    Ok(())
}

/// The directory part of a key, `"."` at the payload root.
///
/// This is what `import.meta.dirname` shows in a compiled app: a name, not a filesystem path.
pub fn dirname(key: &str) -> &str {
    match key.rsplit_once('/') {
        Some((dir, _)) => dir,
        None => ".",
    }
}

/// Resolve an import specifier against the importing module's key.
///
/// This is the compiled-mode module resolution rule, in one function so the runtime and the
/// build tool cannot drift:
///
/// - `./a.js`, `../a.js`, `.`, `..` — join with the importer's directory, then normalize;
/// - `/a.js` — normalize from the payload root;
/// - anything else (a bare specifier) — `None`: builtins are handled before this, and everything
///   else is a module-not-found error, because a compiled app has no `node_modules`.
///
/// `None` also means "the path escapes the root", which is the same error to the caller.
pub fn resolve_key(base_key: &str, specifier: &str) -> Option<String> {
    let (prefix, rest) = if let Some(rest) = specifier.strip_prefix('/') {
        ("root", rest)
    } else if specifier == "." || specifier.starts_with("./") || specifier.starts_with("../") {
        ("base", specifier)
    } else {
        return None;
    };

    let mut segments: Vec<&str> = Vec::new();
    if prefix == "base" {
        if let Some((dir, _)) = base_key.rsplit_once('/') {
            segments.extend(dir.split('/'));
        }
    }
    for segment in rest.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            segment => segments.push(segment),
        }
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

/// Build an uncompressed payload image.
#[derive(Debug)]
pub struct Builder {
    bc_version: u8,
    endian: u8,
    atom_hash: u32,
    modules: Vec<(String, Kind, Vec<u8>)>,
    entry: Option<String>,
}

impl Builder {
    /// A builder whose header names `stamp`'s engine.
    pub fn new(stamp: &Stamp) -> Result<Builder, Error> {
        let bc_version = u8::try_from(stamp.bc).map_err(|_| {
            Error::new(format!(
                "bytecode version {} does not fit in the payload's u8 field",
                stamp.bc
            ))
        })?;
        Ok(Builder {
            bc_version,
            endian: match stamp.endian {
                ln_abi::Endian::Little => 0,
                ln_abi::Endian::Big => 1,
            },
            atom_hash: stamp.atom,
            modules: Vec::new(),
            entry: None,
        })
    }

    /// Add one module. Keys are validated here, not at parse time.
    pub fn push(&mut self, key: &str, kind: Kind, body: &[u8]) -> Result<(), Error> {
        validate_key(key)?;
        if self.modules.iter().any(|(existing, _, _)| existing == key) {
            return Err(Error::new(format!("duplicate payload key {key:?}")));
        }
        self.modules.push((key.to_owned(), kind, body.to_vec()));
        Ok(())
    }

    /// Mark an existing key as the entry module.
    pub fn set_entry(&mut self, key: &str) -> Result<(), Error> {
        if !self.modules.iter().any(|(existing, _, _)| existing == key) {
            return Err(Error::new(format!(
                "entry {key:?} is not one of the payload's keys"
            )));
        }
        self.entry = Some(key.to_owned());
        Ok(())
    }

    /// Encode the image: header, sorted table, bodies.
    ///
    /// The table is sorted by key, so the encoding is a pure function of the set of modules and
    /// not of the order they were added — two builds of the same app produce identical payloads.
    pub fn build(mut self) -> Result<Vec<u8>, Error> {
        let entry = self
            .entry
            .take()
            .ok_or_else(|| Error::new("no entry module: call set_entry() before build()"))?;
        if self.modules.is_empty() {
            return Err(Error::new("payload has no modules"));
        }
        self.modules.sort_by(|left, right| left.0.cmp(&right.0));

        let entry_index = self
            .modules
            .binary_search_by(|(key, _, _)| key.as_str().cmp(entry.as_str()))
            .map_err(|_| Error::new(format!("entry {entry:?} disappeared")))?;

        let table_len: usize = self
            .modules
            .iter()
            .map(|(key, _, _)| 2 + key.len() + 1 + 1 + 4 + 4)
            .sum();
        let body_start = HEADER_LEN
            .checked_add(table_len)
            .ok_or_else(|| Error::new("payload table overflows usize"))?;
        let total_len: usize = self
            .modules
            .iter()
            .map(|(_, _, body)| body.len())
            .try_fold(body_start, |total, len| total.checked_add(len))
            .ok_or_else(|| Error::new("payload length overflows usize"))?;
        if total_len as u64 > MAX_LEN {
            return Err(Error::new(format!(
                "payload of {total_len} bytes exceeds the 4 GiB format limit"
            )));
        }

        let mut image = Vec::with_capacity(total_len);
        image.extend_from_slice(&MAGIC);
        image.extend_from_slice(&FORMAT.to_le_bytes());
        image.extend_from_slice(&0u16.to_le_bytes()); // flags
        image.push(self.bc_version);
        image.push(self.endian);
        image.extend_from_slice(&0u16.to_le_bytes()); // reserved
        image.extend_from_slice(&self.atom_hash.to_le_bytes());
        image.extend_from_slice(&(self.modules.len() as u32).to_le_bytes());
        image.extend_from_slice(&(entry_index as u32).to_le_bytes());
        image.extend_from_slice(&(HEADER_LEN as u32).to_le_bytes());
        image.extend_from_slice(&(total_len as u32).to_le_bytes());

        let mut offset = body_start;
        for (key, kind, body) in &self.modules {
            image.extend_from_slice(&(key.len() as u16).to_le_bytes());
            image.extend_from_slice(key.as_bytes());
            image.push(*kind as u8);
            image.push(0); // module flags
            image.extend_from_slice(&(offset as u32).to_le_bytes());
            image.extend_from_slice(&(body.len() as u32).to_le_bytes());
            offset += body.len();
        }
        debug_assert_eq!(image.len(), body_start);
        for (_, _, body) in &self.modules {
            image.extend_from_slice(body);
        }
        debug_assert_eq!(image.len(), total_len);

        // Parse what was just built: a builder bug must never reach a user's executable.
        match Payload::parse(&image) {
            Ok(Parsed::Image(parsed)) => {
                if parsed.entry().key != entry {
                    return Err(Error::new("payload entry does not round-trip"));
                }
            }
            Ok(Parsed::Compressed { .. }) => {
                return Err(Error::new("freshly built payload claims to be compressed"))
            }
            Err(error) => return Err(Error::new(format!("built payload is invalid: {error}"))),
        }
        Ok(image)
    }
}

/// Compress a payload image built by [`Builder::build`].
///
/// `compress` is the caller's encoder: this crate has no compression dependency. The header stays
/// in the clear (it is what identifies the payload before any work is done, including which codec
/// the stream uses) and everything after it is replaced by the stream.
pub fn compress(
    image: &[u8],
    codec: Codec,
    compress: impl FnOnce(&[u8]) -> Result<Vec<u8>, Error>,
) -> Result<Vec<u8>, Error> {
    let header = match Payload::parse(image)? {
        Parsed::Image(payload) => *payload.header(),
        Parsed::Compressed { .. } => return Err(Error::new("payload is already compressed")),
    };
    let stream = compress(&image[HEADER_LEN..])?;

    let mut out = Vec::with_capacity(HEADER_LEN + stream.len());
    out.extend_from_slice(&image[..HEADER_LEN]);
    out[10..12].copy_from_slice(&(header.flags | codec.flags()).to_le_bytes());
    out.extend_from_slice(&stream);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp() -> Stamp {
        Stamp {
            format: 1,
            qjs: "0.17.0".to_owned(),
            bc: 28,
            endian: ln_abi::Endian::Little,
            atom: 0x3f9a_1c02,
        }
    }

    fn sample() -> Vec<u8> {
        let mut builder = Builder::new(&stamp()).unwrap();
        builder
            .push(
                "chunks/shared.js",
                Kind::Source,
                b"export const shared = 1;",
            )
            .unwrap();
        builder
            .push("index.js", Kind::Bytecode, b"\x01\x02\x03\x04")
            .unwrap();
        builder
            .push("worker.js", Kind::Source, b"export const worker = 2;")
            .unwrap();
        builder.set_entry("index.js").unwrap();
        builder.build().unwrap()
    }

    fn image(bytes: &[u8]) -> Payload<'_> {
        match Payload::parse(bytes).expect("valid payload") {
            Parsed::Image(payload) => payload,
            Parsed::Compressed { .. } => panic!("expected an uncompressed payload"),
        }
    }

    #[test]
    fn round_trips_modules_and_the_entry() {
        let bytes = sample();
        let payload = image(&bytes);

        assert_eq!(payload.header().format, FORMAT);
        assert_eq!(payload.header().bc_version, 28);
        assert_eq!(payload.header().endian, 0);
        assert_eq!(payload.header().atom_hash, 0x3f9a_1c02);
        assert_eq!(payload.header().module_count, 3);
        assert_eq!(payload.header().table_offset, HEADER_LEN as u32);
        assert_eq!(payload.header().total_len as usize, bytes.len());

        let keys: Vec<_> = payload.keys().collect();
        assert_eq!(keys, vec!["chunks/shared.js", "index.js", "worker.js"]);
        assert_eq!(payload.entry().key, "index.js");
        assert_eq!(payload.entry().kind, Kind::Bytecode);
        assert_eq!(payload.entry().body, b"\x01\x02\x03\x04");

        let shared = payload.get("chunks/shared.js").expect("shared chunk");
        assert_eq!(shared.kind, Kind::Source);
        assert_eq!(shared.body, b"export const shared = 1;");
        assert!(payload.get("missing.js").is_none());
    }

    #[test]
    fn the_table_is_sorted_and_the_encoding_is_deterministic() {
        let first = sample();
        let mut builder = Builder::new(&stamp()).unwrap();
        builder
            .push("worker.js", Kind::Source, b"export const worker = 2;")
            .unwrap();
        builder
            .push("index.js", Kind::Bytecode, b"\x01\x02\x03\x04")
            .unwrap();
        builder
            .push(
                "chunks/shared.js",
                Kind::Source,
                b"export const shared = 1;",
            )
            .unwrap();
        builder.set_entry("index.js").unwrap();
        assert_eq!(builder.build().unwrap(), first);
    }

    #[test]
    fn rejects_bad_keys_at_build_time() {
        let mut builder = Builder::new(&stamp()).unwrap();
        for key in [
            "",
            "/abs.js",
            "../up.js",
            "a/../b.js",
            "a//b.js",
            "a/./b.js",
            "dir/",
            "back\\slash.js",
            "nul\0byte.js",
        ] {
            assert!(
                builder.push(key, Kind::Source, b"").is_err(),
                "key {key:?} should be rejected"
            );
        }
        builder.push("ok.js", Kind::Source, b"").unwrap();
        assert!(builder.push("ok.js", Kind::Source, b"").is_err());
    }

    #[test]
    fn requires_an_entry_that_exists() {
        let mut builder = Builder::new(&stamp()).unwrap();
        builder.push("a.js", Kind::Source, b"").unwrap();
        assert!(builder.set_entry("b.js").is_err());
        assert!(builder.build().is_err(), "no entry was set");
    }

    #[test]
    fn rejects_a_corrupt_header() {
        let bytes = sample();

        let mut bad_magic = bytes.clone();
        bad_magic[0] = b'X';
        assert!(Payload::parse(&bad_magic).is_err());

        let mut bad_format = bytes.clone();
        bad_format[8..10].copy_from_slice(&99u16.to_le_bytes());
        let error = Payload::parse(&bad_format).err().unwrap();
        assert!(error.to_string().contains("format 99"));

        let mut unknown_flag = bytes.clone();
        unknown_flag[10..12].copy_from_slice(&0x8000u16.to_le_bytes());
        assert!(Payload::parse(&unknown_flag).is_err());

        let mut reserved = bytes.clone();
        reserved[14..16].copy_from_slice(&7u16.to_le_bytes());
        assert!(Payload::parse(&reserved).is_err());

        let mut bad_endian = bytes.clone();
        bad_endian[13] = 9;
        assert!(Payload::parse(&bad_endian).is_err());

        assert!(Payload::parse(&bytes[..20]).is_err());
    }

    #[test]
    fn rejects_a_truncated_or_overlong_body() {
        let bytes = sample();

        // total_len is the last header field; shrink the image but keep the header's claim.
        let truncated = &bytes[..bytes.len() - 1];
        let error = Payload::parse(truncated).err().unwrap();
        assert!(error.to_string().contains("claims"));

        // Entries are sorted, so index.js is the second one: patch its body length to run past
        // the image and expect the bounds check to catch it.
        let mut overlong = bytes.clone();
        let mut cursor = HEADER_LEN;
        for _ in 0..2 {
            let key_len = u16::from_le_bytes([overlong[cursor], overlong[cursor + 1]]) as usize;
            cursor += 2 + key_len + 1 + 1;
            cursor += 8;
        }
        // Now `cursor` is at the end of index.js's entry; its length field is 4 bytes back.
        let len_field = cursor - 4;
        overlong[len_field..len_field + 4].copy_from_slice(&1_000_000u32.to_le_bytes());
        let error = Payload::parse(&overlong).err().unwrap();
        assert!(error.to_string().contains("runs past"), "{error}");
    }

    #[test]
    fn rejects_an_entry_index_outside_the_table() {
        let mut bytes = sample();
        bytes[24..28].copy_from_slice(&7u32.to_le_bytes());
        assert!(Payload::parse(&bytes).is_err());
    }

    #[test]
    fn rejects_unsorted_keys() {
        // Hand-build two modules in reverse key order.
        let mut builder = Builder::new(&stamp()).unwrap();
        builder.push("a.js", Kind::Source, b"a").unwrap();
        builder.push("b.js", Kind::Source, b"b").unwrap();
        builder.set_entry("a.js").unwrap();
        let mut bytes = builder.build().unwrap();

        // Swap the two keys' bytes in the table: "a.js" (4) and "b.js" (4).
        let first_key = HEADER_LEN + 2;
        bytes[first_key] = b'b';
        let second_key = first_key + 4 + 1 + 1 + 8 + 2;
        bytes[second_key] = b'a';
        let error = Payload::parse(&bytes).err().unwrap();
        assert!(error.to_string().contains("not sorted"), "{error}");
    }

    #[test]
    fn a_compressed_payload_returns_its_stream() {
        let bytes = sample();
        let compressed = compress(&bytes, Codec::Zlib, |raw| Ok(raw.to_vec())).unwrap();
        // The header is the original header with the compressed flag set, nothing else.
        assert_eq!(&compressed[..10], &bytes[..10]);
        assert_eq!(&compressed[12..HEADER_LEN], &bytes[12..HEADER_LEN]);
        assert_eq!(
            u16::from_le_bytes([compressed[10], compressed[11]]),
            FLAG_COMPRESSED
        );

        match Payload::parse(&compressed).unwrap() {
            Parsed::Compressed {
                total_len,
                codec,
                stream,
            } => {
                assert_eq!(total_len, bytes.len());
                assert_eq!(codec, Codec::Zlib);
                assert_eq!(stream, &bytes[HEADER_LEN..]);
            }
            Parsed::Image(_) => panic!("expected the compressed variant"),
        }
    }

    #[test]
    fn the_codec_lives_in_the_flags() {
        let bytes = sample();
        for codec in [Codec::Zlib, Codec::Zstd] {
            let compressed = compress(&bytes, codec, |raw| Ok(raw.to_vec())).unwrap();
            let flags = u16::from_le_bytes([compressed[10], compressed[11]]);
            assert_ne!(flags & FLAG_COMPRESSED, 0);
            match Payload::parse(&compressed).unwrap() {
                Parsed::Compressed { codec: parsed, .. } => assert_eq!(parsed, codec),
                Parsed::Image(_) => panic!("expected the compressed variant"),
            }
        }

        // A codec id this build does not know is a clear error, not a misdecode.
        let mut compressed = compress(&bytes, Codec::Zlib, |raw| Ok(raw.to_vec())).unwrap();
        compressed[10] |= 0b11 << CODEC_SHIFT;
        let error = Payload::parse(&compressed).err().unwrap();
        assert!(error.to_string().contains("codec id"), "{error}");
    }

    #[test]
    fn checks_the_engine_identity() {
        let bytes = sample();
        let payload = image(&bytes);
        assert_eq!(payload.check_engine(&stamp()), Ok(()));

        let mut other = stamp();
        other.bc = 29;
        other.atom = 0x1111_2222;
        let error = payload.check_engine(&other).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("bytecode version 28 (payload) vs 29"),
            "{message}"
        );
        assert!(message.contains("atom table"), "{message}");
    }

    #[test]
    fn dirname_is_the_name_prefix() {
        assert_eq!(dirname("index.js"), ".");
        assert_eq!(dirname("src/index.js"), "src");
        assert_eq!(dirname("src/deep/index.js"), "src/deep");
    }

    #[test]
    fn resolves_relative_dot_and_root_specifiers() {
        assert_eq!(
            resolve_key("index.js", "./worker.js").as_deref(),
            Some("worker.js")
        );
        assert_eq!(
            resolve_key("src/index.js", "./worker.js").as_deref(),
            Some("src/worker.js")
        );
        assert_eq!(
            resolve_key("src/deep/index.js", "../worker.js").as_deref(),
            Some("src/worker.js")
        );
        assert_eq!(
            resolve_key("src/index.js", "./chunks/a.js").as_deref(),
            Some("src/chunks/a.js")
        );
        assert_eq!(
            resolve_key("src/index.js", "/root.js").as_deref(),
            Some("root.js")
        );
        assert_eq!(resolve_key("index.js", ".").as_deref(), None);
        assert_eq!(resolve_key("a.js", "..").as_deref(), None);
        // Bare specifiers are not this function's job.
        assert_eq!(resolve_key("index.js", "fs"), None);
        assert_eq!(resolve_key("index.js", "lodash"), None);
        assert_eq!(resolve_key("index.js", "node:fs"), None);
    }

    #[test]
    fn resolving_above_the_root_is_an_error() {
        assert_eq!(resolve_key("index.js", "../outside.js"), None);
        assert_eq!(resolve_key("a/b.js", "../../outside.js"), None);
    }
}
