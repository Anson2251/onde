//! The builtin module table.
//!
//! A name is a builtin when it appears here with or without the `node:` prefix. Builtins always
//! win over a `node_modules` directory entry of the same name, which is why resolution checks
//! this table before touching the filesystem (Node does the same).
//!
//! The table is deliberately explicit instead of derived from the embedded sources: a module
//! exists for users only if it is listed in `docs/compat.md`, and this list is the machine-checked
//! copy of that decision.

/// Canonical builtin names (without the `node:` prefix), sorted.
pub const BUILTINS: &[&str] = &[
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "console",
    "constants",
    "crypto",
    "dns",
    "events",
    "fs",
    "fs/promises",
    "http",
    "https",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "sqlite",
    "stream",
    "stream/promises",
    "string_decoder",
    "test",
    "tls",
    "tty",
    "url",
    "util",
    "worker_threads",
    "zlib",
];

/// Builtins that exist only under the `node:` scheme, as in Node.
///
/// `require("sqlite")` must fall through to `node_modules` and end as `MODULE_NOT_FOUND`;
/// `module.builtinModules` must not list these names. The loader applies the same rule for
/// `module.isBuiltin`, using `__ln_host.nodeOnlyBuiltins()`.
pub const NODE_ONLY: &[&str] = &["sqlite"];

/// Resolve a specifier to a canonical builtin name.
///
/// Accepts both `path` and `node:path`; returns `None` for anything else, including unknown
/// `node:` names (the caller turns that into `ERR_UNKNOWN_BUILTIN_MODULE`) and a bare name that
/// is only reachable with the prefix.
pub fn lookup(specifier: &str) -> Option<&'static str> {
    let (name, prefixed) = match specifier.strip_prefix("node:") {
        Some(name) => (name, true),
        None => (specifier, false),
    };
    let builtin = BUILTINS.iter().copied().find(|builtin| *builtin == name)?;
    if !prefixed && NODE_ONLY.contains(&builtin) {
        return None;
    }
    Some(builtin)
}

/// True when the specifier is explicitly prefixed with `node:`.
pub fn is_node_prefixed(specifier: &str) -> bool {
    specifier.starts_with("node:")
}

/// The canonical name of a `node:`-prefixed specifier, even when it is not a known builtin.
///
/// Used only to produce a better error message (`ERR_UNKNOWN_BUILTIN_MODULE` instead of
/// `ERR_MODULE_NOT_FOUND`) for `node:not-a-real-module`.
pub fn strip_prefix(specifier: &str) -> Option<&str> {
    specifier.strip_prefix("node:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_forms_resolve() {
        assert_eq!(lookup("path"), Some("path"));
        assert_eq!(lookup("node:path"), Some("path"));
        assert_eq!(lookup("node:path/win32"), Some("path/win32"));
    }

    #[test]
    fn unknown_names_do_not_resolve() {
        assert_eq!(lookup("node:not-a-module"), None);
        assert_eq!(lookup("not-a-module"), None);
        // A prefix match is not a match.
        assert_eq!(lookup("pathish"), None);
    }

    #[test]
    fn node_only_names_require_the_prefix() {
        assert_eq!(lookup("sqlite"), None);
        assert_eq!(lookup("node:sqlite"), Some("sqlite"));
        assert_eq!(lookup("node:zlib"), Some("zlib"));
        assert_eq!(lookup("zlib"), Some("zlib"));
    }

    #[test]
    fn table_is_sorted_and_unique() {
        let mut sorted = BUILTINS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, BUILTINS.to_vec());
    }
}
