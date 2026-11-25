//! `sqlite.backup()`: the page-by-page copy that the JavaScript loop drives.
//!
//! A connection must stay on its isolate thread, so the host does not move the work to a thread
//! pool: `backupStep` is one synchronous batch, the JS layer awaits `setImmediate` between
//! batches, and `progress` runs after each one (docs/sqlite-plan.md §4.5).
//!
//! The [`Backup`] holds a raw `sqlite3_backup*` and therefore borrows both connections. The host
//! keeps the source `Rc` alive for as long as the backup entry exists; the destination connection
//! is owned here.

use std::path::Path;

use rusqlite::ffi;
use rusqlite::Connection;

use crate::database::Database;
use crate::error::{Error, Result};

/// The result of one `sqlite3_backup_step`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupStep {
    /// The copy finished; the value is the total page count.
    Done { page_count: i64 },
    /// More pages remain.
    More { page_count: i64, remaining: i64 },
}

/// A live backup operation.
pub struct Backup {
    raw: *mut ffi::sqlite3_backup,
    destination: Connection,
}

impl Backup {
    /// Start copying `source` into `path` (created if missing).
    ///
    /// `source` must outlive the returned value; the host enforces that by holding the source
    /// database in the same registry entry.
    pub fn start(source: &Database, path: &Path, source_db: &str, target_db: &str) -> Result<Self> {
        let destination = Connection::open(path).map_err(Error::from_rusqlite)?;
        let source_name = crate::cstring(source_db)
            .ok_or_else(|| Error::invalid_arg_value("source database name contains a NUL byte"))?;
        let target_name = crate::cstring(target_db)
            .ok_or_else(|| Error::invalid_arg_value("target database name contains a NUL byte"))?;
        let source_handle = source.handle()?;
        // SAFETY: a pure accessor; `destination` is live for the call.
        let destination_handle = unsafe { destination.handle() };
        // SAFETY: both connections are live, the names are NUL-terminated, and the backup object
        // is finished in `finish`/`Drop`.
        let raw = unsafe {
            ffi::sqlite3_backup_init(
                destination_handle,
                target_name.as_ptr(),
                source_handle,
                source_name.as_ptr(),
            )
        };
        if raw.is_null() {
            // SAFETY: `sqlite3_errcode` is a pure query on a live connection.
            let code = unsafe { ffi::sqlite3_errcode(destination_handle) };
            return Err(Error::from_db(destination_handle, code));
        }
        Ok(Backup { raw, destination })
    }

    /// Copy up to `pages` pages.
    pub fn step(&mut self, pages: u32) -> Result<BackupStep> {
        let pages = i32::try_from(pages).unwrap_or(i32::MAX);
        // SAFETY: the backup object is live until `finish`/`Drop`.
        let result = unsafe { ffi::sqlite3_backup_step(self.raw, pages) };
        // SAFETY: pure queries on the live backup object.
        let page_count = unsafe { ffi::sqlite3_backup_pagecount(self.raw) } as i64;
        match result {
            ffi::SQLITE_DONE => Ok(BackupStep::Done { page_count }),
            ffi::SQLITE_OK => {
                let remaining = unsafe { ffi::sqlite3_backup_remaining(self.raw) } as i64;
                Ok(BackupStep::More {
                    page_count,
                    remaining,
                })
            }
            ffi::SQLITE_BUSY | ffi::SQLITE_LOCKED => {
                let remaining = unsafe { ffi::sqlite3_backup_remaining(self.raw) } as i64;
                // A busy source is retryable; report progress with nothing transferred this step.
                Ok(BackupStep::More {
                    page_count,
                    remaining,
                })
            }
            other => {
                // SAFETY: a pure accessor on the live destination connection.
                let handle = unsafe { self.destination.handle() };
                Err(Error::from_db(handle, other))
            }
        }
    }

    /// Finish the copy and report the total page count.
    pub fn finish(mut self) -> Result<i64> {
        let raw = std::mem::replace(&mut self.raw, std::ptr::null_mut());
        if raw.is_null() {
            return Ok(0);
        }
        // SAFETY: the object is live and this is its only finish call.
        let page_count = unsafe { ffi::sqlite3_backup_pagecount(raw) } as i64;
        let result = unsafe { ffi::sqlite3_backup_finish(raw) };
        if result != ffi::SQLITE_OK {
            // SAFETY: a pure accessor on the live destination connection.
            let handle = unsafe { self.destination.handle() };
            return Err(Error::from_db(handle, result));
        }
        Ok(page_count)
    }
}

impl Drop for Backup {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            // SAFETY: the object is live and this is the only remaining finish call.
            unsafe {
                ffi::sqlite3_backup_finish(self.raw);
            }
        }
    }
}

impl std::fmt::Debug for Backup {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Backup")
            .field("finished", &self.raw.is_null())
            .finish()
    }
}
