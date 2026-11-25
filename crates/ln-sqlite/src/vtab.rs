//! JavaScript-backed virtual tables (`database.createModule()`).
//!
//! SQLite drives a virtual table through a C `sqlite3_module`: open a cursor, filter it, step it,
//! read columns. The host materializes the JavaScript `rows()` iterable into a `Vec<Vec<Value>>`
//! in `xFilter`, so the cursor is plain Rust data and no JavaScript runs during `xNext`/`xColumn`.
//! Hidden columns are the module's arguments: `xBestIndex` maps equality constraints on them to
//! argv positions, and `xFilter` passes those values to `rows()` in declaration order.
//!
//! The module definition and its user data are owned here: SQLite keeps the `sqlite3_module`
//! pointer for the life of the connection, so `Database` frees it only after the connection has
//! closed. The user data is freed by SQLite's own `xDestroy`.

use std::ffi::{c_char, c_int, c_void, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use rusqlite::ffi;

use crate::database::Database;
use crate::error::{Error, Result};
use crate::function::{read_value, set_result};
use crate::value::Value;

/// One declared column of a virtual table.
#[derive(Debug, Clone)]
pub struct ModuleColumn {
    pub name: String,
    /// `INTEGER`, `TEXT`, `REAL`, `BLOB` or `ANY`; validated by the JavaScript layer.
    pub kind: String,
    /// Hidden columns are arguments to the table-valued function.
    pub hidden: bool,
}

/// A JavaScript-backed row producer.
pub trait VirtualTableModule: 'static {
    /// Produce every row for one invocation. `args` holds the hidden-column arguments in
    /// declaration order; each returned row holds the visible-column values in order.
    fn rows(&mut self, args: &[Value]) -> Result<Vec<Vec<Value>>>;
}

struct ModuleData {
    columns: Vec<ModuleColumn>,
    /// Absolute column index -> visible position, or `None` for a hidden column.
    visible: Vec<Option<usize>>,
    module: Box<dyn VirtualTableModule>,
    direct_only: bool,
}

#[repr(C)]
struct Vtab {
    base: ffi::sqlite3_vtab,
    data: *mut ModuleData,
}

#[repr(C)]
struct Cursor {
    base: ffi::sqlite3_vtab_cursor,
    data: *mut ModuleData,
    rows: Vec<Vec<Value>>,
    /// Hidden-column values, indexed by absolute column.
    args: Vec<Value>,
    index: usize,
}

impl Database {
    /// Register a virtual-table module. `columns` is declaration order; hidden columns are its
    /// arguments.
    pub fn create_module(
        &mut self,
        name: &str,
        columns: Vec<ModuleColumn>,
        direct_only: bool,
        module: Box<dyn VirtualTableModule>,
    ) -> Result<()> {
        if columns.is_empty() {
            return Err(Error::invalid_arg_value(
                "The \"options.columns\" array must not be empty.",
            ));
        }
        let mut visible = Vec::with_capacity(columns.len());
        let mut next = 0;
        for column in &columns {
            if column.hidden {
                visible.push(None);
            } else {
                visible.push(Some(next));
                next += 1;
            }
        }
        let data = Box::into_raw(Box::new(ModuleData {
            columns,
            visible,
            module,
            direct_only,
        }));
        // SAFETY: a zeroed `sqlite3_module` is a valid "all callbacks NULL" value; every field
        // SQLite will call is set below.
        let mut definition: ffi::sqlite3_module = unsafe { std::mem::zeroed() };
        definition.iVersion = 3;
        definition.xCreate = Some(vtab_connect);
        definition.xConnect = Some(vtab_connect);
        definition.xBestIndex = Some(vtab_best_index);
        definition.xDisconnect = Some(vtab_disconnect);
        definition.xDestroy = Some(vtab_disconnect);
        definition.xOpen = Some(vtab_open);
        definition.xClose = Some(vtab_close);
        definition.xFilter = Some(vtab_filter);
        definition.xNext = Some(vtab_next);
        definition.xEof = Some(vtab_eof);
        definition.xColumn = Some(vtab_column);
        definition.xRowid = Some(vtab_rowid);
        let definition = Box::into_raw(Box::new(definition));
        let db = self.handle()?;
        let name = CString::new(name)
            .map_err(|_| Error::invalid_arg_value("Module name contains a NUL byte."))?;
        // SAFETY: `definition` and `data` stay alive for the connection (the former in
        // `self.modules`, the latter owned by SQLite through `destroy_module_data`).
        let result = unsafe {
            ffi::sqlite3_create_module_v2(
                db,
                name.as_ptr(),
                definition,
                data.cast::<c_void>(),
                Some(destroy_module_data),
            )
        };
        if result != ffi::SQLITE_OK {
            // SAFETY: SQLite did not keep the definition pointer on failure. The user data is
            // released by SQLite's documented failure path.
            drop(unsafe { Box::from_raw(definition) });
            return Err(Error::from_db(db, result));
        }
        self.modules.push(definition);
        Ok(())
    }

