//! The synchronous contract, tested without QuickJS.
//!
//! These are the rules from `docs/sqlite-plan.md` §5 that can be asserted here rather than through
//! the JavaScript surface. The conformance corpus still checks the same behaviour end to end.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use ln_sqlite::{BindOptions, Database, Limit, OpenOptions, Params, Stat, Value};

fn memory() -> Database {
    Database::open(Path::new(":memory:"), &OpenOptions::default()).expect("open :memory:")
}

fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

fn anonymous(values: Vec<Value>) -> Params {
    Params::anonymous(values)
}

fn temp_path(label: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "ln-sqlite-{label}-{}-{unique}.db",
        std::process::id()
    ))
}

/// Remove a test database and its journal files.
fn clean(path: &Path) {
    let _ = std::fs::remove_file(path);
    for suffix in ["-journal", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn create_insert_and_read() {
    let mut db = memory();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)")
        .unwrap();
    let insert = db.prepare("INSERT INTO t(name) VALUES (?)", false).unwrap();
    db.bind(insert, &anonymous(vec![text("a")])).unwrap();
    let first = db.run(insert).unwrap();
    assert_eq!(first.changes, 1);
    assert_eq!(first.last_insert_rowid, 1);

    db.bind(insert, &anonymous(vec![text("b")])).unwrap();
    let second = db.run(insert).unwrap();
    assert_eq!(second.last_insert_rowid, 2);

    let select = db
        .prepare("SELECT id, name FROM t ORDER BY id", false)
        .unwrap();
    let rows = db.all(select, false).unwrap();
    assert_eq!(
        rows,
        vec![
            vec![Value::Integer(1), text("a")],
            vec![Value::Integer(2), text("b")]
        ]
    );
    assert_eq!(
        db.first(select, false).unwrap(),
        Some(vec![Value::Integer(1), text("a")])
    );
}

#[test]
fn changes_and_last_insert_rowid_survive_a_select() {
    let mut db = memory();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)").unwrap();
    let insert = db.prepare("INSERT INTO t DEFAULT VALUES", false).unwrap();
    db.bind(insert, &ParamHelper::empty()).unwrap();
    db.run(insert).unwrap();

    let select = db.prepare("SELECT * FROM t", false).unwrap();
    db.bind(select, &ParamHelper::empty()).unwrap();
    let result = db.run(select).unwrap();
    // SQLite reports the last DML's values; Node shows the same.
    assert_eq!(result.changes, 1);
    assert_eq!(result.last_insert_rowid, 1);
}

/// `Params::default()` has the Node defaults, which is what an empty statement needs.
struct ParamHelper;

impl ParamHelper {
    fn empty() -> Params {
        Params {
            named: Vec::new(),
            anonymous: Vec::new(),
            options: BindOptions::default(),
        }
    }
}

#[test]
fn named_parameters_exact_bare_and_unknown() {
    let mut db = memory();
    let statement = db
        .prepare("SELECT :a AS a, $b AS b, @c AS c", false)
        .unwrap();
    let params = Params {
        named: vec![
            (":a".to_owned(), Value::Integer(1)),
            ("b".to_owned(), Value::Integer(2)),
            ("c".to_owned(), Value::Integer(3)),
        ],
        anonymous: Vec::new(),
        options: BindOptions::default(),
    };
    db.bind(statement, &params).unwrap();
    assert_eq!(
        db.first(statement, false).unwrap(),
        Some(vec![
            Value::Integer(1),
            Value::Integer(2),
            Value::Integer(3)
        ])
    );

    // Bare names off: `b` no longer resolves.
    let mut params = Params {
        named: vec![("b".to_owned(), Value::Integer(2))],
        anonymous: Vec::new(),
        options: BindOptions {
            allow_bare_named: false,
            allow_unknown_named: false,
        },
    };
    let error = db.bind(statement, &params).unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_STATE");
    assert_eq!(error.message, "Unknown named parameter 'b'");

    // Unknown names are ignored when allowed.
    params.options.allow_unknown_named = true;
    db.bind(statement, &params).unwrap();

    // An ambiguous bare name is an error, not a guess.
    let ambiguous = db.prepare("SELECT $k AS a, @k AS b", false).unwrap();
    let error = db
        .bind(
            ambiguous,
            &Params {
                named: vec![("k".to_owned(), Value::Integer(9))],
                anonymous: Vec::new(),
                options: BindOptions::default(),
            },
        )
        .unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_STATE");
    assert!(error
        .message
        .contains("Cannot create bare named parameter 'k'"));
}

