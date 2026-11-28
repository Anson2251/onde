"use strict";

// `onde:ffi` — dlopen-based FFI.
//
// The contract is docs/ffi-plan.md; the ABI lives in `crates/ln-ffi` and the JavaScript boundary
// in `crates/ln-runtime/src/host/ffi.rs`. This file owns everything a caller sees: the type
// vocabulary, `Ptr`, `Struct`, `Callback`, the argument inference rules, the JSON codecs and the
// error codes.
//
// Two properties are deliberate and load-bearing:
//
//   * Inference never guesses. A value that does not settle its own C type (a float-tagged number,
//     a struct instance, a bare function) throws `ERR_FFI_AMBIGUOUS_ARGUMENT` with the position.
//     A wrong marshalling decision is memory corruption, not a wrong answer.
//   * The host receives *plain* values only. `Ptr` becomes a BigInt, a struct becomes an array of
//     field values, a byte view stays a `Uint8Array`. The reverse conversion happens here, so the
//     host never needs to know about JavaScript wrappers.

const host = globalThis.__ln_host;
const ffiHost = host === undefined || host === null ? undefined : host.ffi;
if (ffiHost === undefined || ffiHost === null) {
    // The build has the feature off; resolution should have refused the module before this point.
    throw new Error("onde:ffi is not available: this runtime was built without the `ffi` feature");
}

const { Buffer } = require("buffer");
const { coded, invalidArgType, invalidArgValue } = require("./internal/errors.js");

// Pointer width and C `long` width are target facts. The host answers them so the type tokens do
// not hardcode LP64: LLP64 would give `cLong` 4 bytes, and a 32-bit target would give the pointer
// types 4.
const target = ffiHost.target();
const POINTER_BITS = target.pointerBits;
const LONG_BITS = target.longBits;
// The C library's soname differs by libc and OS. The host reports it so scripts do not hardcode
// `libc.dylib` or `libc.so.6`.
const LIBC_NAME = target.libcName;

// `--trace-ffi` / `ONDE_FFI_TRACE`: 0 off, 1 summary, 2 full. The host writes the log; this file
// only supplies the JavaScript frame, which the host cannot reconstruct.
const TRACE = target.trace | 0;

/// The first stack frame outside the builtin modules, as `file:line:column`.
function callerFrame() {
    if (TRACE === 0) return undefined;
    try {
        const stack = new Error().stack;
        if (typeof stack !== "string") return undefined;
        for (const line of stack.split("\n")) {
            const text = line.trim();
            if (!text.startsWith("at ")) continue;
            const match = /\((.*):(\d+):(\d+)\)$/.exec(text);
            if (match === null) continue;
            if (match[1].startsWith("<onde:") || match[1].startsWith("onde:")) continue;
            return `${match[1]}:${match[2]}:${match[3]}`;
        }
    } catch {
        // A trace must never turn a call into an exception.
    }
    return undefined;
}

const VALUES = Symbol("onde.ffi.struct.values");
const TYPED = Symbol("onde.ffi.typed");
const RAW = Symbol("onde.ffi.callback");
const RESERVED = new Set([
    "get",
    "set",
    "has",
    "size",
    "bytes",
    "keys",
    "values",
    "entries",
    "forEach",
    "toJSON",
    "toPlain",
    "then",
    "address",
    "toString",
    "constructor",
    "__proto__",
]);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

const typeObjects = []; // id -> JavaScript type object
const structLayouts = new WeakMap(); // class -> layout record
const builtinStructs = new Set(); // Struct.define results, for `isStructClass`
const codecs = new Map();

function ffiError(code, message) {
    return coded(Error, code, message);
}

function isType(value) {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        value.__ffiType === true
    );
}

function abiClass(type) {
    type = normalizeType(type);
    if (type === voidType) return "void";
    if (type === f32) return "f32";
    if (type === f64) return "f64";
    if (isPtrType(type) || type === cstring) return "pointer";
    if (type === bool) return "int:8";
    if (isScalarType(type)) return `int:${type.__bits}`;
    if (isCallbackType(type)) return "pointer";
    if (isStructClass(type)) return "struct";
    if (type.__ffiKind === "array") return "struct";
    return `other:${String(type)}`;
}

function sameAbiClass(a, b) {
    if (a === b) return true;
    if (a === "struct" || b === "struct") return false;
    return a === b;
}

function ensureRegistered(type, stack) {
    type = normalizeType(type);
    if (isStructClass(type)) {
        return layoutOf(type, stack).id;
    }
    if (type.__ffiId !== undefined) return type.__ffiId;
    const descriptor =
        type.__ffiDescriptor === undefined ? null : type.__ffiDescriptor(stack || new Set());
    if (descriptor === null) {
        throw invalidArgValue("type", String(type), "is not a registered FFI type");
    }
    const id = ffiHost.typeRegister(descriptor);
    Object.defineProperty(type, "__ffiId", { value: id, configurable: true });
    typeObjects[id] = type;
    return id;
}

function typeInfo(type) {
    const id = ensureRegistered(type);
    return ffiHost.typeInfo(id);
}

function makeTypeObject(name, kind, descriptor, extras) {
    const type = {
        __ffiType: true,
        __ffiKind: kind,
        __ffiDescriptor: descriptor,
        name,
    };
    Object.assign(type, extras || {});
    Object.defineProperties(type, {
        bytes: {
            enumerable: true,
            configurable: true,
            get() {
                return typeInfo(type).bytes;
            },
        },
        align: {
            enumerable: true,
            configurable: true,
            get() {
                return typeInfo(type).align;
            },
        },
    });
    // Not frozen: `__ffiId` is installed lazily on first registration.
    return type;
}

function normalizeType(type) {
    if (typeof type === "string") {
        const alias = ALIASES[type];
        if (alias === undefined) {
            throw invalidArgValue("type", type, "is not a known FFI type alias");
        }
        return alias;
    }
    if (isStructClass(type) || isType(type) || type === Callback || isCallbackType(type)) {
        return type;
    }
    throw invalidArgType("type", "an FFI type or Struct class", type);
}

// --- scalars ---------------------------------------------------------------------------------

function makeScalar(name, descriptor, bits, coerce, integer) {
    const type = function boxed(value) {
        if (typeof value === "object" && value !== null && value[TYPED] === true) return value;
        return Object.freeze({
            [TYPED]: true,
            __ffiTyped: true,
            type,
            value: coerce(name, value),
        });
    };
    Object.defineProperties(type, {
        __ffiType: { value: true },
        __ffiKind: { value: "scalar" },
        __bits: { value: bits },
        __integer: { value: integer === true },
        __signed: { value: descriptor.k === "int" ? descriptor.signed === true : false },
        __ffiDescriptor: { value: () => descriptor },
        // The coercion, without allocating the frozen boxed value the public boxer returns. The call
        // path runs this for every declared argument, so it is deliberately the hot form.
        __coerce: { value: (label, value) => coerce(label, value) },
        name: { value: name, enumerable: true },
        bytes: {
            enumerable: true,
            configurable: true,
            get() {
                return typeInfo(type).bytes;
            },
        },
        align: {
            enumerable: true,
            configurable: true,
            get() {
                return typeInfo(type).align;
            },
        },
    });
    return type;
}

function requireInteger(name, value) {
    if (typeof value === "bigint") {
        if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
            // Only the 64-bit boxers accept a BigInt directly; their range check is below.
            return value;
        }
        return Number(value);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw invalidArgValue(name, value, "must be an integer");
    }
    return value;
}

