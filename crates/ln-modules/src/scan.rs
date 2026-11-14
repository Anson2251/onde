//! Static scan for CommonJS named exports.
//!
//! ESM importing CJS needs a static list of names: `import { sort } from "lodash"` must fail at
//! link time when `sort` does not exist, and a namespace import should contain the same names
//! Node provides. Node solves this with `cjs-module-lexer`; lite uses a small scanner with the
//! same contract but a much smaller input language:
//!
//! Detected:
//! - `exports.name = ...` and `module.exports.name = ...`
//! - `exports["name"] = ...` and `module.exports["name"] = ...`
//! - `Object.defineProperty(exports, "name", ...)` (and `module.exports`)
//! - `module.exports = { name, name: value, "name": value }` top-level keys
//!
//! Not detected (documented heuristic, see `docs/compat.md` D17): names created by a loop,
//! `Object.assign(exports, ...)`, re-exports (`module.exports = require("./x")`), and names
//! defined through a variable alias of `exports`. Those still work through the `default` export.
//!
//! The scanner ignores comments and string literals outside the patterns it recognises, so a
//! comment mentioning `exports.foo` does not invent an export. It is deliberately not a parser:
//! its output is only used to generate `export const name = ns.name` lines, and a false positive
//! is cheap to detect (the value is `undefined`) while a parser would double the module system's
//! code size.

use std::collections::BTreeSet;

/// Keywords that cannot appear in `export const <name> = ...`.
const RESERVED: &[&str] = &[
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "null",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
];

/// Names that are exported but never generate a named binding in the ESM facade.
const SKIPPED: &[&str] = &["__esModule", "default", "module", "exports", "require"];

/// Scan `source` for statically known CommonJS export names.
///
/// The result is sorted and de-duplicated, so generated module sources are deterministic.
pub fn scan_named_exports(source: &str) -> Vec<String> {
    let mut found = BTreeSet::new();
    scan_bytes(source.as_bytes(), &mut found);

    found
        .into_iter()
        .filter(|name| is_valid_identifier(name) && !RESERVED.contains(&name.as_str()))
        .filter(|name| !SKIPPED.contains(&name.as_str()))
        .collect()
}

fn scan_bytes(bytes: &[u8], found: &mut BTreeSet<String>) {
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index);
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index);
                continue;
            }
            b'\'' | b'"' | b'`' => {
                index = skip_string(bytes, index);
                continue;
            }
            _ => {}
        }

        if starts_with(bytes, index, b"Object.defineProperty") {
            if let Some((name, next)) = parse_define_property(bytes, index) {
                found.insert(name);
                index = next;
                continue;
            }
        }

        if starts_with(bytes, index, b"module.exports") {
            let after = index + "module.exports".len();
            if let Some((name, next)) = parse_property(bytes, after) {
                found.insert(name);
                index = next;
                continue;
            }
            if let Some((names, next)) = parse_object_literal_assignment(bytes, after) {
                found.extend(names);
                index = next;
                continue;
            }
        }

        if starts_with(bytes, index, b"exports") {
            let after = index + "exports".len();
            if let Some((name, next)) = parse_property(bytes, after) {
                found.insert(name);
                index = next;
                continue;
            }
            if let Some((names, next)) = parse_object_literal_assignment(bytes, after) {
                found.extend(names);
                index = next;
                continue;
            }
        }

        index += 1;
    }
}

/// Parse `.name` or `["name"]` followed by a single `=`.
fn parse_property(bytes: &[u8], mut index: usize) -> Option<(String, usize)> {
    index = skip_whitespace(bytes, index);
    match bytes.get(index)? {
        b'.' => {
            let start = index + 1;
            let end = ident_end(bytes, start)?;
            if end == start {
                return None;
            }
            let name = std::str::from_utf8(&bytes[start..end]).ok()?.to_owned();
            let after = skip_whitespace(bytes, end);
            if !is_assignment(bytes, after) {
                return None;
            }
            Some((name, after + 1))
        }
        b'[' => {
            let start = index + 1;
            let (name, after_string) = parse_string_literal(bytes, skip_whitespace(bytes, start))?;
            let after = skip_whitespace(bytes, after_string);
            if bytes.get(after) != Some(&b']') {
                return None;
            }
            let after = skip_whitespace(bytes, after + 1);
            if !is_assignment(bytes, after) {
                return None;
            }
            Some((name, after + 1))
        }
        _ => None,
    }
}

/// `module.exports = { ... }` / `exports = { ... }`.
fn parse_object_literal_assignment(bytes: &[u8], index: usize) -> Option<(Vec<String>, usize)> {
    let index = skip_whitespace(bytes, index);
    if !is_assignment(bytes, index) {
        return None;
    }
    let index = skip_whitespace(bytes, index + 1);
    if bytes.get(index) != Some(&b'{') {
        return None;
    }
    let (names, end) = parse_object_literal(bytes, index)?;
    Some((names, end))
}

