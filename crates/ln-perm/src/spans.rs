//! The capability-key line index.
//!
//! Denial messages name the line of the capability's key in the policy file (ADR-0011 §5.7), which
//! `serde_json` does not expose. This is a small scan over the comment-stripped text; it is not a
//! second parser, it never rejects anything, and if it loses the structure it simply reports no
//! line rather than failing a policy `serde_json` accepted.

use crate::capability::Capability;

/// One object or array in the scan.
///
/// An object carries the JSON path it sits at, so a key's full path is `path + key`. An array
/// carries the path as well, for the (unused by the grammar) case of an object inside an array.
enum Frame {
    Object {
        path: Vec<String>,
        pending_key: Option<String>,
    },
    Array {
        path: Vec<String>,
    },
}

/// The line of each capability's key, `None` when the key is absent or the scan lost it.
pub(crate) fn capability_lines(text: &str) -> [Option<u32>; Capability::COUNT] {
    let mut lines = [None; Capability::COUNT];
    let bytes = text.as_bytes();
    let mut index = 0;
    let mut line = 1u32;
    let mut frames: Vec<Frame> = Vec::new();
    let mut last_string: Option<(String, u32)> = None;

    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                line += 1;
                index += 1;
            }
            b' ' | b'\t' | b'\r' => index += 1,
            b'"' => {
                let (value, next, start_line) = read_string(bytes, index, &mut line);
                last_string = Some((value, start_line));
                index = next;
            }
            b':' => {
                if let Some((key, key_line)) = last_string.take() {
                    if let Some(Frame::Object { path, pending_key }) = frames.last_mut() {
                        let mut full = path.clone();
                        full.push(key.clone());
                        if let Some(capability) = capability_for_path(&full) {
                            lines[capability.index()] = Some(key_line);
                        }
                        *pending_key = Some(key);
                    }
                }
                index += 1;
            }
            b'{' => {
                let path = child_path(&frames);
                frames.push(Frame::Object {
                    path,
                    pending_key: None,
                });
                last_string = None;
                index += 1;
            }
            b'[' => {
                let path = child_path(&frames);
                frames.push(Frame::Array { path });
                last_string = None;
                index += 1;
            }
            b'}' | b']' => {
                frames.pop();
                last_string = None;
                index += 1;
            }
            b',' => {
                last_string = None;
                if let Some(Frame::Object { pending_key, .. }) = frames.last_mut() {
                    *pending_key = None;
                }
                index += 1;
            }
            _ => {
                last_string = None;
                index += 1;
            }
        }
    }

    lines
}

/// The path a container entered now would sit at: the parent object's pending key, if the container
/// is that key's value, otherwise the parent's own path.
fn child_path(frames: &[Frame]) -> Vec<String> {
    match frames.last() {
        Some(Frame::Object {
            path,
            pending_key: Some(key),
        }) => {
            let mut child = path.clone();
            child.push(key.clone());
            child
        }
        Some(Frame::Object { path, .. }) | Some(Frame::Array { path }) => path.clone(),
        None => Vec::new(),
    }
}

fn capability_for_path(path: &[String]) -> Option<Capability> {
    if path.len() != 2 {
        return None;
    }
    let capability = match (path[0].as_str(), path[1].as_str()) {
        ("fs", "read") => Capability::FsRead,
        ("fs", "write") => Capability::FsWrite,
        ("net", "connect") => Capability::NetConnect,
        ("net", "listen") => Capability::NetListen,
        ("net", "resolve") => Capability::NetResolve,
        ("child_process", "spawn") => Capability::ChildSpawn,
        ("worker", "spawn") => Capability::WorkerSpawn,
        ("env", "read") => Capability::EnvRead,
        ("ffi", "load") => Capability::FfiLoad,
        _ => return None,
    };
    Some(capability)
}

/// Read one JSON string starting at `start` (which must be `"`). Returns the decoded value, the
/// index after the closing quote, and the line the string started on.
///
/// The scanner only needs ASCII capability keys. Escapes are decoded well enough that an escaped
/// quote does not end the token; a key written with `\u` escapes is not matched, which is the
/// "report no line" fallback rather than a wrong line.
fn read_string(bytes: &[u8], start: usize, line: &mut u32) -> (String, usize, u32) {
    let start_line = *line;
    let mut index = start + 1;
    let mut value = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return (value, index + 1, start_line),
            b'\\' => {
                index += 1;
                if index >= bytes.len() {
                    break;
                }
                match bytes[index] {
                    b'n' => value.push('\n'),
                    b't' => value.push('\t'),
                    b'r' => value.push('\r'),
                    b'b' => value.push('\u{0008}'),
                    b'f' => value.push('\u{000c}'),
                    b'u' => {
                        if index + 4 < bytes.len() {
                            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 5]) {
                                if let Ok(code) = u32::from_str_radix(hex, 16) {
                                    if let Some(character) = char::from_u32(code) {
                                        value.push(character);
                                    }
                                    index += 4;
                                }
                            }
                        }
                    }
                    other => value.push(other as char),
                }
                index += 1;
            }
            b'\n' => {
                *line += 1;
                value.push('\n');
                index += 1;
            }
            other => {
                value.push(other as char);
                index += 1;
            }
        }
    }
    (value, index, start_line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn lines(text: &str) -> [Option<u32>; Capability::COUNT] {
        let mut stripped = String::new();
        json_comments::StripComments::new(text.as_bytes())
            .read_to_string(&mut stripped)
            .expect("strip");
        capability_lines(&stripped)
    }

    #[test]
    fn every_capability_key_is_located() {
        let text = r#"{
  // comments are stripped before this scan
  "fs": { "read": ["./data"], "write": ["./cache"] },
  "net": {
    "connect": ["api.example.com:443"],
    "listen": [":8080"],
    "resolve": ["api.example.com"]
  },
  "child_process": { "spawn": ["git"] },
  "worker": { "spawn": true },
  "env": { "read": ["PORT"] },
  "ffi": { "load": false }
}
"#;
        let lines = lines(text);
        assert_eq!(lines[Capability::FsRead.index()], Some(3));
        assert_eq!(lines[Capability::FsWrite.index()], Some(3));
        assert_eq!(lines[Capability::NetConnect.index()], Some(5));
        assert_eq!(lines[Capability::NetListen.index()], Some(6));
        assert_eq!(lines[Capability::NetResolve.index()], Some(7));
        assert_eq!(lines[Capability::ChildSpawn.index()], Some(9));
        assert_eq!(lines[Capability::WorkerSpawn.index()], Some(10));
        assert_eq!(lines[Capability::EnvRead.index()], Some(11));
        assert_eq!(lines[Capability::FfiLoad.index()], Some(12));
    }

    #[test]
    fn absent_keys_have_no_line_and_strings_do_not_confuse_the_scan() {
        let text = r#"{
  "fs": { "read": ["a string with \"fs\": { in it"] },
  "env": { "read": ["X"] }
}
"#;
        let lines = lines(text);
        assert_eq!(lines[Capability::FsRead.index()], Some(2));
        assert_eq!(lines[Capability::FsWrite.index()], None);
        assert_eq!(lines[Capability::NetConnect.index()], None);
        assert_eq!(lines[Capability::EnvRead.index()], Some(3));
    }

    #[test]
    fn malformed_input_reports_nothing_rather_than_panicking() {
        let lines = capability_lines("{\"fs\": {\"read\": [\"unterminated");
        assert_eq!(lines[Capability::FsRead.index()], Some(1));
        let lines = capability_lines("not json at all");
        assert!(lines.iter().all(Option::is_none));
    }
}