function makeIntBoxer(name, bits, signed) {
    const minimum = signed ? -(2 ** (bits - 1)) : 0;
    const maximum = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
    return makeScalar(
        name,
        { k: "int", bits, signed },
        bits,
        (label, value) => {
            if (bits === 64) {
                if (typeof value === "bigint") {
                    const low = signed ? -(2n ** 63n) : 0n;
                    const high = signed ? 2n ** 63n - 1n : 2n ** 64n - 1n;
                    if (value < low || value > high) {
                        throw invalidArgValue(label, value, `is outside ${name}'s range`);
                    }
                    return value;
                }
                if (typeof value === "number" && Number.isSafeInteger(value)) {
                    return BigInt(value);
                }
                throw invalidArgValue(
                    label,
                    value,
                    `must be a BigInt or a safe integer for ${name}`,
                );
            }
            const number = requireInteger(label, value);
            if (typeof number === "bigint") {
                if (number < BigInt(minimum) || number > BigInt(maximum)) {
                    throw invalidArgValue(label, value, `is outside ${name}'s range`);
                }
                return Number(number);
            }
            if (number < minimum || number > maximum) {
                throw invalidArgValue(label, value, `is outside ${name}'s range`);
            }
            return number;
        },
        true,
    );
}

const i8 = makeIntBoxer("i8", 8, true);
const i16 = makeIntBoxer("i16", 16, true);
const i32 = makeIntBoxer("i32", 32, true);
const i64 = makeIntBoxer("i64", 64, true);
const u8 = makeIntBoxer("u8", 8, false);
const u16 = makeIntBoxer("u16", 16, false);
const u32 = makeIntBoxer("u32", 32, false);
const u64 = makeIntBoxer("u64", 64, false);
const isize = makeIntBoxer("isize", POINTER_BITS, true);
const usize = makeIntBoxer("usize", POINTER_BITS, false);
const cLong = makeIntBoxer("cLong", LONG_BITS, true);

const f32 = makeScalar("f32", { k: "f32" }, 32, (label, value) => {
    if (typeof value !== "number") throw invalidArgType(label, "number", value);
    return Math.fround(value);
});
const f64 = makeScalar("f64", { k: "f64" }, 64, (label, value) => {
    if (typeof value !== "number") throw invalidArgType(label, "number", value);
    return value;
});
const bool = makeScalar(
    "bool",
    { k: "int", bits: 8, signed: false },
    8,
    (label, value) => {
        if (typeof value !== "boolean") throw invalidArgType(label, "boolean", value);
        return value;
    },
    true,
);
const cstring = makeTypeObject("cstring", "cstring", () => ({ k: "cstring" }));
const voidType = makeTypeObject("void", "void", () => ({ k: "void" }));

const ALIASES = {
    i8,
    i16,
    i32,
    i64,
    u8,
    u16,
    u32,
    u64,
    isize,
    usize,
    cLong,
    f32,
    f64,
    bool,
    cstring,
    void: voidType,
    voidType,
    ptr: null, // filled below once Ptr exists
};

function isScalarType(type) {
    return typeof type === "function" && type.__ffiKind === "scalar";
}

// --- pointers --------------------------------------------------------------------------------

function isPtrType(type) {
    return type === Ptr || (typeof type === "object" && type !== null && type.__ffiKind === "ptr");
}

function makePtrType(pointee) {
    const type = makeTypeObject(
        pointee === undefined || pointee === null ? "ptr" : `ptr<${typeName(pointee)}>`,
        "ptr",
        (stack) => ({
            k: "ptr",
            // A pointee that is currently being laid out (a by-pointer self-reference) is
            // informational only: the ABI is the same pointer either way.
            of:
                pointee === undefined || pointee === null
                    ? null
                    : stack && isStructClass(pointee) && stack.has(pointee)
                      ? null
                      : ensureRegistered(pointee, stack),
        }),
        {
            __pointee: pointee === undefined ? null : pointee,
            from(address) {
                return new Ptr(toAddress("address", address), type);
            },
        },
    );
    return type;
}

function typeName(type) {
    if (isStructClass(type)) return type.ffiName || type.name;
    if (typeof type === "object" && type !== null) return type.name || "type";
    if (typeof type === "function") return type.name || "type";
    return String(type);
}

class Ptr {
    constructor(address, type) {
        const value = toAddress("address", address);
        Object.defineProperties(this, {
            address: { value, enumerable: true },
            type: { value: type || Ptr, enumerable: false },
        });
    }

    static of(pointee) {
        return makePtrType(pointee === undefined ? null : pointee);
    }

    static from(address) {
        return new Ptr(address);
    }

    get hex() {
        return `0x${this.address.toString(16)}`;
    }

    add(offset) {
        return new Ptr(this.address + BigInt(Math.trunc(offset)), this.type);
    }

    deref() {
        const pointee = this.type === Ptr ? null : this.type.__pointee;
        if (pointee === null || pointee === undefined) {
            throw ffiError(
                "ERR_FFI_UNSUPPORTED_LAYOUT",
                "deref() needs a typed pointer: Ptr.of(T)",
            );
        }
        return fromHost(pointee, ffiHost.read(ensureRegistered(pointee), this.address, 0));
    }

    toString() {
        return `Ptr(${this.hex})`;
    }

    [Symbol.toPrimitive]() {
        return this.address;
    }
}

Object.defineProperties(Ptr, {
    __ffiType: { value: true },
    __ffiKind: { value: "ptr" },
    __pointee: { value: null },
    __ffiDescriptor: { value: () => ({ k: "ptr", of: null }) },
    // The bare type answers the same questions as every other type (§3).
    bytes: {
        enumerable: true,
        configurable: true,
        get() {
            return typeInfo(Ptr).bytes;
        },
    },
    align: {
        enumerable: true,
        configurable: true,
        get() {
            return typeInfo(Ptr).align;
        },
    },
});

ALIASES.ptr = Ptr;

// --- arrays ----------------------------------------------------------------------------------

function makeArrayType(element, count) {
    element = normalizeType(element);
    if (!Number.isInteger(count) || count <= 0) {
        throw invalidArgValue("count", count, "must be a positive integer");
    }
    return makeTypeObject(
        `array<${typeName(element)};${count}>`,
        "array",
        (stack) => ({
            k: "array",
            of: ensureRegistered(element, stack),
            count,
        }),
        {
            __element: element,
            __count: count,
            length: count,
        },
    );
}

const CArray = {
    of(element, count) {
        return makeArrayType(element, count);
    },
};

// --- callbacks -------------------------------------------------------------------------------

function callbackType(args, ret) {
    const argTypes = (args || []).map(normalizeType);
    const retType = normalizeType(ret === undefined ? voidType : ret);
    return makeTypeObject(
        "callback",
        "callback",
        (stack) => ({
            k: "callback",
            args: argTypes.map((type) => ensureRegistered(type, stack)),
            ret: ensureRegistered(retType, stack),
        }),
        {
            __args: argTypes,
            __ret: retType,
        },
    );
}

function isCallbackType(type) {
    return typeof type === "object" && type !== null && type.__ffiKind === "callback";
}

class Callback {
    constructor(fn, options) {
        if (typeof fn !== "function") throw invalidArgType("fn", "function", fn);
        const settings = options === undefined ? {} : options;
        const argTypes = (settings.args || []).map(normalizeType);
        const retType = normalizeType(settings.ret === undefined ? voidType : settings.ret);
        if (settings.threadsafe) {
            throw ffiError(
                "ERR_FFI_UNSUPPORTED_THREADSAFE",
                "threadsafe callbacks are not implemented in v1; call back on the isolate thread",
            );
        }
        const wrapper = (plain) => {
            const args = plain.map((value, index) => fromHost(argTypes[index], value));
            const result = fn(...args);
            // A void callback produces no value; asking the coercion table for one would throw.
            if (retType === voidType) return null;
            return toHost(retType, result, "callback return");
        };
        const { id, address } = ffiHost.callback(
            argTypes.map((type) => ensureRegistered(type)),
            ensureRegistered(retType),
            false,
            wrapper,
        );
        Object.defineProperties(this, {
            [RAW]: { value: { id, closed: false } },
            __args: { value: argTypes, enumerable: false },
            __ret: { value: retType, enumerable: false },
            __type: { value: callbackType(argTypes, retType), enumerable: false },
            address: { value: address, enumerable: false },
            ptr: { value: address === 0n ? null : new Ptr(address, Ptr), enumerable: true },
        });
    }

    static of(args, ret) {
        return callbackType(args, ret);
    }