/// `Object.defineProperty(exports | module.exports, "name", ...)`.
fn parse_define_property(bytes: &[u8], index: usize) -> Option<(String, usize)> {
    let mut cursor = skip_whitespace(bytes, index + "Object.defineProperty".len());
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    cursor = skip_whitespace(bytes, cursor + 1);
    if starts_with(bytes, cursor, b"module.exports") {
        cursor += "module.exports".len();
    } else if starts_with(bytes, cursor, b"exports") {
        cursor += "exports".len();
    } else {
        return None;
    }
    cursor = skip_whitespace(bytes, cursor);
    if bytes.get(cursor) != Some(&b',') {
        return None;
    }
    cursor = skip_whitespace(bytes, cursor + 1);
    let (name, after) = parse_string_literal(bytes, cursor)?;
    let cursor = skip_whitespace(bytes, after);
    if bytes.get(cursor) != Some(&b',') {
        return None;
    }
    Some((name, cursor + 1))
}

/// Parse the top-level keys of an object literal starting at `{`.
///
/// Only depth-1 keys are returned: nested objects belong to the value of a key, not to the
/// exports. Spreads and computed keys are skipped because they cannot be known statically.
fn parse_object_literal(bytes: &[u8], start: usize) -> Option<(Vec<String>, usize)> {
    debug_assert_eq!(bytes.get(start), Some(&b'{'));
    let mut names = Vec::new();
    let mut depth = 0usize;
    let mut index = start;
    let mut expecting_key = true;

    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                depth += 1;
                index += 1;
                if depth == 1 {
                    expecting_key = true;
                }
                continue;
            }
            b'}' => {
                depth -= 1;
                index += 1;
                if depth == 0 {
                    return Some((names, index));
                }
                continue;
            }
            b',' if depth == 1 => {
                expecting_key = true;
                index += 1;
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index);
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index);
                continue;
            }
            b'\'' | b'"' | b'`' if depth == 1 && expecting_key => {
                let (name, after) = parse_string_literal(bytes, index)?;
                let after_ws = skip_whitespace(bytes, after);
                // A quoted key is a property only when followed by `:` (or `,`/`}` shorthand,
                // which is invalid for strings).
                if bytes.get(after_ws) == Some(&b':') {
                    names.push(name);
                }
                expecting_key = false;
                index = after;
                continue;
            }
            b'.' if depth == 1
                && expecting_key
                && bytes.get(index + 1) == Some(&b'.')
                && bytes.get(index + 2) == Some(&b'.') =>
            {
                // `...base`: the spread name is not a property key. Skip the whole expression;
                // leaving `index` on the comma keeps the main loop's key state consistent.
                index = skip_spread_expression(bytes, index);
                expecting_key = false;
                continue;
            }
            b'[' if depth == 1 && expecting_key => {
                // `[computed]: value` cannot be named statically; skip the computed key and the
                // value it introduces.
                index = skip_bracketed(bytes, index);
                expecting_key = false;
                continue;
            }
            _ if depth == 1 && expecting_key && is_ident_start(bytes[index]) => {
                let end = ident_end(bytes, index).unwrap_or(index);
                if end == index {
                    index += 1;
                    continue;
                }
                let name = String::from_utf8_lossy(&bytes[index..end]).into_owned();
                let after = skip_whitespace(bytes, end);
                match bytes.get(after) {
                    // `{ name: value }` and `{ name }` shorthand
                    Some(b':') | Some(b',') | Some(b'}') => names.push(name),
                    // `{ name(...) {} }` method shorthand
                    Some(b'(') => names.push(name),
                    _ => {}
                }
                expecting_key = false;
                index = end;
                continue;
            }
            _ => {
                index += 1;
            }
        }
    }
    None
}

fn parse_string_literal(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let quote = *bytes.get(start)?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let mut out = String::new();
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                let escaped = *bytes.get(index + 1)?;
                let ch = match escaped {
                    b'n' => '\n',
                    b't' => '\t',
                    b'r' => '\r',
                    other => other as char,
                };
                out.push(ch);
                index += 2;
            }
            byte if byte == quote => {
                return Some((out, index + 1));
            }
            byte => {
                out.push(byte as char);
                index += 1;
            }
        }
    }
    None
}

fn skip_string(bytes: &[u8], start: usize) -> usize {
    let quote = bytes[start];
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            byte if byte == quote => return index + 1,
            _ => index += 1,
        }
    }
    index
}

fn skip_line_comment(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len() && bytes[index] != b'\n' {
        index += 1;
    }
    index
}

/// Skip `...expr` up to (not including) the next `,` or `}` at the current nesting level.
fn skip_spread_expression(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 3;
    let mut depth = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            b'}' => {
                if depth == 0 {
                    return index;
                }
                depth -= 1;
            }
            b',' if depth == 0 => return index,
            b'\'' | b'"' | b'`' => {
                index = skip_string(bytes, index);
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = skip_line_comment(bytes, index);
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index);
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    index
}

