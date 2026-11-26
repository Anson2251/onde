//! The source scan that makes "I/O only happens in a declared chokepoint" a test.
//!
//! ADR-0011 §7: a JS reflection test cannot see `load_json_module`'s old `fs::read_to_string` or
//! SQLite's `sqlite3_load_extension`; this scan can. Every hit must be in a function on the
//! allow-list below, with a reason. Test modules are excluded (they are at the end of their files
//! by convention), so exercising the filesystem in a test does not need an entry.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// The crates whose I/O the policy is supposed to own.
const ROOTS: &[&str] = &[
    "crates/ln-runtime/src",
    "crates/ln-io/src",
    "crates/ln-sqlite/src",
    "crates/ln-modules/src",
];

/// One substring per I/O primitive the scan treats as a chokepoint. Substring rather than token so
/// `TokioCommand::new` matches `Command::new`.
const NEEDLES: &[&str] = &[
    "fs::read(",
    "fs::read_to_string(",
    "fs::write(",
    "fs::read_dir(",
    "fs::read_link(",
    "fs::metadata(",
    "fs::symlink_metadata(",
    "fs::rename(",
    "fs::remove_file(",
    "fs::remove_dir_all(",
    "fs::create_dir(",
    "fs::set_permissions(",
    "fs::copy(",
    "fs::canonicalize(",
    "File::open(",
    "File::create(",
    "OpenOptions::new(",
    "libc::open(",
    "libc::socket(",
    "Socket::new(",
    "TcpListener::bind(",
    "UnixListener::bind(",
    "lookup_host(",
    "Command::new(",
    "libc::kill(",
    "sqlite3_load_extension(",
    "libc::openat(",
    "libc::dlopen(",
    "execve(",
    "TcpSocket::new_v4(",
    "TcpSocket::new_v6(",
    "File::options(",
    "Connection::open(",
    "Connection::open_with_flags(",
];

/// Functions allowed to touch a primitive. The reason is read by reviewers, not by the test.
const ALLOW: &[(&str, &str, &str)] = &[
    // ln-io: the op executor and the gate's own resolution. Every one of these is reached from
    // `Op::execute` after `Permit::resolve_op` (ADR-0011 §5.4 row 1) or is the resolution itself.
    (
        "crates/ln-io/src/lib.rs",
        "open_path",
        "the only open(2) call, used by the gated helpers",
    ),
    ("crates/ln-io/src/lib.rs", "readdir", "Op::Readdir"),
    ("crates/ln-io/src/lib.rs", "remove_path", "Op::Rm"),
    ("crates/ln-io/src/lib.rs", "unlink", "Op::Unlink"),
    ("crates/ln-io/src/lib.rs", "rename", "Op::Rename"),
    ("crates/ln-io/src/lib.rs", "stat", "Op::Stat"),
    ("crates/ln-io/src/lib.rs", "readlink", "Op::Readlink"),
    ("crates/ln-io/src/lib.rs", "realpath", "Op::Realpath"),
    ("crates/ln-io/src/lib.rs", "copy_file", "Op::CopyFile"),
    ("crates/ln-io/src/lib.rs", "mkdir_recursive", "Op::Mkdir"),
    (
        "crates/ln-io/src/perm.rs",
        "resolve_read",
        "the gate's resolution (read class)",
    ),
    (
        "crates/ln-io/src/perm.rs",
        "resolve_link",
        "the gate's resolution (lstat class)",
    ),
    (
        "crates/ln-io/src/perm.rs",
        "resolve_create",
        "the gate's resolution (create class)",
    ),
    // Network tasks: each candidate is filtered by `allowed_endpoints` before it is used.
    (
        "crates/ln-io/src/net/connection.rs",
        "resolve_connect",
        "filtered after resolution",
    ),
    (
        "crates/ln-io/src/net/connection.rs",
        "local_endpoint",
        "bind for an allowed candidate",
    ),
    (
        "crates/ln-io/src/net/listener.rs",
        "bind",
        "filtered by the listener check",
    ),
    (
        "crates/ln-io/src/net/listener.rs",
        "listen_addresses",
        "filtered after resolution",
    ),
    (
        "crates/ln-io/src/net/listener.rs",
        "bind_tcp_socket",
        "one allowed candidate",
    ),
    // Child processes: the program is resolved and checked before the task starts.
    (
        "crates/ln-io/src/proc.rs",
        "resolve_program",
        "resolves the executable before the grant check",
    ),
    (
        "crates/ln-io/src/proc.rs",
        "run",
        "spawns the resolved, already-checked program",
    ),
    (
        "crates/ln-io/src/proc.rs",
        "send_signal",
        "child.kill, implied by the spawn grant",
    ),
    // Resolution metadata: package.json and path canonicalisation during resolution.
    (
        "crates/ln-modules/src/package.rs",
        "load",
        "package.json is resolution metadata (exempt)",
    ),
    (
        "crates/ln-modules/src/resolve.rs",
        "canonicalize",
        "resolution metadata (exempt)",
    ),
    // ln-runtime: enumerated plumbing and small integer materialisations.
    (
        "crates/ln-runtime/src/host/mod.rs",
        "rss_bytes",
        "reads /proc/self/statm for memoryUsage",
    ),
    (
        "crates/ln-runtime/src/host/signal.rs",
        "install",
        "process.kill gate (child.spawn)",
    ),
    (
        "crates/ln-runtime/src/host/sqlite.rs",
        "check_open",
        "sqlite open gate and side-file refusal",
    ),
    (
        "crates/ln-runtime/src/modules.rs",
        "read_class",
        "the one read chokepoint (Source/Data)",
    ),
    (
        "crates/ln-runtime/src/report.rs",
        "render_uncaught_with_offset",
        "diagnostic code frame",
    ),
    (
        "crates/ln-runtime/src/trace.rs",
        "create",
        "diagnostic trace file",
    ),
    // ln-sqlite: the callbacks behind the gated host.sqlite primitives.
    (
        "crates/ln-sqlite/src/database.rs",
        "load_extension",
        "reached only from the gated ffi.load primitives",
    ),
    (
        "crates/ln-io/src/net/connection.rs",
        "connect_one",
        "socket for an allowed candidate",
    ),
    (
        "crates/ln-sqlite/src/database.rs",
        "open",
        "reached only from the gated host.sqlite open",
    ),
    (
        "crates/ln-sqlite/src/backup.rs",
        "start",
        "reached only from the gated host.sqlite backupInit",
    ),
];