    /// Free the module definitions after the connection is closed.
    pub(crate) fn drop_modules(&mut self) {
        for definition in self.modules.drain(..) {
            // SAFETY: SQLite no longer references the definition after `sqlite3_close`.
            drop(unsafe { Box::from_raw(definition) });
        }
    }
}

unsafe extern "C" fn destroy_module_data(data: *mut c_void) {
    if data.is_null() {
        return;
    }
    // SAFETY: the pointer came from `Box::into_raw` in `create_module`.
    drop(unsafe { Box::from_raw(data.cast::<ModuleData>()) });
}

unsafe extern "C" fn vtab_connect(
    db: *mut ffi::sqlite3,
    data: *mut c_void,
    _argc: c_int,
    _argv: *const *const c_char,
    vtab: *mut *mut ffi::sqlite3_vtab,
    error: *mut *mut c_char,
) -> c_int {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let module = unsafe { &*(data.cast::<ModuleData>()) };
        let mut schema = String::from("CREATE TABLE x(");
        for (index, column) in module.columns.iter().enumerate() {
            if index > 0 {
                schema.push(',');
            }
            schema.push('"');
            schema.push_str(&column.name.replace('"', "\"\""));
            schema.push('"');
            if !column.kind.is_empty() {
                schema.push(' ');
                schema.push_str(&column.kind);
            }
            if column.hidden {
                schema.push_str(" HIDDEN");
            }
        }
        schema.push(')');
        let schema = match CString::new(schema) {
            Ok(schema) => schema,
            Err(_) => return ffi::SQLITE_ERROR,
        };
        // SAFETY: a live connection; SQLite copies the schema.
        if unsafe { ffi::sqlite3_declare_vtab(db, schema.as_ptr()) } != ffi::SQLITE_OK {
            return ffi::SQLITE_ERROR;
        }
        if module.direct_only {
            // SAFETY: `sqlite3_vtab_config` is variadic; DIRECTONLY takes no argument.
            unsafe {
                ffi::sqlite3_vtab_config(db, ffi::SQLITE_VTAB_DIRECTONLY);
            }
        }
        let vtab_box = Box::new(Vtab {
            base: ffi::sqlite3_vtab {
                pModule: ptr::null(),
                nRef: 0,
                zErrMsg: ptr::null_mut(),
            },
            data: data.cast::<ModuleData>(),
        });
        // SAFETY: the out-parameter is valid; the box is released in `vtab_disconnect`.
        unsafe {
            *vtab = Box::into_raw(vtab_box).cast::<ffi::sqlite3_vtab>();
        }
        ffi::SQLITE_OK
    }));
    match outcome {
        Ok(code) => code,
        Err(_) => {
            if !error.is_null() {
                unsafe { *error = ptr::null_mut() };
            }
            ffi::SQLITE_ERROR
        }
    }
}

unsafe extern "C" fn vtab_disconnect(vtab: *mut ffi::sqlite3_vtab) -> c_int {
    if vtab.is_null() {
        return ffi::SQLITE_OK;
    }
    // SAFETY: the pointer came from `Box::into_raw` in `vtab_connect`; the module data is owned
    // by SQLite separately and is not dropped here.
    drop(unsafe { Box::from_raw(vtab.cast::<Vtab>()) });
    ffi::SQLITE_OK
}

