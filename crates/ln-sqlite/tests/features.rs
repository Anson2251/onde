//! WP5/WP6: functions, aggregates, authorizer, sessions and virtual tables without QuickJS.
//!
//! The host supplies JavaScript-backed trait objects; these tests use plain Rust ones, which is
//! what keeps the crate engine-free and makes the trampolines testable on their own.

use std::collections::HashMap;
use std::path::Path;

use ln_sqlite::{
    AggregateFunction, Authorizer, ChangesetHandler, Database, FunctionOptions, ModuleColumn,
    OpenOptions, ScalarFunction, Value, VirtualTableModule,
};

fn memory() -> Database {
    Database::open(Path::new(":memory:"), &OpenOptions::default()).expect("open :memory:")
}

fn integer(value: i64) -> Value {
    Value::Integer(value)
}

struct Double;
impl ScalarFunction for Double {
    fn call(&mut self, args: &[Value]) -> ln_sqlite::Result<Value> {
        Ok(match args.first() {
            Some(Value::Integer(value)) => Value::Integer(value.saturating_mul(2)),
            Some(Value::Real(value)) => Value::Real(value * 2.0),
            _ => Value::Null,
        })
    }
}

#[test]
fn scalar_function_round_trip() {
    let mut db = memory();
    db.create_scalar_function("double", 1, FunctionOptions::default(), Box::new(Double))
        .unwrap();
    let statement = db.prepare("SELECT double(21) AS v", false).unwrap();
    db.bind(statement, &ln_sqlite::Params::default()).unwrap();
    assert_eq!(db.first(statement, false).unwrap(), Some(vec![integer(42)]));
}

#[derive(Default)]
struct Sum {
    states: HashMap<u64, i64>,
    next: u64,
}

impl AggregateFunction for Sum {
    fn start(&mut self) -> ln_sqlite::Result<u64> {
        self.next += 1;
        self.states.insert(self.next, 0);
        Ok(self.next)
    }

    fn step(&mut self, state: u64, args: &[Value]) -> ln_sqlite::Result<u64> {
        if let Some(Value::Integer(value)) = args.first() {
            if let Some(total) = self.states.get_mut(&state) {
                *total += value;
            }
        }
        Ok(state)
    }

    fn result(&mut self, state: u64) -> ln_sqlite::Result<Value> {
        Ok(integer(*self.states.get(&state).unwrap_or(&0)))
    }

    fn inverse(&mut self, state: u64, args: &[Value]) -> ln_sqlite::Result<u64> {
        if let Some(Value::Integer(value)) = args.first() {
            if let Some(total) = self.states.get_mut(&state) {
                *total -= value;
            }
        }
        Ok(state)
    }

    fn drop_state(&mut self, state: u64) {
        self.states.remove(&state);
    }
}

#[test]
fn aggregate_function_and_window() {
    let mut db = memory();
    db.create_aggregate_function(
        "total",
        1,
        FunctionOptions::default(),
        true,
        Box::new(Sum::default()),
    )
    .unwrap();
    let statement = db
        .prepare(
            "SELECT total(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS v \
             FROM (SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3)",
            false,
        )
        .unwrap();
    db.bind(statement, &ln_sqlite::Params::default()).unwrap();
    assert_eq!(
        db.all(statement, false).unwrap(),
        vec![vec![integer(1)], vec![integer(3)], vec![integer(5)]]
    );
}

struct DenyCreate;
impl Authorizer for DenyCreate {
    fn authorize(
        &mut self,
        action: i32,
        _arg1: Option<&str>,
        _arg2: Option<&str>,
        _database: Option<&str>,
        _trigger: Option<&str>,
    ) -> i32 {
        // SQLITE_CREATE_TABLE = 2, SQLITE_DENY = 1.
        if action == 2 {
            1
        } else {
            0
        }
    }
}

#[test]
fn authorizer_denies_and_clears() {
    let mut db = memory();
    db.set_authorizer(Some(Box::new(DenyCreate))).unwrap();
    let error = db.exec("CREATE TABLE blocked(a)").unwrap_err();
    assert_eq!(error.code, "ERR_SQLITE_ERROR");
    assert_eq!(error.message, "not authorized");
    db.set_authorizer(None).unwrap();
    db.exec("CREATE TABLE allowed(a)").unwrap();
}

struct Replace;
impl ChangesetHandler for Replace {
    fn conflict(&mut self, _conflict: i32) -> i32 {
        1 // SQLITE_CHANGESET_REPLACE
    }
}

struct Abort;
impl ChangesetHandler for Abort {}

#[test]
fn sessions_changeset_and_conflicts() {
    let mut source = memory();
    let mut target = memory();
    source
        .exec("CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)")
        .unwrap();
    target
        .exec("CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)")
        .unwrap();
    target.exec("INSERT INTO data VALUES (1, 'old')").unwrap();

    let session = source.create_session(None, "main").unwrap();
    source.exec("INSERT INTO data VALUES (1, 'new')").unwrap();
    let changeset = source.session_changeset(session).unwrap();
    assert!(!changeset.is_empty());

    // Default: abort and report false.
    assert!(!target.apply_changeset(&changeset, &mut Abort).unwrap());
    // Replace: apply.
    assert!(target.apply_changeset(&changeset, &mut Replace).unwrap());
    let statement = target.prepare("SELECT value FROM data", false).unwrap();
    target
        .bind(statement, &ln_sqlite::Params::default())
        .unwrap();
    assert_eq!(
        target.first(statement, false).unwrap(),
        Some(vec![Value::Text("new".to_owned())])
    );
    source.close_session(session).unwrap();
}

struct Series;
impl VirtualTableModule for Series {
    fn rows(&mut self, args: &[Value]) -> ln_sqlite::Result<Vec<Vec<Value>>> {
        let start = match args.first() {
            Some(Value::Integer(value)) => *value,
            _ => 1,
        };
        let stop = match args.get(1) {
            Some(Value::Integer(value)) => *value,
            _ => 3,
        };
        Ok((start..=stop).map(|value| vec![integer(value)]).collect())
    }
}

#[test]
fn virtual_table_rows_and_hidden_arguments() {
    let mut db = memory();
    db.create_module(
        "series",
        vec![
            ModuleColumn {
                name: "value".to_owned(),
                kind: "INTEGER".to_owned(),
                hidden: false,
            },
            ModuleColumn {
                name: "start".to_owned(),
                kind: "INTEGER".to_owned(),
                hidden: true,
            },
            ModuleColumn {
                name: "stop".to_owned(),
                kind: "INTEGER".to_owned(),
                hidden: true,
            },
        ],
        false,
        Box::new(Series),
    )
    .unwrap();
    let statement = db.prepare("SELECT value FROM series(2, 4)", false).unwrap();
    db.bind(statement, &ln_sqlite::Params::default()).unwrap();
    assert_eq!(
        db.all(statement, false).unwrap(),
        vec![vec![integer(2)], vec![integer(3)], vec![integer(4)]]
    );
}
