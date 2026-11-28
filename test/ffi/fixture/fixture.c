/*
 * fixture.c — the shared library the onde:ffi tests dlopen() and call through
 * libffi.
 *
 * The ABI here is the test contract, not an implementation detail. Every
 * prototype in fixture.h is called through libffi with exactly that signature,
 * and test/ffi/layout.c prints the compiler's sizeof/_Alignof/offsetof for the
 * structs so the host's computed layout is compared with the real compiler.
 * Changing a signature or a struct is a change to the JS matrix under
 * test/ffi/ at the same time.
 *
 * Build (single command, no build system, libc/libm only):
 *   cc -shared -fPIC -O2 -o /tmp/libffi-fixture.so   test/ffi/fixture/fixture.c
 *   cc -shared -fPIC -O2 -o /tmp/libffi-fixture.dylib test/ffi/fixture/fixture.c
 *
 * Deliberate properties, so a wrong host implementation shows up as a wrong
 * answer rather than as a crash:
 *   - C11, no threads, no constructors, no global state beyond the documented
 *     counters, so one `cc -shared` builds it on both targets.
 *   - No undefined behaviour: NULL is accepted by every pointer/receiver
 *     argument, arithmetic that may overflow is done in unsigned types and
 *     then converted back (two's-complement wrap), and memory that may be
 *     unaligned or aliased differently is read with memcpy().
 *   - Every export is a plain function or a plain int32_t, so nothing depends
 *     on compiler flags.
 */

#include "fixture.h"

#include <pthread.h>

#include <errno.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

/* Exported data symbol: readable and writable through dlsym. */
int32_t fixture_global_counter = 7;

/* Counters behind fixture_release()/fixture_release_count()/fixture_last_context(). */
static int32_t release_count = 0;
static void *release_context = NULL;

/* ------------------------------------------------------------------ */
/* scalar round-trips                                                  */
/* ------------------------------------------------------------------ */

/* Sums wrap modulo 2^32 (two's complement), never signed overflow. */
int32_t fixture_add_i32(int32_t a, int32_t b) {
    return (int32_t)((uint32_t)a + (uint32_t)b);
}

int64_t fixture_add_i64(int64_t a, int64_t b) {
    return (int64_t)((uint64_t)a + (uint64_t)b);
}

uint64_t fixture_add_u64(uint64_t a, uint64_t b) {
    return a + b;
}

int64_t fixture_i64_ident(int64_t v) {
    return v;
}

uint64_t fixture_u64_ident(uint64_t v) {
    return v;
}

/* -(int32_t)v is in [-128, 128], so it cannot overflow. */
int32_t fixture_neg_i8(int8_t v) {
    return -(int32_t)v;
}

uint32_t fixture_u32_ident(uint32_t v) {
    return v;
}

int32_t fixture_sum9(int32_t a, int32_t b, int32_t c, int32_t d, int32_t e,
                     int32_t f, int32_t g, int32_t h, int32_t i) {
    uint32_t acc = 0;
    acc += (uint32_t)a;
    acc += (uint32_t)b;
    acc += (uint32_t)c;
    acc += (uint32_t)d;
    acc += (uint32_t)e;
    acc += (uint32_t)f;
    acc += (uint32_t)g;
    acc += (uint32_t)h;
    acc += (uint32_t)i;
    return (int32_t)acc;
}

/* ------------------------------------------------------------------ */
/* floating point                                                      */
/* ------------------------------------------------------------------ */

double fixture_mul_f64(double a, double b) {
    return a * b;
}

float fixture_mul_f32(float a, float b) {
    return a * b;
}

/* ------------------------------------------------------------------ */
/* bool, strings, pointers                                             */
/* ------------------------------------------------------------------ */

/* _Bool's ABI value is 0 or 1; return the negation as 0/1. */
_Bool fixture_not_bool(_Bool v) {
    return v ? 0 : 1;
}

size_t fixture_cstrlen(const char *s) {
    return s == NULL ? 0 : strlen(s);
}

int32_t fixture_is_null(const void *p) {
    return p == NULL ? 1 : 0;
}

void *fixture_ident_ptr(void *p) {
    return p;
}

const char *fixture_ret_cstring(void) {
    static const char text[] = "onde-ffi";
    return text;
}

/* ------------------------------------------------------------------ */
/* extreme 64-bit values                                               */
/* ------------------------------------------------------------------ */

int64_t fixture_ret_i64_min(void) {
    return INT64_MIN;
}

uint64_t fixture_ret_u64_max(void) {
    return UINT64_MAX;
}

/* ------------------------------------------------------------------ */
/* structs by value / out-param                                        */
/* ------------------------------------------------------------------ */

int32_t fixture_pair_sum(struct FixturePair pair) {
    return (int32_t)((uint32_t)pair.a + (uint32_t)pair.b);
}

struct FixturePair fixture_pair_make(int32_t a, int32_t b) {
    struct FixturePair out;
    out.a = a;
    out.b = b;
    return out;
}

/* Returns 0 on success, -1 when out is NULL (never dereferences NULL). */
int32_t fixture_pair_out(int32_t a, int32_t b, struct FixturePair *out) {
    if (out == NULL) {
        return -1;
    }
    out->a = a;
    out->b = b;
    return 0;
}