/// Skip a balanced `[...]` expression starting at `start`, returning the index after `]`.
fn skip_bracketed(bytes: &[u8], start: usize) -> usize {
    debug_assert_eq!(bytes.get(start), Some(&b'['));
    let mut index = start + 1;
    let mut depth = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return index + 1;
                }
            }
            b'\'' | b'"' | b'`' => {
                index = skip_string(bytes, index);
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    index
}

fn skip_block_comment(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 2;
    while index + 1 < bytes.len() {
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            return index + 2;
        }
        index += 1;
    }
    bytes.len()
}

fn skip_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

/// A single `=` that is not `==`, `=>`, or part of a longer operator.
fn is_assignment(bytes: &[u8], index: usize) -> bool {
    if bytes.get(index) != Some(&b'=') {
        return false;
    }
    !matches!(bytes.get(index + 1), Some(b'=') | Some(b'>'))
}

fn starts_with(bytes: &[u8], index: usize, prefix: &[u8]) -> bool {
    bytes.len() >= index + prefix.len() && &bytes[index..index + prefix.len()] == prefix
}

fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn is_ident_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn ident_end(bytes: &[u8], start: usize) -> Option<usize> {
    if !bytes
        .get(start)
        .map(|byte| is_ident_start(*byte))
        .unwrap_or(false)
    {
        return Some(start);
    }
    let mut index = start + 1;
    while bytes
        .get(index)
        .map(|byte| is_ident_continue(*byte))
        .unwrap_or(false)
    {
        index += 1;
    }
    Some(index)
}

fn is_valid_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(source: &str) -> Vec<String> {
        scan_named_exports(source)
    }

    #[test]
    fn finds_dotted_assignments() {
        assert_eq!(names("exports.foo = 1;"), ["foo"]);
        assert_eq!(names("module.exports.bar = 2;"), ["bar"]);
        assert_eq!(names("exports.foo = exports.baz = 3;"), ["baz", "foo"]);
    }

    #[test]
    fn finds_bracket_assignments() {
        assert_eq!(names("exports['qux'] = 1;"), ["qux"]);
        // A key that cannot be a binding is left to the default export.
        assert_eq!(names("exports['a-b'] = 1;"), Vec::<String>::new());
        assert_eq!(names("module.exports[\"qux\"] = 2;"), ["qux"]);
    }

    #[test]
    fn finds_define_property() {
        assert_eq!(
            names("Object.defineProperty(exports, \"alpha\", { get: () => 1 });"),
            ["alpha"]
        );
        assert_eq!(
            names("Object.defineProperty(module.exports, 'beta', { value: 2 });"),
            ["beta"]
        );
    }

    #[test]
    fn finds_object_literal_keys() {
        assert_eq!(
            names("module.exports = { alpha, beta: 2, 'gamma': 3 };"),
            ["alpha", "beta", "gamma"]
        );
        assert_eq!(
            names("module.exports = {\n  alpha: 1,\n  nested: { hidden: 1 },\n};"),
            ["alpha", "nested"]
        );
        assert_eq!(
            names("module.exports = { method() { return 1; } };"),
            ["method"]
        );
    }

    #[test]
    fn ignores_comments_and_strings() {
        assert_eq!(
            names("// exports.commented = 1\n/* module.exports.other = 2 */\nconst s = 'exports.str = 3';"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn ignores_comparisons_and_arrows() {
        assert_eq!(names("if (exports.foo == 1) {}"), Vec::<String>::new());
        assert_eq!(names("const f = exports.foo => 1;"), Vec::<String>::new());
    }

    #[test]
    fn filters_reserved_and_helpers() {
        assert_eq!(
            names("exports.default = 1; exports.__esModule = true; exports.class = 1; exports.ok = 1;"),
            ["ok"]
        );
    }

    #[test]
    fn handles_no_exports() {
        assert_eq!(
            names("const x = 1; module.exports = function () {};"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn object_literal_survives_nested_braces_and_strings() {
        let source = r#"
            module.exports = {
                one: { two: 2, three: { four: 4 } },
                five: function () { return { six: 6 }; },
                "seven": 7,
            };
        "#;
        assert_eq!(names(source), ["five", "one", "seven"]);
    }

    #[test]
    fn spread_and_computed_keys_are_skipped_without_panicking() {
        let source = "module.exports = { ...base, [key]: 1, after: 2 };";
        assert_eq!(names(source), ["after"]);
    }

    #[test]
    fn unicode_identifiers_are_not_exported() {
        // The generated facade must be valid JS; non-ASCII identifiers are rare enough to leave
        // to the default export.
        assert_eq!(names("exports.é = 1; exports.ascii = 2;"), ["ascii"]);
    }
}