#[test]
fn positional_arguments_bind_only_question_mark_slots() {
    let mut db = memory();
    // `:a` is not positional: Node rejects this with errcode 25.
    let named_only = db.prepare("SELECT :a AS a", false).unwrap();
    let error = db
        .bind(named_only, &anonymous(vec![Value::Integer(7)]))
        .unwrap_err();
    assert_eq!(error.code, "ERR_SQLITE_ERROR");
    assert_eq!(error.errcode, Some(25));

    // `:a` followed by `?`: the positional argument binds the `?` (index 2), not `:a`.
    let mixed = db.prepare("SELECT :a AS a, ? AS b", false).unwrap();
    db.bind(mixed, &anonymous(vec![Value::Integer(5)])).unwrap();
    assert_eq!(
        db.first(mixed, false).unwrap(),
        Some(vec![Value::Null, Value::Integer(5)])
    );

    // `?2, ?1` maps the first positional argument to parameter index 1.
    let numbered = db.prepare("SELECT ?2 AS a, ?1 AS b", false).unwrap();
    db.bind(
        numbered,
        &anonymous(vec![Value::Integer(5), Value::Integer(6)]),
    )
    .unwrap();
    assert_eq!(
        db.first(numbered, false).unwrap(),
        Some(vec![Value::Integer(6), Value::Integer(5)])
    );

    // One argument too many.
    let error = db
        .bind(
            numbered,
            &anonymous(vec![
                Value::Integer(1),
                Value::Integer(2),
                Value::Integer(3),
            ]),
        )
        .unwrap_err();
    assert_eq!(error.errcode, Some(25));
}

#[test]
fn every_storage_class_round_trips() {
    let mut db = memory();
    db.exec("CREATE TABLE t(v)").unwrap();
    let insert = db.prepare("INSERT INTO t VALUES (?)", false).unwrap();
    for value in [
        Value::Null,
        Value::Integer(-42),
        Value::Real(1.5),
        text("héllo"),
        Value::Blob(vec![0, 1, 2, 255]),
    ] {
        db.bind(insert, &anonymous(vec![value.clone()])).unwrap();
        db.run(insert).unwrap();
    }

    let select = db.prepare("SELECT v FROM t", false).unwrap();
    let rows = db.all(select, false).unwrap();
    assert_eq!(rows[0][0], Value::Null);
    assert_eq!(rows[1][0], Value::Integer(-42));
    assert_eq!(rows[2][0], Value::Real(1.5));
    assert_eq!(rows[3][0], text("héllo"));
    assert_eq!(rows[4][0], Value::Blob(vec![0, 1, 2, 255]));
}

#[test]
fn big_integers_are_opt_in() {
    let mut db = memory();
    let statement = db.prepare("SELECT 9007199254740993 AS v", false).unwrap();
    db.bind(statement, &ParamHelper::empty()).unwrap();
    let error = db.first(statement, false).unwrap_err();
    assert_eq!(error.code, "ERR_OUT_OF_RANGE");
    assert!(error.message.contains("9007199254740993"));

    db.bind(statement, &ParamHelper::empty()).unwrap();
    assert_eq!(
        db.first(statement, true).unwrap(),
        Some(vec![Value::Integer(9007199254740993)])
    );
}

#[test]
fn columns_report_metadata_and_nulls_for_expressions() {
    let mut db = memory();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)")
        .unwrap();
    let select = db
        .prepare("SELECT id, name, 1 AS one FROM t", false)
        .unwrap();
    let columns = db.columns(select).unwrap();
    assert_eq!(columns[0].name, "id");
    assert_eq!(columns[0].kind.as_deref(), Some("INTEGER"));
    assert_eq!(columns[0].table.as_deref(), Some("t"));
    assert_eq!(columns[0].column.as_deref(), Some("id"));
    assert_eq!(columns[0].database.as_deref(), Some("main"));
    assert_eq!(columns[2].name, "one");
    assert_eq!(columns[2].kind, None);
    assert_eq!(columns[2].table, None);
}