/*
 * Uses every field. c, i, d and s contribute their numeric value; p
 * contributes exactly 1.0 when non-NULL and 0.0 when NULL, so the expected
 * value does not depend on the address (and stays exact in a double).
 */
double fixture_mixed_weight(struct FixtureMixed m) {
    return (double)m.c + (double)m.i + m.d + (m.p != NULL ? 1.0 : 0.0) +
           (double)m.s;
}

/* Sum of the eight bytes plus n, wrapping modulo 2^32. */
int32_t fixture_array_sum(struct FixtureArray arr) {
    uint32_t acc = (uint32_t)arr.n;
    size_t i;
    for (i = 0; i < sizeof arr.bytes; i++) {
        acc += (uint32_t)arr.bytes[i];
    }
    return (int32_t)acc;
}

/* ------------------------------------------------------------------ */
/* callbacks                                                           */
/* ------------------------------------------------------------------ */

int32_t fixture_call_cb(int32_t (*cb)(int32_t, int32_t), int32_t a, int32_t b) {
    if (cb == NULL) {
        return 0;
    }
    return cb(a, b);
}

/* Calls cb(0) ... cb(n-1), exactly n times; returns 0 for NULL or n <= 0. */
int32_t fixture_call_cb_n(int32_t (*cb)(int32_t), int32_t n) {
    uint32_t acc = 0;
    int32_t i;
    if (cb == NULL || n <= 0) {
        return 0;
    }
    for (i = 0; i < n; i++) {
        acc += (uint32_t)cb(i);
    }
    return (int32_t)acc;
}

int32_t fixture_call_cb_ptrs(int32_t (*cb)(const int32_t *, const int32_t *),
                             int32_t a, int32_t b) {
    if (cb == NULL) {
        return 0;
    }
    return cb(&a, &b);
}

struct thread_callback {
    int32_t (*callback)(int32_t);
    int32_t value;
    int32_t result;
};

static void *invoke_on_foreign_thread(void *argument) {
    struct thread_callback *call = argument;
    call->result = call->callback(call->value);
    return NULL;
}

int32_t fixture_call_cb_thread(int32_t (*cb)(int32_t), int32_t v) {
    if (cb == NULL) {
        return 0;
    }
    struct thread_callback call = { cb, v, 0 };
    pthread_t thread;
    if (pthread_create(&thread, NULL, invoke_on_foreign_thread, &call) != 0) {
        return -1;
    }
    pthread_join(thread, NULL);
    return call.result;
}

/* ------------------------------------------------------------------ */
/* variadic                                                            */
/* ------------------------------------------------------------------ */

/*
 * count int32_t arguments follow the fixed one. int32_t promotes to int in a
 * variadic call, so each is read with va_arg(ap, int) on the targets in scope
 * (int is 32-bit on LP64). Sums wrap modulo 2^32.
 */
int32_t fixture_variadic_sum(int32_t count, ...) {
    va_list ap;
    uint32_t acc = 0;
    int32_t i;
    if (count <= 0) {
        return 0;
    }
    va_start(ap, count);
    for (i = 0; i < count; i++) {
        acc += (uint32_t)va_arg(ap, int);
    }
    va_end(ap);
    return (int32_t)acc;
}

/* ------------------------------------------------------------------ */
/* errno                                                               */
/* ------------------------------------------------------------------ */

void fixture_set_errno(int32_t value) {
    errno = (int)value;
}

int32_t fixture_get_errno(void) {
    return (int32_t)errno;
}

/* ------------------------------------------------------------------ */
/* allocation                                                          */
/* ------------------------------------------------------------------ */

void *fixture_alloc(size_t size) {
    return malloc(size);
}

void fixture_free(void *p) {
    free(p);
}

/* malloc()d and filled with 0,1,...,255,0,1,... (a byte pattern, not a string). */
void *fixture_alloc_buffer(size_t size) {
    unsigned char *buf = (unsigned char *)malloc(size);
    size_t i;
    if (buf == NULL) {
        return NULL;
    }
    for (i = 0; i < size; i++) {
        buf[i] = (unsigned char)(i & 0xffu);
    }
    return buf;
}

/* free() the pointer, count the release, remember the context. */
void fixture_release(void *ptr, void *context) {
    free(ptr);
    if (release_count < INT32_MAX) {
        release_count++;
    }
    release_context = context;
}

int32_t fixture_release_count(void) {
    return release_count;
}

/* Low 32 bits of the last context value, reinterpreted as int32_t. */
int32_t fixture_last_context(void) {
    return (int32_t)(uint32_t)((uintptr_t)release_context & 0xffffffffu);
}

/* ------------------------------------------------------------------ */
/* ABI tag read                                                        */
/* ------------------------------------------------------------------ */

/*
 * Reads the uint16_t family tag at offset 0 of addr, as a caller would read
 * struct FixtureSockaddr's (or FixtureSockaddrIn's) first member before
 * casting the same address to the concrete layout. memcpy() keeps this valid
 * for unaligned addresses. Returns -1 for NULL.
 */
int32_t fixture_sockaddr_family(const void *addr) {
    uint16_t family;
    if (addr == NULL) {
        return -1;
    }
    memcpy(&family, addr, sizeof family);
    return (int32_t)family;
}
