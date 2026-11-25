//! The values that cross the SQLite → JavaScript boundary, and the parameters going the other way.
//!
//! SQLite has five storage classes; JavaScript has more. The host converts a JavaScript argument
//! into a [`Value`] with Node's rules (`docs/research/node-sqlite-api.md` §2) and turns a [`Value`]
//! back into a JavaScript value. Nothing in this crate knows about QuickJS.

/// One SQLite value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// A named-parameter policy for one execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindOptions {
    /// `statement.setAllowBareNamedParameters`: accept `{ k: v }` for `:k`/`$k`/`@k`.
    pub allow_bare_named: bool,
    /// `statement.setAllowUnknownNamedParameters`: ignore keys the statement does not have.
    pub allow_unknown_named: bool,
}

impl Default for BindOptions {
    fn default() -> Self {
        BindOptions {
            allow_bare_named: true,
            allow_unknown_named: false,
        }
    }
}

/// The arguments for one execution, already split into the two binding modes.
///
/// The split happens in JavaScript because it is a property of Node's surface (a non-null object
/// in first position is the named map), but the resolution against SQLite's parameter table
/// happens here, where `sqlite3_bind_parameter_index` is available.
#[derive(Debug, Clone, Default)]
pub struct Params {
    pub named: Vec<(String, Value)>,
    pub anonymous: Vec<Value>,
    pub options: BindOptions,
}

impl Params {
    pub fn anonymous(values: Vec<Value>) -> Self {
        Params {
            named: Vec::new(),
            anonymous: values,
            options: BindOptions::default(),
        }
    }
}