#[test]
fn source_and_expanded_sql() {
    let mut db = memory();
    let select = db.prepare("SELECT ? AS x;", false).unwrap();
    assert_eq!(db.source_sql(select).unwrap(), "SELECT ? AS x;");
    assert_eq!(db.expanded_sql(select).unwrap(), "SELECT NULL AS x;");
    // Node binds a JavaScript number as REAL, so the expanded text shows `1.0`.
    db.bind(select, &anonymous(vec![Value::Real(1.0)])).unwrap();
    db.first(select, false).unwrap();
    assert_eq!(db.expanded_sql(select).unwrap(), "SELECT 1.0 AS x;");
    // Bindings are cleared before the next execution, so an unbound slot is NULL again.
    db.bind(select, &anonymous(vec![])).unwrap();
    db.first(select, false).unwrap();
    assert_eq!(db.expanded_sql(select).unwrap(), "SELECT NULL AS x;");
}

#[test]
fn statement_status_counters() {
    let mut db = memory();
    db.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1), (2), (3)")
        .unwrap();
    let select = db.prepare("SELECT * FROM t", false).unwrap();
    assert_eq!(
        Stat::from_name("fullscanStep").map(|stat| db.stat(select, stat).unwrap()),
        Some(0)
    );
    db.bind(select, &ParamHelper::empty()).unwrap();
    let _ = db.all(select, false).unwrap();
    let fullscan = Stat::from_name("fullscanStep").unwrap();
    assert!(db.stat(select, fullscan).unwrap() > 0);
    assert!(db.stat(select, Stat::Memused).unwrap() > 0);
    db.reset_stats(select).unwrap();
    assert_eq!(db.stat(select, fullscan).unwrap(), 0);
}

#[test]
fn limits_read_write_and_reset() {
    let mut db = memory();
    assert!(db.limit(Limit::Length).unwrap() > 0);
    let previous = db.set_limit(Limit::SqlLength, 100_000).unwrap();
    assert!(previous > 100_000);
    assert_eq!(db.limit(Limit::SqlLength).unwrap(), 100_000);
    // `Infinity` from JavaScript becomes `i32::MAX`, which SQLite clamps to the hard maximum.
    db.set_limit(Limit::SqlLength, i32::MAX).unwrap();
    assert!(db.limit(Limit::SqlLength).unwrap() > 100_000);
}

#[test]
fn transaction_flag_follows_autocommit() {
    let db = memory();
    assert!(!db.is_transaction().unwrap());
    db.exec("BEGIN").unwrap();
    assert!(db.is_transaction().unwrap());
    db.exec("COMMIT").unwrap();
    assert!(!db.is_transaction().unwrap());
}

#[test]
fn location_is_none_for_memory_and_a_path_for_files() {
    let db = memory();
    assert_eq!(db.location("main").unwrap(), None);

    let path = temp_path("location");
    let file = Database::open(&path, &OpenOptions::default()).unwrap();
    let location = file.location("main").unwrap().expect("a file location");
    assert!(location.ends_with(path.file_name().unwrap().to_str().unwrap()));
    drop(file);
    clean(&path);
}

#[test]
fn serialize_and_deserialize_round_trip() {
    let source = memory();
    source
        .exec("CREATE TABLE t(a); INSERT INTO t VALUES (7)")
        .unwrap();
    let bytes = source.serialize("main").unwrap();
    assert!(!bytes.is_empty());

    let mut target = memory();
    target.deserialize("main", bytes).unwrap();
    let select = target.prepare("SELECT a FROM t", false).unwrap();
    assert_eq!(
        target.first(select, false).unwrap(),
        Some(vec![Value::Integer(7)])
    );

    // Deserialization finalizes existing statements.
    target
        .deserialize("main", source.serialize("main").unwrap())
        .unwrap();
    let error = target.first(select, false).unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_STATE");
}

#[test]
fn backup_copies_pages_and_reports_progress() {
    let source = memory();
    source
        .exec("CREATE TABLE t(a); INSERT INTO t VALUES (1), (2), (3)")
        .unwrap();
    let path = temp_path("backup");
    let mut backup = ln_sqlite::Backup::start(&source, &path, "main", "main").unwrap();
    let mut steps = 0;
    let total = loop {
        match backup.step(1).unwrap() {
            ln_sqlite::BackupStep::Done { page_count } => break page_count,
            ln_sqlite::BackupStep::More { .. } => {
                steps += 1;
                assert!(steps < 1000, "backup did not finish");
            }
        }
    };
    assert!(total > 0);
    let _ = backup.finish().unwrap();

    let copied = Database::open(&path, &OpenOptions::default()).unwrap();
    let select = {
        let mut db = copied;
        let statement = db.prepare("SELECT COUNT(*) FROM t", false).unwrap();
        db.bind(statement, &ParamHelper::empty()).unwrap();
        db.first(statement, false).unwrap()
    };
    assert_eq!(select, Some(vec![Value::Integer(3)]));
    clean(&path);
}

