//! `file:` URL conversion.
//!
//! The engine's canonical module names for disk modules are file URLs, because that is what
//! `import.meta.url` must report and what `import()` stores in its module map. Paths therefore
//! round-trip through this module on every import, so the encoding has to be exact: a `#` in a
//! filename must not become a URL fragment, and a `%` must be escaped rather than interpreted.

use std::path::{Path, PathBuf};

/// Characters allowed unescaped in a URL path segment (RFC 3986 `pchar` plus `/`).
fn is_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b':'
                | b'@'
                | b'/'
        )
}

/// Percent-encode a path for use after `file://`.
///
/// Non-ASCII is encoded as UTF-8 bytes, matching WHATWG URL serialization.
pub fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for &byte in path.as_bytes() {
        if is_path_byte(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Decode `%XX` escapes into bytes, rejecting malformed escapes.
fn percent_decode(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(format!("invalid percent escape in '{text}'"));
            }
            let high = hex_value(bytes[index + 1])
                .ok_or_else(|| format!("invalid percent escape in '{text}'"))?;
            let low = hex_value(bytes[index + 2])
                .ok_or_else(|| format!("invalid percent escape in '{text}'"))?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Ok(out)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Convert an absolute path to a `file:` URL.
///
/// The caller is responsible for making the path absolute; a relative path is still encoded
/// (with no leading slash), which is useful for diagnostics but not for module names.
pub fn path_to_file_url(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    let text = text.replace('\\', "/");
    #[cfg(windows)]
    let text = {
        // `C:/x` becomes `/C:/x` so `file://` + text is `file:///C:/x`.
        if text.len() >= 2 && text.as_bytes()[1] == b':' && !text.starts_with('/') {
            format!("/{text}")
        } else {
            text
        }
    };
    #[cfg(not(windows))]
    let text = text.into_owned();
    format!("file://{}", percent_encode_path(&text))
}

/// Convert a `file:` URL to a filesystem path.
///
/// Accepts `file:///path`, `file://localhost/path`, and (on Windows) `file:///C:/path` and UNC
/// hosts. A non-local host on Unix is an error, as in Node.
pub fn file_url_to_path(url: &str) -> Result<PathBuf, String> {
    let rest = url
        .strip_prefix("file://")
        .ok_or_else(|| format!("not a file URL: '{url}'"))?;

    // Split off query and fragment; neither belongs to the path. Node tolerates a hash on
    // fileURLToPath? It ignores search and hash on the URL object, so do the same here.
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);

    let (host, path) = if let Some(path) = rest.strip_prefix('/') {
        ("", format!("/{path}"))
    } else {
        match rest.split_once('/') {
            Some((host, path)) => (host, format!("/{path}")),
            None => (rest, String::from("/")),
        }
    };

    #[cfg(not(windows))]
    if !host.is_empty() && host != "localhost" {
        return Err(format!(
            "file URL host must be 'localhost' or empty on this platform: '{url}'"
        ));
    }

    let decoded = String::from_utf8(percent_decode(&path)?)
        .map_err(|_| format!("file URL path is not valid UTF-8: '{url}'"))?;

    #[cfg(windows)]
    {
        let _ = host;
        let decoded = decoded.strip_prefix('/').unwrap_or(&decoded).to_owned();
        let decoded = decoded.replace('/', "\\");
        return Ok(PathBuf::from(decoded));
    }

    #[cfg(not(windows))]
    {
        if decoded.contains('\0') {
            return Err(format!("file URL path contains a NUL byte: '{url}'"));
        }
        Ok(PathBuf::from(decoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_spaces_and_reserved_characters() {
        assert_eq!(
            path_to_file_url(Path::new("/tmp/a b.js")),
            "file:///tmp/a%20b.js"
        );
        assert_eq!(
            path_to_file_url(Path::new("/tmp/a#b?.js")),
            "file:///tmp/a%23b%3F.js"
        );
        assert_eq!(
            path_to_file_url(Path::new("/tmp/100%.js")),
            "file:///tmp/100%25.js"
        );
    }

    #[test]
    fn encodes_unicode_as_utf8() {
        assert_eq!(
            path_to_file_url(Path::new("/tmp/é.js")),
            "file:///tmp/%C3%A9.js"
        );
    }

    #[test]
    fn round_trips() {
        for path in [
            "/tmp/a b.js",
            "/tmp/a#b?.js",
            "/tmp/100%.js",
            "/tmp/é.js",
            "/tmp/plus+name.js",
            "/",
        ] {
            let url = path_to_file_url(Path::new(path));
            assert_eq!(
                file_url_to_path(&url).expect("decode"),
                PathBuf::from(path),
                "{url}"
            );
        }
    }

    #[test]
    fn accepts_localhost_and_ignores_query_and_fragment() {
        assert_eq!(
            file_url_to_path("file://localhost/tmp/a.js").unwrap(),
            PathBuf::from("/tmp/a.js")
        );
        assert_eq!(
            file_url_to_path("file:///tmp/a.js?x=1#frag").unwrap(),
            PathBuf::from("/tmp/a.js")
        );
    }

    #[test]
    fn rejects_malformed_urls() {
        assert!(file_url_to_path("http://x/y").is_err());
        assert!(file_url_to_path("file://remote/tmp/a.js").is_err());
        assert!(file_url_to_path("file:///tmp/%zz.js").is_err());
    }
}