    close() {
        const raw = this[RAW];
        if (raw.closed) return;
        raw.closed = true;
        ffiHost.callbackClose(raw.id);
    }

    [Symbol.dispose]() {
        this.close();
    }
}

Object.defineProperties(Callback, {
    __ffiType: { value: true },
    __ffiKind: { value: "ptr" },
    __pointee: { value: null },
    __ffiDescriptor: { value: () => ({ k: "ptr", of: null }) },
    bytes: {
        enumerable: true,
        configurable: true,
        get() {
            return typeInfo(Callback).bytes;
        },
    },
    align: {
        enumerable: true,
        configurable: true,
        get() {
            return typeInfo(Callback).align;
        },
    },
});

const buffer = makeTypeObject("buffer", "buffer", () => ({ k: "ptr", of: null }), {
    __argumentOnly: true,
});
const buffer_length = makeTypeObject(
    "buffer_length",
    "buffer_length",
    () => ({ k: "int", bits: POINTER_BITS, signed: false }),
    {
        __argumentOnly: true,
    },
);
// Deno spells these as type tokens too; the string aliases are resolved by `normalizeType`.
ALIASES.buffer = buffer;
ALIASES.buffer_length = buffer_length;

// ---------------------------------------------------------------------------------------------
// Addresses and plain-value conversion
// ---------------------------------------------------------------------------------------------

function toAddress(label, value) {
    if (value instanceof Ptr) return value.address;
    if (typeof value === "bigint") {
        if (value < 0n) throw invalidArgValue(label, value, "must not be negative");
        return value;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return BigInt(value);
    }
    throw invalidArgType(label, "Ptr, BigInt or non-negative integer", value);
}

/// A pointer argument must be explicit: a `Ptr`, a `Callback`, a `ref` handle, a BigInt address or
/// null. Plain numbers are accepted by `read`/`toArrayBuffer` for convenience, but not here: a
/// bare number is how a typo becomes a segfault (the lab report's D1).
function pointerArgument(label, value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Ptr) return value.address;
    if (value instanceof Callback) return value.address;
    if (isRefHandle(value)) return value.address;
    if (typeof value === "bigint") {
        if (value < 0n) throw invalidArgValue(label, value, "must not be negative");
        return value;
    }
    throw invalidArgType(label, "Ptr, Callback, ref, BigInt or null", value);
}

function isTypedValue(value) {
    return typeof value === "object" && value !== null && value[TYPED] === true;
}

function isStructInstance(value) {
    return value instanceof Struct;
}

function isRefHandle(value) {
    return typeof value === "object" && value !== null && value.__ffiRef === true;
}

function isView(value) {
    return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value);
}

function byteView(value) {
    // A fresh Uint8Array over the same bytes; the host needs one typed array kind.
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function ptr(view) {
    if (view instanceof Ptr) return view;
    if (!isView(view)) {
        throw invalidArgType("view", "TypedArray or DataView", view);
    }
    return new Ptr(ffiHost.pointer(byteView(view)), Ptr);
}

/// Convert a JavaScript value to the plain form the host understands for `type`.
function toHost(type, value, label) {
    label = label || "argument";
    if (isTypedValue(value)) {
        // A boxed value is a type assertion: a pointer box can never fill an integer slot.
        const boxedClass = abiClass(value.type);
        const wantedClass = abiClass(type);
        if ((boxedClass === "pointer") !== (wantedClass === "pointer") && boxedClass !== "void") {
            throw ffiError(
                "ERR_FFI_SIGNATURE_CONFLICT",
                `${label}: a ${typeName(value.type)} box cannot fill a ${typeName(type)} parameter`,
            );
        }
        value = value.value;
    }
    if (type === buffer) {
        // A view is the common form; an explicit Ptr/ref keeps a pointer resolved once.
        if (isView(value)) return ffiHost.pointer(byteView(value));
        return pointerArgument(label, value);
    }
    if (type === buffer_length) {
        // The paired view still supplies its byte length; a pointer pair passes the length itself.
        if (isView(value)) return value.byteLength;
        return usize.__coerce(label, value);
    }
    if (isStructClass(type)) {
        return structToPlain(type, value, label);
    }
    if (type.__ffiKind === "array") {
        return arrayToPlain(type, value, label);
    }
    if (isCallbackType(type)) {
        return callbackAddress(label, value);
    }
    if (type === Callback || isPtrType(type)) {
        if (value instanceof Callback) return callbackAddress(label, value);
        return pointerArgument(label, value);
    }
    if (type === cstring) {
        if (value === null) return null;
        if (typeof value === "string") return value;
        return pointerArgument(label, value);
    }
    if (type === bool) {
        if (typeof value !== "boolean") throw invalidArgType(label, "boolean", value);
        return value;
    }
    if (type === f32 || type === f64) {
        if (typeof value !== "number") throw invalidArgType(label, "number", value);
        return value;
    }
    if (type === voidType) {
        throw invalidArgValue(label, value, "cannot be passed to a void parameter");
    }
    if (isScalarType(type)) {
        return type.__coerce(label, value);
    }
    throw invalidArgType(label, "an FFI type", type);
}

function callbackAddress(label, value) {
    if (value instanceof Callback) {
        if (value[RAW].closed) {
            throw ffiError("ERR_FFI_CLOSED", `${label}: this callback has been closed`);
        }
        return value.address;
    }
    return pointerArgument(label, value);
}

function arrayToPlain(type, value, label) {
    if (value === null || value === undefined) {
        throw invalidArgType(label, "array", value);
    }
    const count = type.__count;
    const element = type.__element;
    if (isView(value)) {
        if (element === u8 || element === i8) {
            const bytes = byteView(value);
            if (bytes.byteLength !== count) {
                throw invalidArgValue(
                    label,
                    value,
                    `must have exactly ${count} bytes for ${typeName(type)} (got ${bytes.byteLength})`,
                );
            }
            if (element === u8) return bytes.slice();
            return Array.from(bytes, (byte) => (byte << 24) >> 24);
        }
        if (!Number.isInteger(value.length) || value.length !== count) {
            throw invalidArgValue(
                label,
                value,
                `must have exactly ${count} elements for ${typeName(type)}`,
            );
        }
        return Array.from({ length: count }, (_, index) =>
            toHost(element, value[index], `${label}[${index}]`),
        );
    }
    if (!Array.isArray(value)) throw invalidArgType(label, "array", value);
    if (value.length !== count) {
        throw invalidArgValue(label, value, `must have exactly ${count} elements`);
    }
    return value.map((item, index) => toHost(element, item, `${label}[${index}]`));
}

function structToPlain(cls, value, label) {
    const record = layoutOf(cls);
    let source = value;
    if (value === null || value === undefined) {
        throw invalidArgType(label, `an instance of ${cls.name}`, value);
    }
    if (isStructInstance(value)) {
        source = value[VALUES];
    } else if (typeof value !== "object") {
        throw invalidArgType(label, `an instance or initializer for ${cls.name}`, value);
    }
    return record.names.map((name, index) =>
        toHost(record.types[index], source[name], `${label}.${name}`),
    );
}

function fromHost(type, value) {
    if (value === undefined) return undefined;
    if (isStructClass(type)) {
        return structFromPlain(type, value);
    }
    if (type.__ffiKind === "array") {
        const element = type.__element;
        if ((element === u8 || element === i8) && (value instanceof Uint8Array || value === null)) {
            return value === null ? new Uint8Array(0) : value;
        }
        return Array.isArray(value) ? value.map((item) => fromHost(element, item)) : value;
    }
    if (isCallbackType(type)) {
        return callbackFromAddress(value, type.__args, type.__ret);
    }
    if (type === Callback || isPtrType(type)) {
        if (value === null || value === 0n || value === 0) return null;
        return new Ptr(value, type);
    }
    if (type === cstring) {
        if (value === null || value === 0n || value === 0) return null;
        return value;
    }
    if (type === bool) return Boolean(value);
    if (type === voidType) return undefined;
    if (isScalarType(type)) {
        if (type.__integer === true && type.__bits === 64) {
            return typeof value === "bigint" ? value : BigInt(value);
        }
        return value;
    }
    return value;
}

function structFromPlain(cls, value) {
    const record = layoutOf(cls);
    const instance = Object.create(cls.prototype);
    Object.defineProperty(instance, VALUES, {
        value: Object.create(null),
        enumerable: false,
    });
    const fields = Array.isArray(value) ? value : record.names.map((name) => value[name]);
    for (let index = 0; index < record.names.length; index += 1) {
        const name = record.names[index];
        instance[VALUES][name] = fromHost(record.types[index], fields[index]);
    }
    return instance;
}

function callbackFromAddress(address, args, ret) {
    const targetAddress =
        address === null || address === undefined ? 0n : toAddress("address", address);
    if (targetAddress === 0n) return null;
    const call = (...callArgs) => {
        const types = args;
        if (callArgs.length !== types.length) {
            throw coded(
                Error,
                "ERR_FFI_MISSING_ARGUMENT",
                `callback pointer expects ${types.length} arguments, got ${callArgs.length}`,
            );
        }
        const plain = callArgs.map((value, index) =>
            toHost(types[index], value, `argument ${index}`),
        );
        const result = ffiHost.callAt(
            targetAddress,
            types.map((type) => ensureRegistered(type)),
            plain,
            ensureRegistered(ret),
            { shape: types.map(typeName).join(",") },
        );
        return fromHost(ret, result);
    };
    Object.defineProperties(call, {
        address: { value: targetAddress, enumerable: false },
        ptr: { value: new Ptr(targetAddress, Ptr), enumerable: true },
    });
    return call;
}

// ---------------------------------------------------------------------------------------------
// Struct
// ---------------------------------------------------------------------------------------------

function defaultFor(type) {
    if (isStructClass(type)) return new type();
    if (type.__ffiKind === "array") {
        if (type.__element === u8 || type.__element === i8) return new Uint8Array(type.__count);
        return Array.from({ length: type.__count }, () => defaultFor(type.__element));
    }
    if (type === bool) return false;
    if (type === cstring) return null;
    if (isPtrType(type) || isCallbackType(type) || type === Callback) return null;
    if (isScalarType(type)) {
        return type.__integer === true && type.__bits === 64 ? 0n : 0;
    }
    if (type === voidType) return undefined;
    return null;
}

function validateFieldTable(fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
        throw invalidArgValue(
            "fields",
            fields,
            "must be a non-empty array of [name, type, count?]",
        );
    }
    const names = [];
    const seen = new Set();
    for (const field of fields) {
        if (!Array.isArray(field) || (field.length !== 2 && field.length !== 3)) {
            throw invalidArgValue("fields", field, "must be [name, type] or [name, type, count]");
        }
        const [name, type, count] = field;
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw invalidArgValue("field name", name, "must be a C identifier");
        }
        if (seen.has(name)) {
            throw invalidArgValue("field name", name, "is declared twice");
        }
        seen.add(name);
        normalizeType(type);
        if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
            throw invalidArgValue("field count", count, "must be a positive integer");
        }
        names.push(name);
    }
    return names;
}

