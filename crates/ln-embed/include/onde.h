/*
 * onde.h — the C ABI of a compiled onde application.
 *
 * One header for every target. Link one archive per program:
 *
 *     cc app.c libonde-<tuple>.a -o app            (plus the cell's system libraries)
 *
 * The engine identity travels with the archive as a byte string (scan for "ONDE-ABI:" in the
 * file), and `onde_engine_stamp()` returns the same text at run time.
 */
#ifndef ONDE_H
#define ONDE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bump only for a breaking change to this header. A payload built for another ABI version is
 * refused with exit code 78, not run. */
#define ONDE_ABI_VERSION 1

/*
 * Run a payload and return the process exit code.
 *
 * `blob`/`len` are the payload: the bytecode and module table `ondec` produced. The bytes must
 * stay valid and immutable for the whole call — the runtime reads QuickJS bytecode in place, so
 * the payload must outlive it and must not be written to. A linked `const` array, a linker
 * section or a read-only mapping all qualify; a reusable stack buffer does not.
 *
 * `argc`/`argv` are the process's arguments. The runtime exposes them to JavaScript as Node does
 * in a single executable: `process.argv[0]` is the executable, `process.argv[1]` repeats it (there
 * is no script path), and `process.argv[2..]` are the user's arguments. `process.execPath` is
 * `argv[0]`.
 *
 * Returns the exit code the program asked for (0 by default). 78 means the payload was built for
 * a different engine version than this archive; nothing ran.
 */
int onde_main_payload(const unsigned char *blob, size_t len, int argc, char **argv);

/*
 * The engine identity of this archive, e.g.
 *
 *     ONDE-ABI:1;qjs=0.17.0;bc=28;endian=le;atom=3f9a1c02;
 *
 * Compare it with the payload header when embedding onde in a long-lived host: QuickJS bytecode
 * from another engine must not be loaded. The returned string is static and never freed.
 */
const char *onde_engine_stamp(void);

/* This archive's onde version, e.g. "0.1.0". Static; never freed. */
const char *onde_version(void);

#ifdef __cplusplus
}
#endif

#endif /* ONDE_H */