unsafe extern "C" fn vtab_best_index(
    vtab: *mut ffi::sqlite3_vtab,
    info: *mut ffi::sqlite3_index_info,
) -> c_int {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: both pointers are live for the call.
        let vtab = unsafe { &*(vtab.cast::<Vtab>()) };
        let module = unsafe { &*vtab.data };
        let info = unsafe { &mut *info };
        let count = info.nConstraint.max(0) as usize;
        if count == 0 || info.aConstraint.is_null() || info.aConstraintUsage.is_null() {
            info.estimatedCost = 100.0;
            info.estimatedRows = 100;
            return ffi::SQLITE_OK;
        }
        // SAFETY: SQLite provides `nConstraint` entries in both arrays.
        let constraints = unsafe { std::slice::from_raw_parts(info.aConstraint, count) };
        let usage = unsafe { std::slice::from_raw_parts_mut(info.aConstraintUsage, count) };
        let mut argument = 0;
        let mut mask = 0;
        // Walk the hidden columns in declaration order so `rows()` sees its arguments in order,
        // regardless of the order SQLite lists the constraints in.
        for (column, definition) in module.columns.iter().enumerate() {
            if !definition.hidden {
                continue;
            }
            for (index, constraint) in constraints.iter().enumerate() {
                if constraint.usable != 0
                    && constraint.iColumn as usize == column
                    && constraint.op as i32 == ffi::SQLITE_INDEX_CONSTRAINT_EQ
                {
                    argument += 1;
                    usage[index].argvIndex = argument;
                    usage[index].omit = 1;
                    mask |= 1 << column;
                    break;
                }
            }
        }
        info.idxNum = mask;
        info.estimatedCost = 100.0;
        info.estimatedRows = 100;
        ffi::SQLITE_OK
    }));
    outcome.unwrap_or(ffi::SQLITE_ERROR)
}

unsafe extern "C" fn vtab_open(
    vtab: *mut ffi::sqlite3_vtab,
    cursor: *mut *mut ffi::sqlite3_vtab_cursor,
) -> c_int {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: the vtab is live; the out-parameter is valid.
        let vtab = unsafe { &*(vtab.cast::<Vtab>()) };
        let boxed = Box::new(Cursor {
            base: ffi::sqlite3_vtab_cursor {
                pVtab: &vtab.base as *const ffi::sqlite3_vtab as *mut ffi::sqlite3_vtab,
            },
            data: vtab.data,
            rows: Vec::new(),
            args: Vec::new(),
            index: 0,
        });
        unsafe {
            *cursor = Box::into_raw(boxed).cast::<ffi::sqlite3_vtab_cursor>();
        }
        ffi::SQLITE_OK
    }));
    outcome.unwrap_or(ffi::SQLITE_ERROR)
}

unsafe extern "C" fn vtab_close(cursor: *mut ffi::sqlite3_vtab_cursor) -> c_int {
    if cursor.is_null() {
        return ffi::SQLITE_OK;
    }
    // SAFETY: the pointer came from `Box::into_raw` in `vtab_open`.
    drop(unsafe { Box::from_raw(cursor.cast::<Cursor>()) });
    ffi::SQLITE_OK
}