function isStructClass(type) {
    return (
        typeof type === "function" &&
        (type === Struct || type.prototype instanceof Struct || builtinStructs.has(type))
    );
}

function layoutOf(cls, stack) {
    if (!isStructClass(cls)) {
        throw invalidArgType("type", "a Struct class", cls);
    }
    const cached = structLayouts.get(cls);
    if (cached !== undefined) return cached;
    const active = stack || new Set();
    if (active.has(cls)) {
        throw ffiError(
            "ERR_FFI_RECURSIVE_STRUCT",
            `${cls.name} contains itself by value; use Ptr.of(${cls.name}) instead`,
        );
    }
    if (!Array.isArray(cls.fields) || cls.fields.length === 0) {
        throw invalidArgValue("fields", cls.fields, `${cls.name}.fields must be a non-empty array`);
    }
    const names = validateFieldTable(cls.fields);
    const types = [];
    active.add(cls);
    try {
        const fieldIds = cls.fields.map(([, type, count]) => {
            const resolved = count === undefined ? normalizeType(type) : makeArrayType(type, count);
            types.push(resolved);
            return ensureRegistered(resolved, active);
        });
        const info = ffiHost.structType(fieldIds, cls.ffiName || cls.name, names);
        const record = {
            id: info.id,
            bytes: info.bytes,
            align: info.align,
            offsets: info.offsets,
            names,
            types,
            index: new Map(names.map((name, index) => [name, index])),
            ffiName: cls.ffiName || cls.name,
            viewProto: null,
            viewPointerType: null,
            accessors: false,
        };
        structLayouts.set(cls, record);
        defineAccessors(cls, record);
        return record;
    } finally {
        active.delete(cls);
    }
}

function defineAccessors(cls, record) {
    if (record.accessors) return;
    record.accessors = true;
    for (const name of record.names) {
        if (RESERVED.has(name)) continue;
        Object.defineProperty(cls.prototype, name, {
            enumerable: true,
            configurable: true,
            get() {
                return this[VALUES][name];
            },
            set(value) {
                this.set(name, value);
            },
        });
    }
}

class Struct {
    constructor(initializer) {
        if (new.target === Struct) {
            throw coded(
                TypeError,
                "ERR_FFI_UNSUPPORTED_LAYOUT",
                "create a subclass or use Struct.define",
            );
        }
        const record = layoutOf(new.target);
        Object.defineProperty(this, VALUES, {
            value: Object.create(null),
            enumerable: false,
        });
        for (const name of record.names) {
            this[VALUES][name] = defaultFor(record.types[record.index.get(name)]);
        }
        if (initializer !== undefined && initializer !== null) {
            if (typeof initializer !== "object") {
                throw invalidArgType("initializer", "object", initializer);
            }
            for (const key of Object.keys(initializer)) {
                this.set(key, initializer[key]);
            }
        }
    }

    static define(fields, options) {
        const settings = options === undefined ? {} : options;
        const cls = class extends Struct {};
        Object.defineProperty(cls, "name", {
            value: settings.name === undefined ? "Struct" : String(settings.name),
            configurable: true,
        });
        Object.defineProperty(cls, "fields", { value: fields, configurable: true });
        if (settings.ffiName !== undefined) {
            Object.defineProperty(cls, "ffiName", {
                value: String(settings.ffiName),
                configurable: true,
            });
        }
        builtinStructs.add(cls);
        return cls;
    }

    static get ffiName() {
        return this.name;
    }

    static get bytes() {
        return layoutOf(this).bytes;
    }

    static get align() {
        return layoutOf(this).align;
    }

    static get offsets() {
        return Object.freeze(layoutOf(this).offsets.slice());
    }

    static get fieldCount() {
        return layoutOf(this).names.length;
    }

    static offsetOf(name) {
        const record = layoutOf(this);
        const index = record.index.get(name);
        if (index === undefined) {
            throw invalidArgValue("name", name, `is not a field of ${this.name}`);
        }
        return record.offsets[index];
    }

    static fieldOf(name) {
        const record = layoutOf(this);
        const index = record.index.get(name);
        if (index === undefined) {
            throw invalidArgValue("name", name, `is not a field of ${this.name}`);
        }
        const type = record.types[index];
        return {
            name,
            type,
            offset: record.offsets[index],
            bytes: type === voidType ? 0 : typeInfo(type).bytes,
            align: type === voidType ? 1 : typeInfo(type).align,
        };
    }

    static fromJSON(json) {
        return fromJSONValue(this, json);
    }

    static get codecs() {
        return codecs;
    }

    static codec(name, codec) {
        if (typeof name !== "string" || name.length === 0) {
            throw invalidArgType("name", "non-empty string", name);
        }
        if (
            codec === null ||
            typeof codec !== "object" ||
            typeof codec.encode !== "function" ||
            typeof codec.decode !== "function"
        ) {
            throw invalidArgType("codec", "object with encode() and decode()", codec);
        }
        codecs.set(name, codec);
        return Struct;
    }