#[test]
fn closing_a_database_finalizes_its_statements() {
    let mut db = memory();
    db.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1)")
        .unwrap();
    let select = db.prepare("SELECT * FROM t", false).unwrap();
    db.close().unwrap();
    assert!(!db.is_open());
    let error = db.first(select, false).unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_STATE");
    assert_eq!(error.message, "statement has been finalized");
    // A second close is an error, matching Node.
    let error = db.close().unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_STATE");
    assert_eq!(error.message, "database is not open");
}

#[test]
fn errors_carry_sqlite_fields() {
    let mut db = memory();
    let error = db.prepare("SELECT FROM", false).unwrap_err();
    assert_eq!(error.code, "ERR_SQLITE_ERROR");
    assert_eq!(error.errcode, Some(1));
    assert_eq!(error.errstr.as_deref(), Some("SQL logic error"));
    assert!(error.message.contains("syntax error"));

    let error = db.prepare("", false).unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_ARG_VALUE");
}

#[test]
fn exec_runs_statements_until_the_first_error() {
    let mut db = memory();
    let error = db
        .exec("CREATE TABLE a(x); INSERT INTO a VALUES (1); BOGUS")
        .unwrap_err();
    assert_eq!(error.code, "ERR_SQLITE_ERROR");
    let check = db.prepare("SELECT COUNT(*) FROM a", false).unwrap();
    db.bind(check, &ParamHelper::empty()).unwrap();
    assert_eq!(
        db.first(check, false).unwrap(),
        Some(vec![Value::Integer(1)])
    );
}

#[test]
fn iterators_are_invalidated_by_re_execution() {
    let mut db = memory();
    db.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1), (2)")
        .unwrap();
    let select = db.prepare("SELECT a FROM t", false).unwrap();
    db.bind(select, &ParamHelper::empty()).unwrap();
    let (generation, first) = db.begin(select, false).unwrap();
    assert!(first.is_some());

    // Re-executing bumps the generation.
    db.bind(select, &ParamHelper::empty()).unwrap();
    let error = db.next(select, generation, false).unwrap_err();
    assert_eq!(error.code, "ERR_INVALID_STATE");
    assert_eq!(error.message, "iterator was invalidated");
    // Releasing a stale iterator is a no-op, not an error.
    db.finish(select, generation).unwrap();
}

#[test]
fn read_only_databases_refuse_writes() {
    let path = temp_path("readonly");
    {
        let db = Database::open(&path, &OpenOptions::default()).unwrap();
        db.exec("CREATE TABLE t(a)").unwrap();
    }
    let db = Database::open(
        &path,
        &OpenOptions {
            read_only: true,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    let error = db.exec("INSERT INTO t VALUES (1)").unwrap_err();
    assert_eq!(error.code, "ERR_SQLITE_ERROR");
    drop(db);
    clean(&path);
}

#[test]
fn foreign_keys_are_on_by_default_and_can_be_disabled() {
    let mut db = memory();
    let pragma = db.prepare("PRAGMA foreign_keys", false).unwrap();
    db.bind(pragma, &ParamHelper::empty()).unwrap();
    assert_eq!(
        db.first(pragma, false).unwrap(),
        Some(vec![Value::Integer(1)])
    );

    let mut off = Database::open(
        Path::new(":memory:"),
        &OpenOptions {
            foreign_keys: false,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    let pragma = off.prepare("PRAGMA foreign_keys", false).unwrap();
    off.bind(pragma, &ParamHelper::empty()).unwrap();
    assert_eq!(
        off.first(pragma, false).unwrap(),
        Some(vec![Value::Integer(0)])
    );
}

#[test]
fn double_quoted_string_literals_are_off_by_default() {
    let mut db = memory();
    let error = db.prepare("SELECT \"abc\" AS v", false).unwrap_err();
    assert_eq!(error.code, "ERR_SQLITE_ERROR");
    assert!(error.message.contains("no such column"));
}