unsafe extern "C" fn vtab_filter(
    cursor: *mut ffi::sqlite3_vtab_cursor,
    idx_num: c_int,
    _idx_str: *const c_char,
    argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) -> c_int {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: the cursor is live for the call.
        let cursor = unsafe { &mut *(cursor.cast::<Cursor>()) };
        let vtab = cursor.base.pVtab;
        let module = unsafe { &mut *cursor.data };
        let count = argc.max(0) as usize;
        let values = if count == 0 || argv.is_null() {
            &[][..]
        } else {
            // SAFETY: SQLite provides `argc` values.
            unsafe { std::slice::from_raw_parts(argv, count) }
        };
        let mut args = vec![Value::Null; module.columns.len()];
        let mut next = 0;
        for (column, definition) in module.columns.iter().enumerate() {
            if !definition.hidden || (idx_num & (1 << column)) == 0 {
                continue;
            }
            let Some(value) = values.get(next) else {
                break;
            };
            match unsafe { read_value(*value) } {
                Ok(value) => args[column] = value,
                Err(error) => {
                    unsafe { set_vtab_error(vtab, &error.message) };
                    return ffi::SQLITE_ERROR;
                }
            }
            next += 1;
        }
        // Arguments are positional, so only the leading hidden columns that the query supplied
        // are passed — a missing argument is absent from `rows`'s argument list, as in Node.
        let mut hidden = Vec::new();
        for (column, definition) in module.columns.iter().enumerate() {
            if !definition.hidden {
                continue;
            }
            if (idx_num & (1 << column)) == 0 {
                break;
            }
            hidden.push(args[column].clone());
        }
        match module.module.rows(&hidden) {
            Ok(rows) => {
                cursor.rows = rows;
                cursor.args = args;
                cursor.index = 0;
                ffi::SQLITE_OK
            }
            Err(error) => {
                unsafe { set_vtab_error(vtab, &error.message) };
                ffi::SQLITE_ERROR
            }
        }
    }));
    outcome.unwrap_or(ffi::SQLITE_ERROR)
}

unsafe extern "C" fn vtab_next(cursor: *mut ffi::sqlite3_vtab_cursor) -> c_int {
    // SAFETY: the cursor is live for the call.
    let cursor = unsafe { &mut *(cursor.cast::<Cursor>()) };
    cursor.index = cursor.index.saturating_add(1);
    ffi::SQLITE_OK
}

unsafe extern "C" fn vtab_eof(cursor: *mut ffi::sqlite3_vtab_cursor) -> c_int {
    // SAFETY: the cursor is live for the call.
    let cursor = unsafe { &*(cursor.cast::<Cursor>()) };
    i32::from(cursor.index >= cursor.rows.len())
}

unsafe extern "C" fn vtab_column(
    cursor: *mut ffi::sqlite3_vtab_cursor,
    context: *mut ffi::sqlite3_context,
    column: c_int,
) -> c_int {
    // SAFETY: the cursor is live for the call.
    let cursor = unsafe { &mut *(cursor.cast::<Cursor>()) };
    let module = unsafe { &*cursor.data };
    let Ok(column) = usize::try_from(column) else {
        return ffi::SQLITE_ERROR;
    };
    let Some(definition) = module.columns.get(column) else {
        return ffi::SQLITE_ERROR;
    };
    let value = if definition.hidden {
        cursor.args.get(column).cloned().unwrap_or(Value::Null)
    } else {
        let visible = module.visible[column];
        visible
            .and_then(|visible| {
                cursor
                    .rows
                    .get(cursor.index)
                    .and_then(|row| row.get(visible))
                    .cloned()
            })
            .unwrap_or(Value::Null)
    };
    unsafe { set_result(context, value) };
    ffi::SQLITE_OK
}

unsafe extern "C" fn vtab_rowid(
    cursor: *mut ffi::sqlite3_vtab_cursor,
    rowid: *mut ffi::sqlite3_int64,
) -> c_int {
    // SAFETY: the cursor and the out-parameter are live for the call.
    let cursor = unsafe { &*(cursor.cast::<Cursor>()) };
    unsafe { *rowid = cursor.index as ffi::sqlite3_int64 + 1 };
    ffi::SQLITE_OK
}

unsafe fn set_vtab_error(vtab: *mut ffi::sqlite3_vtab, message: &str) {
    if vtab.is_null() {
        return;
    }
    let bytes = message.as_bytes();
    let size = bytes.len() + 1;
    // SAFETY: SQLite owns `zErrMsg` and frees it with `sqlite3_free`; allocate with the same
    // allocator so the string can be reported.
    let pointer = unsafe { ffi::sqlite3_malloc64(size as u64) }.cast::<u8>();
    if pointer.is_null() {
        return;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
        *pointer.add(bytes.len()) = 0;
        (*vtab).zErrMsg = pointer.cast();
    }
}