    static view(address) {
        return makeView(this, toAddress("address", address));
    }

    get bytes() {
        return layoutOf(this.constructor).bytes;
    }

    get size() {
        return layoutOf(this.constructor).names.length;
    }

    has(name) {
        return layoutOf(this.constructor).index.has(name);
    }

    get(name) {
        const record = layoutOf(this.constructor);
        const index = record.index.get(name);
        if (index === undefined) {
            throw invalidArgValue("name", name, `is not a field of ${this.constructor.name}`);
        }
        return this[VALUES][name];
    }

    set(name, value) {
        const record = layoutOf(this.constructor);
        const index = record.index.get(name);
        if (index === undefined) {
            throw invalidArgValue("name", name, `is not a field of ${this.constructor.name}`);
        }
        const type = record.types[index];
        this[VALUES][name] = coerceField(type, value, name);
        return this;
    }

    *keys() {
        yield* layoutOf(this.constructor).names;
    }

    *values() {
        for (const name of layoutOf(this.constructor).names) yield this[VALUES][name];
    }

    *entries() {
        for (const name of layoutOf(this.constructor).names) {
            yield [name, this[VALUES][name]];
        }
    }

    forEach(fn, thisArg) {
        for (const [name, value] of this.entries()) fn.call(thisArg, value, name, this);
    }

    [Symbol.iterator]() {
        return this.entries();
    }

    toJSON() {
        const record = layoutOf(this.constructor);
        const out = {};
        for (let index = 0; index < record.names.length; index += 1) {
            const name = record.names[index];
            out[name] = encodeJSON(record.types[index], this[VALUES][name]);
        }
        return out;
    }

    toPlain() {
        const record = layoutOf(this.constructor);
        const out = {};
        for (let index = 0; index < record.names.length; index += 1) {
            const name = record.names[index];
            out[name] = plainValue(record.types[index], this[VALUES][name]);
        }
        return out;
    }
}

function coerceField(type, value, name) {
    if (isStructClass(type)) {
        if (value instanceof type) return value;
        if (value !== null && typeof value === "object" && !isStructInstance(value)) {
            return new type(value);
        }
        throw invalidArgType(name, `an instance of ${type.name}`, value);
    }
    if (type.__ffiKind === "array") {
        const count = type.__count;
        const element = type.__element;
        if (isView(value)) {
            if (element === u8 || element === i8) {
                const bytes = byteView(value);
                if (bytes.byteLength !== count) {
                    throw invalidArgValue(name, value, `needs exactly ${count} bytes`);
                }
                if (element === u8) return new Uint8Array(bytes);
                return Array.from(bytes, (byte) => (byte << 24) >> 24);
            }
            if (!Number.isInteger(value.length) || value.length !== count) {
                throw invalidArgValue(name, value, `needs exactly ${count} elements`);
            }
            return Array.from({ length: count }, (_, index) =>
                coerceField(element, value[index], name),
            );
        }
        if (!Array.isArray(value) || value.length !== count) {
            throw invalidArgValue(name, value, `needs exactly ${count} elements`);
        }
        return value.map((item) => coerceField(element, item, name));
    }
    if (type === bool) {
        if (typeof value !== "boolean") throw invalidArgType(name, "boolean", value);
        return value;
    }
    if (type === cstring) {
        if (value === null || typeof value === "string" || value instanceof Ptr) return value;
        throw invalidArgType(name, "string, Ptr or null", value);
    }
    if (isPtrType(type) || isCallbackType(type) || type === Callback) {
        if (
            value === null ||
            value instanceof Ptr ||
            value instanceof Callback ||
            isRefHandle(value)
        ) {
            return value;
        }
        throw invalidArgType(name, "Ptr or null", value);
    }
    if (type === voidType) throw invalidArgValue(name, value, "cannot be stored in a void field");
    if (isScalarType(type)) {
        return type(value).value;
    }
    throw invalidArgType(name, "an FFI type", type);
}

// --- views -----------------------------------------------------------------------------------

function makeView(cls, address) {
    const record = layoutOf(cls);
    if (record.viewProto === null) {
        const proto = Object.create(null);
        for (let index = 0; index < record.names.length; index += 1) {
            const name = record.names[index];
            if (RESERVED.has(name)) continue;
            const type = record.types[index];
            const offset = record.offsets[index];
            Object.defineProperty(proto, name, {
                enumerable: true,
                configurable: true,
                get() {
                    return viewRead(this, type, offset);
                },
                set(value) {
                    viewWrite(this, type, offset, value, name);
                },
            });
        }
        record.viewProto = proto;
    }
    const pointerType = record.viewPointerType || (record.viewPointerType = Ptr.of(cls));
    const view = Object.create(record.viewProto);
    Object.defineProperties(view, {
        address: { value: new Ptr(address, pointerType), enumerable: true },
        bytes: { value: record.bytes, enumerable: true },
        __ffiClass: { value: cls, enumerable: false },
        get: {
            value(name) {
                const index = record.index.get(name);
                if (index === undefined) {
                    throw invalidArgValue("name", name, `is not a field of ${cls.name}`);
                }
                return viewRead(this, record.types[index], record.offsets[index]);
            },
            enumerable: false,
        },
        set: {
            value(name, value) {
                const index = record.index.get(name);
                if (index === undefined) {
                    throw invalidArgValue("name", name, `is not a field of ${cls.name}`);
                }
                viewWrite(this, record.types[index], record.offsets[index], value, name);
                return this;
            },
            enumerable: false,
        },
        has: {
            value(name) {
                return record.index.has(name);
            },
            enumerable: false,
        },
        toJSON: {
            value() {
                const out = {};
                for (let index = 0; index < record.names.length; index += 1) {
                    out[record.names[index]] = encodeJSON(
                        record.types[index],
                        viewRead(view, record.types[index], record.offsets[index]),
                    );
                }
                return out;
            },
            enumerable: false,
        },
    });
    return view;
}

function viewRead(view, type, offset) {
    const base = view.address.address;
    if (isStructClass(type)) {
        return makeView(type, base + BigInt(offset));
    }
    if (type.__ffiKind === "array") {
        return makeArrayView(view, type, offset);
    }
    const value = ffiHost.read(ensureRegistered(type), base, offset);
    return fromHost(type, value);
}

function viewWrite(view, type, offset, value, name) {
    const base = view.address.address;
    if (type === cstring) {
        throw ffiError(
            "ERR_FFI_UNSUPPORTED_LAYOUT",
            "a cstring field cannot be written through a view (the bytes would have no owner)",
        );
    }
    ffiHost.write(ensureRegistered(type), base, offset, toHost(type, value, name));
}

function makeArrayView(view, type, offset) {
    const count = type.__count;
    const element = type.__element;
    const elementBytes = typeInfo(element).bytes;
    const base = view.address.address + BigInt(offset);
    const read = (index) => {
        if (!Number.isInteger(index) || index < 0 || index >= count) return undefined;
        if (isStructClass(element)) {
            return makeView(element, base + BigInt(index * elementBytes));
        }
        return fromHost(
            element,
            ffiHost.read(ensureRegistered(element), base, index * elementBytes),
        );
    };
    const write = (index, value) => {
        if (!Number.isInteger(index) || index < 0 || index >= count) {
            throw invalidArgValue("index", index, `must be within 0..${count - 1}`);
        }
        ffiHost.write(
            ensureRegistered(element),
            base,
            index * elementBytes,
            toHost(element, value, `[${index}]`),
        );
    };
    const arrayView = {
        length: count,
        get(index) {
            return read(index);
        },
        set(index, value) {
            write(index, value);
            return this;
        },
        toJSON() {
            return Array.from({ length: count }, (_, index) => read(index));
        },
    };
    return new Proxy(arrayView, {
        get(object, property) {
            if (typeof property === "string" && /^(0|[1-9][0-9]*)$/.test(property)) {
                return read(Number(property));
            }
            return object[property];
        },
        set(object, property, value) {
            if (typeof property === "string" && /^(0|[1-9][0-9]*)$/.test(property)) {
                write(Number(property), value);
                return true;
            }
            object[property] = value;
            return true;
        },
    });
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

function isBigIntType(type) {
    return isScalarType(type) && type.__integer === true && type.__bits === 64;
}

function shouldEnvelopeFloat(value) {
    return typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0));
}

