/*
 * fixture.h — the exported ABI of the onde:ffi test fixture library.
 *
 * These declarations are the test contract: the runtime dlopen()s the shared
 * library built from fixture.c and calls exactly these symbols through libffi
 * with exactly these signatures. test/ffi/layout.c prints the compiler's
 * sizeof/_Alignof/offsetof for the structs below so the host's computed layout
 * can be compared against the real compiler.
 *
 * Keep this header C11-clean and free of dependencies beyond <stddef.h> and
 * <stdint.h>; it is included by both the library and the oracle, and is built
 * by a bare `cc` with no include paths or build system.
 */

#ifndef ONDE_FFI_FIXTURE_H
#define ONDE_FFI_FIXTURE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- structs (layout measured by test/ffi/layout.c, never assumed) ---- */

struct FixturePair {
    int32_t a;
    int32_t b;
};

struct FixtureMixed {
    char c;
    int32_t i;
    double d;
    void *p;
    short s;
};

struct FixtureNested {
    struct FixturePair pair;
    int32_t tail;
};

struct FixtureArray {
    uint8_t bytes[8];
    int32_t n;
};

struct FixtureBig {
    double d;
    int64_t l;
    uint8_t u8;
    int16_t s16;
    float f32;
};

/* sockaddr-shaped structs for the cast/tag test (read the family tag through
 * FixtureSockaddr, then "cast" the same address to FixtureSockaddrIn). */
struct FixtureSockaddr {
    uint16_t family;
    char data[6];
};

struct FixtureSockaddrIn {
    uint16_t family;
    uint16_t port;
    uint32_t addr;
};

/* ---- exported data symbol (dlsym data-symbol test) ---- */

/* Starts at 7 and is writable; tests read and write it through dlsym. */
extern int32_t fixture_global_counter;

/* ---- scalar round-trips ---- */

int32_t fixture_add_i32(int32_t a, int32_t b);
int64_t fixture_add_i64(int64_t a, int64_t b);
uint64_t fixture_add_u64(uint64_t a, uint64_t b);
int64_t fixture_i64_ident(int64_t v);
uint64_t fixture_u64_ident(uint64_t v);
int32_t fixture_neg_i8(int8_t v);
uint32_t fixture_u32_ident(uint32_t v);

/* nine integer arguments: four in registers, five on the stack on SysV */
int32_t fixture_sum9(int32_t a, int32_t b, int32_t c, int32_t d, int32_t e,
                     int32_t f, int32_t g, int32_t h, int32_t i);

/* ---- floating point ---- */

double fixture_mul_f64(double a, double b);
float fixture_mul_f32(float a, float b);

/* ---- bool, strings, pointers ---- */

_Bool fixture_not_bool(_Bool v);
size_t fixture_cstrlen(const char *s); /* 0 for NULL */
int32_t fixture_is_null(const void *p); /* 1 when p == NULL, else 0 */
void *fixture_ident_ptr(void *p);
const char *fixture_ret_cstring(void); /* static "onde-ffi" */

/* ---- extreme 64-bit values ---- */

int64_t fixture_ret_i64_min(void);
uint64_t fixture_ret_u64_max(void);

/* ---- structs by value / out-param ---- */

int32_t fixture_pair_sum(struct FixturePair pair);
struct FixturePair fixture_pair_make(int32_t a, int32_t b);
int32_t fixture_pair_out(int32_t a, int32_t b, struct FixturePair *out);
double fixture_mixed_weight(struct FixtureMixed m);
int32_t fixture_array_sum(struct FixtureArray arr);

/* ---- callbacks ---- */

int32_t fixture_call_cb(int32_t (*cb)(int32_t, int32_t), int32_t a, int32_t b);
int32_t fixture_call_cb_n(int32_t (*cb)(int32_t), int32_t n);
int32_t fixture_call_cb_ptrs(int32_t (*cb)(const int32_t *, const int32_t *),
                             int32_t a, int32_t b);

/* ---- variadic ---- */

int32_t fixture_variadic_sum(int32_t count, ...);

/* ---- errno ---- */

void fixture_set_errno(int32_t value);
int32_t fixture_get_errno(void);

/* ---- allocation ---- */

void *fixture_alloc(size_t size);
void fixture_free(void *p);
void *fixture_alloc_buffer(size_t size); /* filled with 0,1,...,255,0,1,... */
void fixture_release(void *ptr, void *context);
int32_t fixture_release_count(void);
int32_t fixture_last_context(void);

/* ---- ABI tag read (uint16_t family at offset 0) ---- */

int32_t fixture_sockaddr_family(const void *addr);

#ifdef __cplusplus
}
#endif

#endif /* ONDE_FFI_FIXTURE_H */