struct Hit {
    file: String,
    line: usize,
    function: String,
    needle: &'static str,
}

#[test]
fn io_primitives_live_only_in_declared_chokepoints() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest.parent().expect("crates").parent().expect("repo");
    let mut files = Vec::new();
    for root in ROOTS {
        walk(&repo.join(root), &mut files);
    }
    files.sort();

    let mut hits = Vec::new();
    for file in &files {
        scan_file(file, &mut hits);
    }

    let mut used: HashSet<(String, String)> = HashSet::new();
    let mut failures = Vec::new();
    for hit in &hits {
        if let Some((_, _, reason)) = ALLOW
            .iter()
            .find(|(file, function, _)| *file == hit.file && *function == hit.function)
        {
            used.insert((hit.file.clone(), hit.function.clone()));
            let _ = reason;
        } else {
            failures.push(format!(
                "{}:{}: {} (in `{}`)",
                hit.file, hit.line, hit.needle, hit.function
            ));
        }
    }
    for (file, function, _) in ALLOW {
        if !used.contains(&((*file).to_owned(), (*function).to_owned())) {
            failures.push(format!("stale allow-list entry: {file}:{function}"));
        }
    }
    failures.sort();
    assert!(
        failures.is_empty(),
        "\nI/O outside a declared chokepoint ({} hit(s)); add the function to ALLOW only when it\n\
         is a gate or an enumerated exemption:\n  {}\n",
        failures.len(),
        failures.join("\n  ")
    );
}

fn walk(directory: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, files);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}

fn scan_file(path: &Path, hits: &mut Vec<Hit>) {
    let file = path.display().to_string();
    let file = file
        .split("/crates/")
        .nth(1)
        .map(|rest| format!("crates/{rest}"))
        .unwrap_or(file);
    let text = fs::read_to_string(path).expect("read source");
    // Test modules live at the end of the file in this tree; stop before the first one.
    let end = text
        .find("#[cfg(test)]")
        .or_else(|| text.find("#[cfg(all(test"))
        .unwrap_or(text.len());
    let text = &text[..end];

    let lines: Vec<&str> = text.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let code = line.split("//").next().unwrap_or("");
        for needle in NEEDLES {
            if !code.contains(needle) {
                continue;
            }
            hits.push(Hit {
                file: file.clone(),
                line: index + 1,
                function: enclosing_function(&lines, index),
                needle,
            });
        }
    }
}

/// The nearest `fn` above the hit. This is deliberately textual: the allow-list is a review aid,
/// not a parser, and an unusual rustfmt layout only makes the test more conservative.
fn enclosing_function(lines: &[&str], index: usize) -> String {
    for line in lines[..=index].iter().rev() {
        let trimmed = line.trim_start();
        let rest = if let Some(rest) = trimmed.strip_prefix("pub(crate) ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("pub(super) ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("pub ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("async ") {
            rest
        } else {
            trimmed
        };
        if let Some(rest) = rest.strip_prefix("fn ") {
            let name: String = rest
                .chars()
                .take_while(|character| character.is_alphanumeric() || *character == '_')
                .collect();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "<top level>".to_owned()
}