function floatEnvelope(value) {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return "-0";
}

function encodeJSON(type, value) {
    if (value === null || value === undefined) return null;
    if (isStructClass(type)) return value.toJSON();
    if (type.__ffiKind === "array") {
        if (type.__element === u8) {
            return { $onde: { t: "u8array", v: Buffer.from(value).toString("base64") } };
        }
        return Array.from(value, (item) => encodeJSON(type.__element, item));
    }
    if (isBigIntType(type)) {
        return { $onde: { t: "bigint", v: value.toString() } };
    }
    if ((type === f64 || type === f32) && shouldEnvelopeFloat(value)) {
        return { $onde: { t: "f64", v: floatEnvelope(value) } };
    }
    if (isPtrType(type) || isCallbackType(type) || type === Callback) {
        if (value instanceof Ptr) return { $onde: { t: "ptr", v: value.hex } };
        if (value instanceof Callback)
            return { $onde: { t: "ptr", v: `0x${value.address.toString(16)}` } };
        return null;
    }
    if (type === cstring) return value;
    if (type === bool) return value;
    if (type === voidType) return null;
    return value;
}

function plainValue(type, value) {
    if (value === null || value === undefined) return null;
    if (isStructClass(type)) return value.toPlain();
    if (type.__ffiKind === "array") {
        if (type.__element === u8) return Buffer.from(value).toString("base64");
        return Array.from(value, (item) => plainValue(type.__element, item));
    }
    if (isBigIntType(type)) {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    if (isPtrType(type) || isCallbackType(type) || type === Callback) {
        if (value instanceof Ptr) return value.hex;
        if (value instanceof Callback) return `0x${value.address.toString(16)}`;
        return null;
    }
    return value;
}

function decodeEnvelope(envelope) {
    if (envelope === null || typeof envelope !== "object") return envelope;
    const tag = envelope.$onde;
    if (tag === null || typeof tag !== "object") {
        throw ffiError("ERR_FFI_UNKNOWN_CODEC", "a $onde envelope must carry an object");
    }
    if (tag.t === "ptr") {
        throw ffiError("ERR_FFI_NOT_REVIVABLE", "pointers are encode-only; they are never revived");
    }
    const codec = codecs.get(tag.t);
    if (codec === undefined) {
        throw ffiError("ERR_FFI_UNKNOWN_CODEC", `no codec is registered for "${tag.t}"`);
    }
    return codec.decode(tag.v);
}

function fromJSONValue(cls, json) {
    if (json === null || typeof json !== "object") {
        throw invalidArgType("json", "object", json);
    }
    const record = layoutOf(cls);
    const instance = new cls();
    for (let index = 0; index < record.names.length; index += 1) {
        const name = record.names[index];
        if (!(name in json)) continue;
        instance[VALUES][name] = decodeField(record.types[index], json[name], name);
    }
    return instance;
}

function decodeField(type, value, name) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        if ("$onde" in value) {
            value = decodeEnvelope(value);
        } else if (isStructClass(type)) {
            return fromJSONValue(type, value);
        }
    }
    if (isStructClass(type)) {
        if (value instanceof type) return value;
        if (value !== null && typeof value === "object") return fromJSONValue(type, value);
        throw invalidArgType(name, `an object or ${type.name} instance`, value);
    }
    if (type.__ffiKind === "array") {
        if (type.__element === u8) {
            if (value instanceof Uint8Array) return new Uint8Array(value);
            if (Array.isArray(value)) return Uint8Array.from(value);
            throw invalidArgType(name, "Uint8Array or byte array", value);
        }
        if (!Array.isArray(value)) throw invalidArgType(name, "array", value);
        return value.map((item, index) => decodeField(type.__element, item, `${name}[${index}]`));
    }
    if (isBigIntType(type)) {
        if (typeof value === "bigint") return value;
        if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
        if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
        throw invalidArgType(name, "BigInt or integer", value);
    }
    if (type === bool) {
        if (typeof value !== "boolean") throw invalidArgType(name, "boolean", value);
        return value;
    }
    if (type === f32 || type === f64) {
        if (typeof value !== "number") throw invalidArgType(name, "number", value);
        return value;
    }
    if (type === cstring) {
        if (value === null || typeof value === "string") return value;
        throw invalidArgType(name, "string or null", value);
    }
    if (isPtrType(type) || isCallbackType(type)) {
        if (value === null) return null;
        throw ffiError(
            "ERR_FFI_NOT_REVIVABLE",
            `field "${name}" is a pointer and cannot be revived`,
        );
    }
    return coerceField(type, value, name);
}

function revive(json) {
    if (Array.isArray(json)) return json.map(revive);
    if (json === null || typeof json !== "object") return json;
    if ("$onde" in json) return decodeEnvelope(json);
    const out = {};
    for (const key of Object.keys(json)) out[key] = revive(json[key]);
    return out;
}

function installBuiltinCodecs() {
    Struct.codec("bigint", {
        encode: (value) => value.toString(),
        decode: (value) => BigInt(value),
    });
    Struct.codec("f64", {
        encode: (value) => floatEnvelope(value),
        decode: (value) => {
            if (value === "NaN") return NaN;
            if (value === "Infinity") return Infinity;
            if (value === "-Infinity") return -Infinity;
            if (value === "-0") return -0;
            throw ffiError("ERR_FFI_UNKNOWN_CODEC", `unknown f64 envelope value "${value}"`);
        },
    });
    Struct.codec("u8array", {
        encode: (value) => Buffer.from(value).toString("base64"),
        decode: (value) => new Uint8Array(Buffer.from(value, "base64")),
    });
    Struct.codec("ptr", {
        encode: (value) => (value instanceof Ptr ? value.hex : value),
        decode: () => {
            throw ffiError("ERR_FFI_NOT_REVIVABLE", "pointers are encode-only");
        },
    });
}

// ---------------------------------------------------------------------------------------------
// dlopen and calls
// ---------------------------------------------------------------------------------------------

const i32Default = i32;

/// Argument types the host can coerce directly from the rest array.
///
/// `bool` stays out because the host's scalar entries do not distinguish `bool` from `u8`; the
/// JavaScript coercion keeps `true`/`false` strict.
function isDirectArgumentType(type) {
    return type !== bool && (isScalarType(type) || type === cstring || isPtrType(type));
}

/// Coerce declared arguments to the plain form for `callPlan` when a wrapper is involved.
function marshalPlanArgs(declaration, args) {
    if (args.length !== declaration.args.length) {
        throw coded(
            Error,
            "ERR_FFI_MISSING_ARGUMENT",
            `symbol takes ${declaration.args.length} arguments, got ${args.length}`,
        );
    }
    const plain = new Array(declaration.args.length);
    for (let index = 0; index < declaration.args.length; index += 1) {
        plain[index] = toHost(declaration.args[index], args[index], `argument ${index}`);
    }
    return plain;
}

function inferArgument(value, position) {
    if (value === undefined) {
        throw coded(
            Error,
            "ERR_FFI_MISSING_ARGUMENT",
            `argument ${position} is undefined; pass null for a null pointer`,
        );
    }
    if (value === null) return { type: Ptr, value: null };
    if (isTypedValue(value)) return { type: value.type, value: value.value };
    if (value instanceof Ptr) return { type: value.type, value: value };
    if (value instanceof Callback) return { type: value.__type, value };
    if (isRefHandle(value)) return { type: Ptr, value };
    if (typeof value === "string") return { type: cstring, value };
    if (typeof value === "boolean") return { type: bool, value };
    if (typeof value === "bigint") return { type: i64, value };
    if (typeof value === "number") {
        // §4.3: the QuickJS tag is a provenance signal. Only an int-tagged number infers i32; a
        // float-tagged one (including `w * 0.5`) is refused.
        const tag = ffiHost.numberTag(value);
        if (tag === 0) return { type: i32, value };
        throw ambiguousArgument(position, "a float-tagged number is never inferred");
    }
    if (isView(value)) return { type: buffer, value };
    if (typeof value === "function") {
        throw ambiguousArgument(
            position,
            "a bare function is ambiguous; wrap it in new Callback(fn, { args, ret })",
        );
    }
    if (isStructInstance(value)) {
        throw ambiguousArgument(
            position,
            "a struct instance is ambiguous by value or by pointer; declare Ptr.of(T) or use ref(T)",
        );
    }
    throw ambiguousArgument(position, `a value of type ${typeof value} has no C type`);
}

