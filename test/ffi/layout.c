/*
 * layout.c — the C layout oracle for the onde:ffi tests.
 *
 * The host asks libffi for struct layouts; this program asks the real compiler,
 * so the JS test can compare the two. Nothing here assumes a layout: every
 * number comes from the compiler's sizeof/_Alignof/offsetof. That is why
 * running it on each 64-bit target (LP64 macOS and Linux) is the check for
 * `bytes`, `align`, `offsets` and `offsetOf`.
 *
 * Build and run (fixture.c is linked in only so the structs are compiled the
 * same way as the shared library; they are header definitions either way):
 *   cc -Wall -Wextra -o /tmp/layout test/ffi/layout.c test/ffi/fixture/fixture.c
 *   /tmp/layout
 *
 * Output, exactly one record per line, stable and easy to parse:
 *
 *   <struct> <sizeof> <align>     one line per struct
 *   <struct>.<field> <offset>     one line per field, in declaration order
 *   <scalar> <sizeof> <align>     char, short, int, long, longlong, float,
 *                                 double, pointer
 *
 * Every number is printed with %zu. Exit status 0.
 */

#include <stddef.h>
#include <stdio.h>

#include "fixture/fixture.h"

static void layout(const char *name, size_t size, size_t align) {
    printf("%s %zu %zu\n", name, size, align);
}

static void field(const char *name, const char *member, size_t offset) {
    printf("%s.%s %zu\n", name, member, offset);
}

int main(void) {
    /* structs: sizeof and _Alignof */
    layout("FixturePair", sizeof(struct FixturePair), _Alignof(struct FixturePair));
    layout("FixtureMixed", sizeof(struct FixtureMixed), _Alignof(struct FixtureMixed));
    layout("FixtureNested", sizeof(struct FixtureNested), _Alignof(struct FixtureNested));
    layout("FixtureArray", sizeof(struct FixtureArray), _Alignof(struct FixtureArray));
    layout("FixtureBig", sizeof(struct FixtureBig), _Alignof(struct FixtureBig));
    layout("FixtureSockaddr", sizeof(struct FixtureSockaddr),
           _Alignof(struct FixtureSockaddr));
    layout("FixtureSockaddrIn", sizeof(struct FixtureSockaddrIn),
           _Alignof(struct FixtureSockaddrIn));

    /* field offsets */
    field("FixturePair", "a", offsetof(struct FixturePair, a));
    field("FixturePair", "b", offsetof(struct FixturePair, b));

    field("FixtureMixed", "c", offsetof(struct FixtureMixed, c));
    field("FixtureMixed", "i", offsetof(struct FixtureMixed, i));
    field("FixtureMixed", "d", offsetof(struct FixtureMixed, d));
    field("FixtureMixed", "p", offsetof(struct FixtureMixed, p));
    field("FixtureMixed", "s", offsetof(struct FixtureMixed, s));

    field("FixtureNested", "pair", offsetof(struct FixtureNested, pair));
    field("FixtureNested", "tail", offsetof(struct FixtureNested, tail));

    field("FixtureArray", "bytes", offsetof(struct FixtureArray, bytes));
    field("FixtureArray", "n", offsetof(struct FixtureArray, n));

    field("FixtureBig", "d", offsetof(struct FixtureBig, d));
    field("FixtureBig", "l", offsetof(struct FixtureBig, l));
    field("FixtureBig", "u8", offsetof(struct FixtureBig, u8));
    field("FixtureBig", "s16", offsetof(struct FixtureBig, s16));
    field("FixtureBig", "f32", offsetof(struct FixtureBig, f32));

    field("FixtureSockaddr", "family", offsetof(struct FixtureSockaddr, family));
    field("FixtureSockaddr", "data", offsetof(struct FixtureSockaddr, data));

    field("FixtureSockaddrIn", "family", offsetof(struct FixtureSockaddrIn, family));
    field("FixtureSockaddrIn", "port", offsetof(struct FixtureSockaddrIn, port));
    field("FixtureSockaddrIn", "addr", offsetof(struct FixtureSockaddrIn, addr));

    /* scalar types */
    layout("char", sizeof(char), _Alignof(char));
    layout("short", sizeof(short), _Alignof(short));
    layout("int", sizeof(int), _Alignof(int));
    layout("long", sizeof(long), _Alignof(long));
    layout("longlong", sizeof(long long), _Alignof(long long));
    layout("float", sizeof(float), _Alignof(float));
    layout("double", sizeof(double), _Alignof(double));
    layout("pointer", sizeof(void *), _Alignof(void *));

    return 0;
}
