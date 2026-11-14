//! Node-shaped rendering of uncaught errors.
//!
//! The engine hands us the raw `name`, `message` and QuickJS stack; the layout is ours. That is
//! deliberate (architecture.md §8): the runtime, not the engine, decides what stderr looks like.
//! M0 emits the location header, the `Error: message` line and the frames. The source excerpt and
//! caret are M2 work.

use std::path::Path;

use ln_engine::CaughtError;

/// Render an uncaught error the way Node's CLI does, minus the source excerpt:
///
/// ```text
/// /path/to/script.js:1
///
/// Error: boom
///     at <anonymous> (/path/to/script.js:1:7)
/// ```
pub fn render_uncaught(error: &CaughtError) -> String {
    let mut out = String::new();
    if let Some((file, line)) = first_location(error.stack.as_deref()) {
        out.push_str(&format!("{}:{line}\n\n", Path::new(&file).display()));
    }
    out.push_str(&error.body());
    out.push('\n');
    out
}

/// Find the throw site in a QuickJS stack: the first frame's `path:line[:column]`.
fn first_location(stack: Option<&str>) -> Option<(String, u64)> {
    for line in stack?.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("at ") else {
            continue;
        };
        // Frames are `at fn (path:line:col)` or `at path:line:col`.
        let location = match rest.rfind('(') {
            Some(open) => rest[open + 1..].trim_end_matches(')').trim(),
            None => rest,
        };
        if let Some(parsed) = split_location(location) {
            return Some(parsed);
        }
    }
    None
}

/// Split `path:line[:column]` into its path and line.
///
/// The numeric suffixes are stripped from the right, so a path may itself contain a colon (a
/// Windows drive letter, or a directory named `foo:1`). `std::path` is then used for the path
/// portion; this keeps the platform's separator and non-UTF-8 rules in one place instead of
/// re-implementing them with string slicing.
fn split_location(location: &str) -> Option<(String, u64)> {
    let (prefix, last) = rsplit_number(location)?;
    let (path, line) = match rsplit_number(prefix) {
        Some((path, line)) => (path, line),
        None => (prefix, last),
    };
    if path.is_empty() {
        return None;
    }
    let path = Path::new(path);
    if path.file_name().is_none() {
        return None;
    }
    Some((path.to_string_lossy().into_owned(), line))
}

/// Split a trailing `:number` off `text`, returning the prefix and the number.
fn rsplit_number(text: &str) -> Option<(&str, u64)> {
    let (prefix, suffix) = text.rsplit_once(':')?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((prefix, suffix.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::split_location;

    #[test]
    fn splits_plain_location() {
        assert_eq!(
            split_location("/tmp/a.js:12:5"),
            Some(("/tmp/a.js".to_owned(), 12))
        );
    }

    #[test]
    fn splits_location_without_column() {
        assert_eq!(
            split_location("/tmp/a.js:12"),
            Some(("/tmp/a.js".to_owned(), 12))
        );
    }

    #[test]
    fn keeps_colons_that_belong_to_the_path() {
        assert_eq!(
            split_location("/tmp/odd:name/a.js:3:1"),
            Some(("/tmp/odd:name/a.js".to_owned(), 3))
        );
    }

    #[test]
    fn rejects_non_locations() {
        assert_eq!(split_location("<anonymous>"), None);
        assert_eq!(split_location(""), None);
    }
}
