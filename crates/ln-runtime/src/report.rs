//! Uncaught-error rendering.
//!
//! The layout is ours, not the engine's: QuickJS formats frames but has no notion of a
//! "failing source line", and Node's header (`file:line`, source, caret) is what makes a CLI
//! error readable. Kept in one function so M1/M2 can extend it (error codes, causes, async
//! frames) without touching the runtime.
//!
//! Location parsing uses [`std::path::Path`] for the path portion; only the `:line:column`
//! suffix is split here, from the right, so a path may itself contain a colon (a Windows drive
//! letter, or a directory named `foo:1`).

use std::path::{Path, PathBuf};

use ln_engine::CaughtError;

/// Render an uncaught error the way `onde` prints it:
///
/// ```text
/// /tmp/app.js:2
///   throw new Error("boom");
///   ^
///
/// Error: boom
///     at <eval> (/tmp/app.js:2:9)
/// ```
///
/// The location header and source excerpt are best-effort: if the stack cannot be parsed, only
/// the error body is printed.
pub fn render_uncaught(error: &CaughtError, filename: &str, source: &str) -> String {
    render_uncaught_with_offset(error, filename, source, 0)
}

/// Like [`render_uncaught`], but subtract `first_line_offset` from a line-1 caret column.
///
/// The CommonJS wrapper prepends `(function (exports, require, module, __filename, __dirname) { `
/// to the body without a newline, so the engine reports line-1 columns shifted by that prefix.
/// Node compensates the same way. Lines after the first are unaffected.
pub fn render_uncaught_with_offset(
    error: &CaughtError,
    filename: &str,
    source: &str,
    first_line_offset: usize,
) -> String {
    let mut out = String::new();

    // A syntax error never ran the file that failed: the frame points at the parse site, which
    // for a dependency is not the entry. Runtime errors keep preferring the entry frame (that is
    // where the user's program failed from the caller's point of view).
    let syntax = error.name == "SyntaxError";
    let location = if syntax {
        first_any_location(error)
    } else {
        first_location(error, filename)
    };

    if let Some(mut location) = location {
        let (display_file, display_source) = if location.file != Path::new(filename) {
            match std::fs::read_to_string(&location.file) {
                Ok(text) if text.len() <= 4 * 1024 * 1024 => {
                    (location.file.display().to_string(), text)
                }
                _ => (filename.to_owned(), source.to_owned()),
            }
        } else {
            (filename.to_owned(), source.to_owned())
        };

        if location.line == 1 {
            let line_length = display_source
                .lines()
                .next()
                .map(|line| line.chars().count())
                .unwrap_or(0);
            let offset = if location.file == Path::new(filename) {
                first_line_offset
            } else if syntax && location.column > line_length + 1 {
                // The module was compiled through the CJS wrapper, so its line-1 column carries
                // the wrapper prefix. ESM line-1 columns are within the line.
                ln_engine::cjs_wrapper_column_offset()
            } else {
                0
            };
            location.column = location.column.saturating_sub(offset).max(1);
        }

        out.push_str(&format!("{display_file}:{}\n", location.line));
        if let Some(text) = display_source.lines().nth(location.line.saturating_sub(1)) {
            let text = text.trim_end();
            out.push_str(text);
            out.push('\n');
            // Column is 1-based. Padding only: never slice the source (JS columns are UTF-16).
            // Cap the padding: `error.stack` is user-writable, and a bogus column must not turn
            // into a huge allocation.
            const MAX_CARET_PADDING: usize = 200;
            out.push_str(&" ".repeat(location.column.saturating_sub(1).min(MAX_CARET_PADDING)));
            out.push_str("^\n\n");
        }
    }

    out.push_str(&error.body());
    out
}

/// A parsed stack-frame location.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Location {
    file: PathBuf,
    line: usize,
    column: usize,
}

/// The first parseable frame, regardless of file. Used for syntax errors.
fn first_any_location(error: &CaughtError) -> Option<Location> {
    let stack = error.stack.as_deref()?;
    stack.lines().find_map(frame_location)
}

/// Find the first stack frame that names `filename`, falling back to the first parseable frame.
fn first_location(error: &CaughtError, filename: &str) -> Option<Location> {
    let stack = error.stack.as_deref()?;
    let wanted = Path::new(filename);
    let mut fallback = None;

    for line in stack.lines() {
        let Some(location) = frame_location(line) else {
            continue;
        };

        if location.file == wanted || location.file.file_name() == wanted.file_name() {
            return Some(location);
        }
        fallback.get_or_insert(location);
    }

    fallback
}

