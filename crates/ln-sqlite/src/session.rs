//! Sessions and changesets (`database.createSession()` / `database.applyChangeset()`).
//!
//! The session extension is a C API with an owned handle, so the handle lives in the same slot
//! table as statements. `applyChangeset` is the other place SQLite calls back into the host; the
//! trampolines are here and the handler is a trait object, as with functions (§function.rs).

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use rusqlite::ffi;

use crate::database::Database;
use crate::error::{Error, Result};

/// A session attached to one connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(u32);

impl SessionId {
    pub fn from_raw(value: u32) -> Self {
        SessionId(value)
    }

    pub fn value(self) -> u32 {
        self.0
    }
}

/// The two callbacks `sqlite3changeset_apply` offers.
///
/// The defaults match Node's documented defaults: every table is attempted, and a conflict aborts
/// the whole changeset.
pub trait ChangesetHandler {
    fn filter(&mut self, _table: &str) -> bool {
        true
    }

    fn conflict(&mut self, _conflict: i32) -> i32 {
        ffi::SQLITE_CHANGESET_ABORT
    }
}

/// The concrete callback context passed to `sqlite3changeset_apply`.
struct ApplyContext<'a> {
    handler: &'a mut dyn ChangesetHandler,
    aborted: bool,
}

impl Database {
    /// `createSession({ table?, db? })`.
    pub fn create_session(&mut self, table: Option<&str>, database: &str) -> Result<SessionId> {
        let db = self.handle()?;
        let database_name = CString::new(database)
            .map_err(|_| Error::invalid_arg_value("Database name contains a NUL byte."))?;
        let mut session: *mut ffi::sqlite3_session = ptr::null_mut();
        // SAFETY: the connection is live and `session` is a valid out-parameter.
        let result =
            unsafe { ffi::sqlite3session_create(db, database_name.as_ptr(), &mut session) };
        if result != ffi::SQLITE_OK {
            return Err(Error::from_db(db, result));
        }
        let table = match table {
            Some(name) => Some(
                CString::new(name)
                    .map_err(|_| Error::invalid_arg_value("Table name contains a NUL byte."))?,
            ),
            None => None,
        };
        // SAFETY: `session` is live; a NULL table name means "every table".
        let result = unsafe {
            ffi::sqlite3session_attach(
                session,
                table.as_ref().map_or(ptr::null(), |name| name.as_ptr()),
            )
        };
        if result != ffi::SQLITE_OK {
            unsafe { ffi::sqlite3session_delete(session) };
            return Err(Error::from_db(db, result));
        }
        self.sessions.push(Some(session));
        Ok(SessionId((self.sessions.len() - 1) as u32))
    }

    fn session(&self, id: SessionId) -> Result<*mut ffi::sqlite3_session> {
        self.sessions
            .get(id.0 as usize)
            .and_then(|session| *session)
            .ok_or_else(|| Error::invalid_state("session has been closed"))
    }

    /// `session.changeset()`.
    pub fn session_changeset(&self, id: SessionId) -> Result<Vec<u8>> {
        let session = self.session(id)?;
        let mut length: c_int = 0;
        let mut data: *mut c_void = ptr::null_mut();
        // SAFETY: a live session; the output buffer is freed below.
        let result = unsafe { ffi::sqlite3session_changeset(session, &mut length, &mut data) };
        if result != ffi::SQLITE_OK {
            return Err(self.session_error(result));
        }
        let bytes = copy_and_free(length, data);
        Ok(bytes)
    }

    /// `session.patchset()`.
    pub fn session_patchset(&self, id: SessionId) -> Result<Vec<u8>> {
        let session = self.session(id)?;
        let mut length: c_int = 0;
        let mut data: *mut c_void = ptr::null_mut();
        // SAFETY: as in `session_changeset`.
        let result = unsafe { ffi::sqlite3session_patchset(session, &mut length, &mut data) };
        if result != ffi::SQLITE_OK {
            return Err(self.session_error(result));
        }
        Ok(copy_and_free(length, data))
    }

    /// `session.close()`.
    pub fn close_session(&mut self, id: SessionId) -> Result<()> {
        let slot = self
            .sessions
            .get_mut(id.0 as usize)
            .and_then(Option::take)
            .ok_or_else(|| Error::invalid_state("session has been closed"))?;
        // SAFETY: the slot owned the only reference.
        unsafe { ffi::sqlite3session_delete(slot) };
        Ok(())
    }

    /// `database.applyChangeset(changeset[, options])`; returns `false` when a conflict aborted.
    pub fn apply_changeset(
        &self,
        changeset: &[u8],
        handler: &mut dyn ChangesetHandler,
    ) -> Result<bool> {
        let db = self.handle()?;
        let length = c_int::try_from(changeset.len())
            .map_err(|_| Error::invalid_arg_value("The changeset is too large."))?;
        let mut context = ApplyContext {
            handler,
            aborted: false,
        };
        let pointer = (&mut context as *mut ApplyContext<'_>).cast::<c_void>();
        // SAFETY: the changeset buffer is valid for the call, and `context` outlives it.
        let result = unsafe {
            ffi::sqlite3changeset_apply(
                db,
                length,
                changeset.as_ptr() as *mut c_void,
                Some(apply_filter),
                Some(apply_conflict),
                pointer,
            )
        };
        // An aborted changeset makes the C call report a constraint failure; Node reports that
        // as `false`, not as a thrown error.
        if result != ffi::SQLITE_OK && !context.aborted {
            return Err(Error::from_db(db, result));
        }
        Ok(!context.aborted)
    }

    /// Delete every session at close time.
    pub(crate) fn drop_sessions(&mut self) {
        for session in self.sessions.drain(..).flatten() {
            // SAFETY: the slot owned the only reference.
            unsafe { ffi::sqlite3session_delete(session) };
        }
    }

    fn session_error(&self, code: i32) -> Error {
        match self.handle() {
            Ok(db) => Error::from_db(db, code),
            Err(error) => error,
        }
    }
}

/// Copy SQLite's changeset buffer and release it with `sqlite3_free`.
fn copy_and_free(length: c_int, data: *mut c_void) -> Vec<u8> {
    if data.is_null() || length <= 0 {
        if !data.is_null() {
            // SAFETY: SQLite allocated it with its allocator.
            unsafe { ffi::sqlite3_free(data) };
        }
        return Vec::new();
    }
    // SAFETY: SQLite reports `length` valid bytes at `data`; copied before freeing.
    let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize).to_vec() };
    // SAFETY: as above.
    unsafe { ffi::sqlite3_free(data) };
    bytes
}

unsafe extern "C" fn apply_filter(context: *mut c_void, table: *const c_char) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `context` is the `ApplyContext` passed to `sqlite3changeset_apply`.
        let context = unsafe { &mut *context.cast::<ApplyContext<'_>>() };
        if table.is_null() {
            return 1;
        }
        // SAFETY: SQLite passes a NUL-terminated table name valid for the callback.
        let table = unsafe { CStr::from_ptr(table) }.to_string_lossy();
        i32::from(context.handler.filter(&table))
    }))
    .unwrap_or(0)
}

unsafe extern "C" fn apply_conflict(
    context: *mut c_void,
    conflict: c_int,
    _iterator: *mut ffi::sqlite3_changeset_iter,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: as in `apply_filter`.
        let context = unsafe { &mut *context.cast::<ApplyContext<'_>>() };
        let code = context.handler.conflict(conflict);
        if code == ffi::SQLITE_CHANGESET_ABORT {
            context.aborted = true;
        }
        code
    }))
    .unwrap_or(ffi::SQLITE_CHANGESET_ABORT)
}