function ambiguousArgument(position, reason) {
    return coded(
        Error,
        "ERR_FFI_AMBIGUOUS_ARGUMENT",
        `cannot infer the C type of argument ${position}: ${reason}`,
    );
}

function promoteVariadic(type) {
    // C's default argument promotions for a variadic tail (§4.6).
    if (type === f32) return f64;
    if (isScalarType(type) && type.__integer === true && type.__bits < 32) {
        return i32;
    }
    return type;
}

function resolveArguments(values, declared, options) {
    const ids = [];
    const plain = [];
    const types = [];
    if (declared) {
        const fixed = declared.args.length;
        if (declared.varargs) {
            if (values.length < fixed) {
                throw coded(
                    Error,
                    "ERR_FFI_MISSING_ARGUMENT",
                    `variadic symbol needs at least ${fixed} fixed arguments, got ${values.length}`,
                );
            }
        } else if (values.length !== fixed) {
            throw coded(
                Error,
                "ERR_FFI_MISSING_ARGUMENT",
                `symbol takes ${fixed} arguments, got ${values.length}`,
            );
        }
        for (let index = 0; index < values.length; index += 1) {
            let type;
            let value = values[index];
            if (index < declared.args.length) {
                type = declared.args[index];
                // `buffer_length` is usually passed the same view as its `buffer` partner; a pointer
                // pair passes the length explicitly instead.
                if (type === buffer_length) {
                    plain.push(toHost(buffer_length, value, `argument ${index}`));
                    ids.push(ensureRegistered(usize));
                    types.push(usize);
                    continue;
                }
            } else {
                const inferred = inferArgument(value, index);
                type = promoteVariadic(inferred.type);
                value = inferred.value;
            }
            plain.push(toHost(type, value, `argument ${index}`));
            ids.push(ensureRegistered(type === buffer || type === buffer_length ? Ptr : type));
            types.push(type === buffer || type === buffer_length ? Ptr : type);
        }
        return { ids, plain, types };
    }
    const varargs = options && options.varargs !== undefined ? options.varargs : undefined;
    const fixed = varargs === true ? 1 : typeof varargs === "number" ? varargs : 0;
    for (let index = 0; index < values.length; index += 1) {
        const inferred = inferArgument(values[index], index);
        const type =
            varargs !== undefined && index >= fixed
                ? promoteVariadic(inferred.type)
                : inferred.type;
        let hostValue = inferred.value;
        if (type === buffer) {
            hostValue = toHost(buffer, hostValue, `argument ${index}`);
        } else {
            hostValue = toHost(type, hostValue, `argument ${index}`);
        }
        plain.push(hostValue);
        ids.push(ensureRegistered(type === buffer ? Ptr : type));
        types.push(type === buffer ? Ptr : type);
    }
    return { ids, plain, types };
}

function shapeOf(types) {
    // Ids, not names: two different struct classes can share a `.name`, and a shape collision
    // would hand one symbol's plan to the other's ABI.
    return types.map((type) => ensureRegistered(type)).join(",");
}

function resolveReturn(declared, explicitRet) {
    if (explicitRet === undefined || explicitRet === null) {
        return declared === undefined ? i32Default : declared.ret;
    }
    const ret = normalizeType(explicitRet);
    if (declared === undefined) return ret;
    const wanted = abiClass(ret);
    const actual = abiClass(declared.ret);
    if (!sameAbiClass(wanted, actual)) {
        throw ffiError(
            "ERR_FFI_SIGNATURE_CONFLICT",
            `symbol is declared to return ${typeName(declared.ret)}, and ${typeName(ret)} is not ` +
                "ABI-compatible; only a same-class refinement is allowed",
        );
    }
    if (isStructClass(ret) && ret !== declared.ret) {
        throw ffiError(
            "ERR_FFI_SIGNATURE_CONFLICT",
            "a struct return may only be refined to the declared class",
        );
    }
    return ret;
}

function parseOptions(options) {
    if (options === undefined || options === null) return {};
    if (typeof options !== "object") throw invalidArgType("options", "object", options);
    return options;
}