/// Parse one stack-frame line into a [`Location`].
fn frame_location(line: &str) -> Option<Location> {
    // QuickJS frames look like `    at <eval> (/tmp/app.js:2:9)`.
    let candidate = line
        .find('(')
        .and_then(|open| line[open + 1..].strip_suffix(')'))
        .or_else(|| line.trim_start().strip_prefix("at "))?;
    parse_location(candidate)
}

/// Parse `path:line:column`, tolerating a `file://` prefix.
fn parse_location(text: &str) -> Option<Location> {
    let text = text.strip_prefix("file://").unwrap_or(text);
    let (rest, column) = split_trailing_number(text)?;
    let (file, line) = split_trailing_number(rest)?;
    if file.is_empty() {
        return None;
    }

    // `std::path` decides what a path is; we only require that it names something.
    let file = Path::new(file);
    file.file_name()?;

    Some(Location {
        file: file.to_path_buf(),
        line,
        column,
    })
}

/// Split a trailing `:number` off `text`, returning the prefix and the number.
fn split_trailing_number(text: &str) -> Option<(&str, usize)> {
    let (prefix, suffix) = text.rsplit_once(':')?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((prefix, suffix.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_with_stack(stack: &str) -> CaughtError {
        CaughtError {
            name: "Error".to_string(),
            message: "boom".to_string(),
            stack: Some(stack.to_string()),
            display: "Error: boom".to_string(),
            is_error: true,
            code: None,
        }
    }

    #[test]
    fn parses_quickjs_frames() {
        let location = parse_location("/tmp/a.js:2:9").expect("parse");
        assert_eq!(location.file, Path::new("/tmp/a.js"));
        assert_eq!((location.line, location.column), (2, 9));

        let location = parse_location("file:///tmp/a.js:12:1").expect("parse");
        assert_eq!(location.file, Path::new("/tmp/a.js"));
        assert_eq!((location.line, location.column), (12, 1));

        assert_eq!(parse_location("no-location"), None);
    }

    #[test]
    fn keeps_colons_that_belong_to_the_path() {
        let location = parse_location("/tmp/odd:name/a.js:3:4").expect("parse");
        assert_eq!(location.file, Path::new("/tmp/odd:name/a.js"));
        assert_eq!((location.line, location.column), (3, 4));
    }

    #[test]
    fn renders_header_source_and_caret() {
        let error =
            error_with_stack("    at <eval> (/tmp/a.js:2:9)\n    at <eval> (/tmp/a.js:1:1)");
        let rendered = render_uncaught(
            &error,
            "/tmp/a.js",
            "const a = 1;\n  throw new Error('boom');\n",
        );

        assert!(rendered.starts_with("/tmp/a.js:2\n"));
        assert!(rendered.contains("  throw new Error('boom');\n"));
        assert!(rendered.contains("        ^"));
        assert!(rendered.contains("Error: boom"));
        assert!(rendered.contains("at <eval> (/tmp/a.js:2:9)"));
    }

    #[test]
    fn prefers_the_entry_frame() {
        let error =
            error_with_stack("    at helper (/tmp/lib.js:7:3)\n    at <eval> (/tmp/a.js:4:2)");
        let rendered = render_uncaught(&error, "/tmp/a.js", "1\n2\n3\n4\n");
        assert!(rendered.starts_with("/tmp/a.js:4\n"));
    }

    #[test]
    fn syntax_errors_point_at_the_failing_module() {
        let dir = std::env::temp_dir().join(format!("onde-report-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let bad = dir.join("bad.js");
        std::fs::write(&bad, "const x = ;\n").expect("write");

        let mut error = error_with_stack(&format!("    at {}:1:73", bad.display()));
        error.name = "SyntaxError".to_owned();
        let rendered = render_uncaught(&error, "/tmp/entry.js", "require('./bad.js');\n");

        assert!(
            rendered.starts_with(&format!("{}:1\n", bad.display())),
            "{rendered}"
        );
        assert!(rendered.contains("const x = ;"), "{rendered}");
        assert!(rendered.contains("\n          ^"), "{rendered}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn degrades_without_a_stack() {
        let mut error = error_with_stack("");
        error.stack = None;
        let rendered = render_uncaught(&error, "/tmp/a.js", "throw 1;\n");
        assert_eq!(rendered, "Error: boom");
    }
}