function openLibrary(path, declarations, options) {
    if (typeof path !== "string") throw invalidArgType("path", "string", path);
    const settings = options === undefined || options === null ? {} : options;
    if (typeof settings !== "object") throw invalidArgType("options", "object", options);
    // Deno's names are accepted when the onde names are absent. `strict` resolves every declared
    // symbol at dlopen instead of waiting for the first call.
    const strict = settings.strict === true;
    const handle = ffiHost.load(path);
    const declared = Object.create(null);
    try {
        if (declarations !== undefined && declarations !== null) {
            if (typeof declarations !== "object") {
                throw invalidArgType("declarations", "object", declarations);
            }
            for (const name of Object.keys(declarations)) {
                const declaration = declarations[name];
                if (declaration === null || typeof declaration !== "object") {
                    throw invalidArgType(`declarations.${name}`, "object", declaration);
                }
                const argSpec =
                    declaration.args === undefined ? declaration.parameters : declaration.args;
                const args = (argSpec || []).map(normalizeType);
                validateBufferPairing(name, args);
                const retSpec =
                    declaration.ret === undefined ? declaration.result : declaration.ret;
                const ret = normalizeType(retSpec === undefined ? i32Default : retSpec);
                const varargs = declaration.varargs === true;
                const argIds = args.map((type) => ensureRegistered(type === buffer ? Ptr : type));
                const planId = ffiHost.declare(
                    handle,
                    name,
                    argIds,
                    ensureRegistered(ret),
                    varargs,
                    strict,
                );
                // The shape is fixed by the declaration; computing it once keeps the per-call path free of
                // a join for the common (declared) case. The host prepares a plan too: a non-variadic
                // declaration can then call `callPlan`, which skips the argument-id vector, shape string
                // and options object on every call.
                declared[name] = {
                    args,
                    ret,
                    varargs,
                    planId,
                    direct: args.every(isDirectArgumentType),
                    shape: args
                        .map((type) => ensureRegistered(type === buffer ? Ptr : type))
                        .join(","),
                };
            }
        }
    } catch (error) {
        // A declaration error must not leave the image mapped; nothing can call it yet.
        try {
            ffiHost.close(handle);
        } catch {
            // The original error is the useful one.
        }
        throw error;
    }
    let closed = false;
    const assertOpen = () => {
        if (closed) throw ffiError("ERR_FFI_CLOSED", `library ${path} is closed`);
    };

    function invokePlan(declaration, values, frame) {
        const plain = declaration.direct ? values : marshalPlanArgs(declaration, values);
        return fromHost(
            declaration.ret,
            ffiHost.callPlan(handle, declaration.planId, plain, frame),
        );
    }

    function planCaller(declaration) {
        // The direct branch is inlined: this is the per-call path for declared scalar symbols.
        if (declaration.direct) {
            return (...args) => {
                const frame = TRACE === 0 ? undefined : callerFrame();
                return fromHost(
                    declaration.ret,
                    ffiHost.callPlan(handle, declaration.planId, args, frame),
                );
            };
        }
        return (...args) => invokePlan(declaration, args, TRACE === 0 ? undefined : callerFrame());
    }

    function call(name, args, ret, opts) {
        assertOpen();
        const frame = TRACE === 0 ? undefined : callerFrame();
        if (typeof name !== "string") throw invalidArgType("name", "string", name);
        if (strict && declared[name] === undefined) {
            throw ffiError(
                "ERR_FFI_UNDECLARED",
                `symbol "${name}" has no declaration; strict dlopen refuses inferred calls`,
            );
        }
        let values;
        if (args === undefined || args === null) {
            values = [];
        } else if (Array.isArray(args)) {
            values = args;
        } else if (typeof args[Symbol.iterator] === "function") {
            values = Array.from(args);
        } else {
            throw invalidArgType("args", "an iterable of argument values", args);
        }
        const callOptions = parseOptions(opts);
        const declaration = declared[name];
        if (
            declaration !== undefined &&
            declaration.planId > 0 &&
            !declaration.varargs &&
            callOptions.varargs === undefined &&
            (ret === undefined ||
                ret === null ||
                (typeof ret === "string" ? normalizeType(ret) : ret) === declaration.ret)
        ) {
            return invokePlan(declaration, values, frame);
        }
        const { ids, plain, types } = resolveArguments(values, declaration, callOptions);
        const retType = resolveReturn(declaration, ret);
        // A declared variadic symbol has a fixed prefix but a per-call tail; the plan key must see
        // the tail types or the first tail's frame would be reused for a different argument list.
        const shape =
            declaration === undefined || declaration.varargs ? shapeOf(types) : declaration.shape;
        const result = ffiHost.call(handle, name, ids, plain, ensureRegistered(retType), {
            shape,
            varargs: callOptions.varargs === true ? 1 : callOptions.varargs,
            frame,
        });
        return fromHost(retType, result);
    }

    const fnCache = new Map();
    function fn(name, ret, opts) {
        assertOpen();
        if (strict && declared[name] === undefined) {
            throw ffiError(
                "ERR_FFI_UNDECLARED",
                `symbol "${name}" has no declaration; strict dlopen refuses inferred calls`,
            );
        }
        const fnOptions = parseOptions(opts);
        const key = `${name}\u0000${
            ret === undefined ? "" : ensureRegistered(normalizeType(ret))
        }\u0000${fnOptions.varargs === undefined ? "" : String(fnOptions.varargs)}`;
        let cached = fnCache.get(key);
        if (cached === undefined) {
            const declaration = declared[name];
            const explicitRet = ret === undefined || ret === null ? undefined : normalizeType(ret);
            if (
                declaration !== undefined &&
                declaration.planId > 0 &&
                !declaration.varargs &&
                fnOptions.varargs === undefined &&
                (explicitRet === undefined || explicitRet === declaration.ret)
            ) {
                cached = planCaller(declaration);
            } else {
                cached = (...args) => call(name, args, ret, fnOptions);
            }
            fnCache.set(key, cached);
        }
        return cached;
    }

    const symbols = {};
    for (const name of Object.keys(declared)) {
        const declaration = declared[name];
        if (declaration.planId > 0) {
            // A plan prepared at dlopen. Direct argument types are handed to the host raw; the host
            // coerces them against the plan's entries. Structs, buffers, bool and callbacks keep the
            // JavaScript coercion because the host cannot see those wrappers (or their closed state).
            symbols[name] = planCaller(declaration);
        } else {
            symbols[name] = (...args) => call(name, args);
        }
    }

    function address(name) {
        assertOpen();
        if (typeof name !== "string") throw invalidArgType("name", "string", name);
        return new Ptr(ffiHost.address(handle, name));
    }

    function close() {
        if (closed) return;
        // The host refuses while a deallocator-backed external buffer is live; the error is thrown
        // from here with `ERR_FFI_LIVE_REFERENCES`.
        ffiHost.close(handle);
        closed = true;
    }

    return {
        path,
        symbols,
        call,
        fn,
        address,
        close,
        get closed() {
            return closed;
        },
    };
}

function validateBufferPairing(name, args) {
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === buffer_length) {
            if (index === 0 || args[index - 1] !== buffer) {
                throw ffiError(
                    "ERR_FFI_UNSUPPORTED_LAYOUT",
                    `declaration for "${name}" has buffer_length at position ${index} without an ` +
                        "immediately preceding buffer",
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// ref, read, CString, toArrayBuffer
// ---------------------------------------------------------------------------------------------

const registry =
    typeof FinalizationRegistry === "function"
        ? new FinalizationRegistry((address) => {
              try {
                  ffiHost.free(address);
              } catch {
                  // A finalizer must not throw.
              }
          })
        : null;

function ref(type) {
    const resolved = normalizeType(type);
    const bytes = typeInfo(resolved).bytes;
    const address = ffiHost.allocZeroed(bytes);
    let freed = false;
    const handle = {
        __ffiRef: true,
        address,
        bytes,
        get value() {
            return fromHost(resolved, ffiHost.read(ensureRegistered(resolved), address, 0));
        },
        set value(next) {
            ffiHost.write(ensureRegistered(resolved), address, 0, toHost(resolved, next, "value"));
        },
        free() {
            if (freed) return;
            freed = true;
            if (registry !== null) registry.unregister(handle);
            ffiHost.free(address);
        },
        [Symbol.dispose]() {
            handle.free();
        },
    };
    if (registry !== null) registry.register(handle, address, handle);
    return handle;
}

function readAt(type, address, offset) {
    const base = toAddress("address", address);
    return fromHost(type, ffiHost.read(ensureRegistered(type), base, offset || 0));
}

const read = {};
for (const [name, type] of [
    ["i8", i8],
    ["i16", i16],
    ["i32", i32],
    ["i64", i64],
    ["u8", u8],
    ["u16", u16],
    ["u32", u32],
    ["u64", u64],
    ["isize", isize],
    ["usize", usize],
    ["cLong", cLong],
    ["f32", f32],
    ["f64", f64],
]) {
    read[name] = (address, offset) => readAt(type, address, offset);
}
read.ptr = (address, offset) => readAt(Ptr, address, offset);
read.cstring = (address, offset) => {
    const base = toAddress("address", address);
    const value = ffiHost.cstring(base, offset || 0, null);
    return value === null ? null : value;
};

function CString(address, offset, length) {
    const base = toAddress("address", address);
    if (length !== undefined && length !== null) {
        if (!Number.isInteger(length) || length < 0) {
            throw invalidArgValue("length", length, "must be a non-negative integer");
        }
    }
    const value = ffiHost.cstring(base, offset || 0, length === undefined ? null : length);
    if (value === null) {
        throw ffiError("ERR_FFI_INVALID_ADDRESS", "CString cannot read from a null pointer");
    }
    return value;
}

function toArrayBuffer(address, offset, length, deallocator, context) {
    const base = toAddress("address", address);
    const shift = offset === undefined ? 0 : offset;
    const size = length === undefined ? 0 : length;
    if (!Number.isInteger(shift) || shift < 0) {
        throw invalidArgValue("offset", offset, "must be a non-negative integer");
    }
    if (!Number.isInteger(size) || size < 0) {
        throw invalidArgValue("length", length, "must be a non-negative integer");
    }
    const release =
        deallocator === undefined || deallocator === null
            ? 0n
            : deallocator instanceof Ptr
              ? deallocator.address
              : toAddress("deallocator", deallocator);
    const payload =
        context === undefined || context === null
            ? 0n
            : context instanceof Ptr
              ? context.address
              : toAddress("context", context);
    return ffiHost.toArrayBuffer(base + BigInt(shift), size, release, payload);
}

function errno() {
    return ffiHost.errno();
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

installBuiltinCodecs();

module.exports = {
    dlopen: openLibrary,
    Struct,
    Ptr,
    CArray,
    Callback,
    ref,
    revive,
    errno,
    libcName: LIBC_NAME,
    ptr,
    read,
    toArrayBuffer,
    CString,
    voidType,
    i8,
    i16,
    i32,
    i64,
    u8,
    u16,
    u32,
    u64,
    isize,
    usize,
    cLong,
    f32,
    f64,
    bool,
    cstring,
    buffer,
    buffer_length,
};
