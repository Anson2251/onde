"use strict";

// The `process` object, created by bootstrap.js after `events` is available.
//
// Kept out of bootstrap so the event-loop code there stays about scheduling. The factory takes
// the host primitives and an EventEmitter class: process is an EventEmitter in Node, and driver
// code (`uncaughtException` dispatch) relies on that.

// `process.exit` unwinds JavaScript with an uncatchable error (D15): the host records the exit
// code and stops the loop, and QuickJS skips user `catch` blocks during the unwind.
const EXIT_MESSAGE = "onde:process.exit";

function exitWith(host, code) {
    host.exit(code);
    const sentinel = new Error(EXIT_MESSAGE);
    sentinel.code = "ERR_PROCESS_EXIT";
    host.setUncatchable(sentinel);
    throw sentinel;
}

function validateExitCode(value) {
    let code = value;
    if (typeof code === "string" && code.trim() !== "") code = Number(code);
    if (typeof code !== "number" || Number.isNaN(code)) {
        const error = new TypeError(
            `The "code" argument must be of type integer. Received ${String(value)}`,
        );
        error.code = "ERR_INVALID_ARG_TYPE";
        throw error;
    }
    if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647) {
        const error = new RangeError(
            `The value of "code" is out of range. It must be an integer. Received ${String(value)}`,
        );
        error.code = "ERR_OUT_OF_RANGE";
        throw error;
    }
    return code;
}

// --- stdio -----------------------------------------------------------------------------------
//
// Node creates the standard streams lazily, and so does onde: `bootstrap.js` constructs
// `process` before the stdlib modules are loadable, and a program that never touches stdio
// should not pay for loading `stream` (and `tty` on a terminal). Each getter caches its stream
// and only calls `__ln_builtin_exports` on the first access. That hook is installed at the end
// of bootstrap, which is necessarily before user code can read `process.stdout`.
//
// `host.writeFd` is a synchronous whole-buffer write, so `_write` is synchronous and `end()`
// has nothing left to flush. Reads go through `__ln_op("read", [fd, length, -1])`; the op holds
// an external loop reference until it completes, which is what keeps the loop alive while
// stdin is open. An empty read means EOF (`push(null)`).

function requireBuiltin(name) {
    const load = globalThis.__ln_builtin_exports;
    if (typeof load !== "function") {
        // Only possible while bootstrap is still running. Let the caller fail with a useful
        // message rather than "load is not a function".
        throw new Error(`onde: the "${name}" builtin is not available during bootstrap`);
    }
    return load(name);
}

function isTerminal(host, fd) {
    if (fd !== 0 && fd !== 1 && fd !== 2) return false;
    try {
        return host.isTTY(fd) === true;
    } catch (_) {
        return false;
    }
}

function createOutput(host, fd) {
    if (isTerminal(host, fd)) {
        const tty = requireBuiltin("tty");
        const stream = new tty.WriteStream(fd);
        stream._isStdio = true;
        return stream;
    }
    const Writable = requireBuiltin("stream").Writable;
    const stream = new Writable({
        write(chunk, encoding, callback) {
            try {
                host.writeFd(fd, chunk);
                callback();
            } catch (error) {
                callback(error);
            }
        },
    });
    stream.fd = fd;
    stream.isTTY = false;
    stream._isStdio = true;
    return stream;
}

function createInput(host, fd) {
    if (isTerminal(host, fd)) {
        const tty = requireBuiltin("tty");
        const stream = new tty.ReadStream(fd);
        stream._isStdio = true;
        return stream;
    }
    const Readable = requireBuiltin("stream").Readable;
    // Node delivers pipe data as `Buffer`s, so `chunk + ""` is the bytes as text. The host read op
    // resolves with a plain `Uint8Array`, whose string form is "104,105,10". Wrap the same bytes in
    // a Buffer (no copy: the engine already copied the read into its own ArrayBuffer).
    const Buffer = requireBuiltin("buffer").Buffer;
    const stream = new Readable({
        highWaterMark: 64 * 1024,
        read(size) {
            const op = globalThis.__ln_op;
            if (typeof op !== "function") {
                stream.destroy(new Error("onde: async I/O (__ln_op) is unavailable"));
                return;
            }
            const length =
                typeof size === "number" && size > 0
                    ? Math.min(Math.floor(size), 1024 * 1024)
                    : 64 * 1024;
            let pending;
            try {
                pending = op("read", [fd, length, -1]);
            } catch (error) {
                stream.destroy(error);
                return;
            }
            pending.then(
                (chunk) => {
                    if (stream.destroyed) return;
                    if (chunk === undefined || chunk === null || chunk.length === 0) {
                        stream.push(null);
                        return;
                    }
                    stream.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    // The current `stream.js` fast path emits `data` from `push()` without re-arming the
                    // next pull, so a flowing fd stream would stop after one chunk. `read(0)` requests the
                    // next chunk only when nothing is buffered; it is a no-op once WP3 schedules that
                    // itself (or when the stream is paused and the buffer has data).
                    if (!stream.destroyed && stream.readableFlowing === true) stream.read(0);
                },
                (error) => {
                    if (!stream.destroyed) stream.destroy(error);
                },
            );
        },
    });
    stream.fd = fd;
    stream.isTTY = false;
    stream._isStdio = true;
    return stream;
}

module.exports = function createProcess(host, EventEmitter, scheduler) {
    const info = host.osInfo();
    const startNanos = BigInt(host.hrtimeNs());
    // Node starts with `process.exitCode === undefined`; it only becomes a number when set.
    let exitCodeValue;
    let title = "onde";

    class Process extends EventEmitter {
        constructor() {
            super();
            this.argv = host.argv.slice();
            this.execArgv = [];
            this.execPath = host.argv[0];
            this.env = host.env();
            // The IPC descriptor is an implementation detail of `fork`; Node does not expose it.
            delete this.env.ONDE_IPC_FD;
            // Read-only introspection: the matcher is in Rust, next to the gates it describes. The
            // object is present whether or not a policy is active, and `has` answers `true` when
            // nothing is enforced (ADR-0011 §5.9).
            this.permission = Object.freeze({
                has(scope, reference) {
                    if (typeof scope !== "string") {
                        const error = new TypeError(
                            `The "scope" argument must be of type string. Received ${typeof scope}`,
                        );
                        error.code = "ERR_INVALID_ARG_TYPE";
                        throw error;
                    }
                    if (reference !== undefined && typeof reference !== "string") {
                        const error = new TypeError(
                            `The "reference" argument must be of type string. Received ${typeof reference}`,
                        );
                        error.code = "ERR_INVALID_ARG_TYPE";
                        throw error;
                    }
                    return host.permissionHas(scope, reference);
                },
            });
            // Signal name -> number for every signal this process currently listens to.
            this._signals = new Map();
            this.platform = host.platform;
            this.arch = info.arch;
            this.pid = host.pid;
            this.ppid = host.ppid;
            // `version` is the Node release onde is compatible with, not onde's own version: tooling
            // gates on it and cannot do anything useful with "v0.1.0". onde's identity stays visible in
            // `versions.onde`.
            this.version = host.nodeVersion;
            this.versions = {
                node: host.nodeVersion.replace(/^v/, ""),
                onde: host.version.replace(/^v/, ""),
            };
            // `node:sqlite` reports the bundled SQLite, as Node reports its own.
            if (host.sqlite !== undefined && host.sqlite !== null) {
                this.versions.sqlite = host.sqlite.version();
            }
            this.release = { name: "node" };
            this.config = {};
            this.features = {};
            this.mainModule = undefined;
            this.allowedNodeEnvironmentFlags = new Set();
        }

        cwd() {
            return host.cwd();
        }

        chdir(directory) {
            if (typeof directory !== "string") {
                const error = new TypeError(
                    `The "directory" argument must be of type string. Received ${String(directory)}`,
                );
                error.code = "ERR_INVALID_ARG_TYPE";
                throw error;
            }
            host.chdir(directory);
        }

        nextTick(callback, ...args) {
            if (typeof callback !== "function") {
                const error = new TypeError(
                    `The "callback" argument must be of type function. Received ${String(callback)}`,
                );
                error.code = "ERR_INVALID_ARG_TYPE";
                throw error;
            }
            scheduler.nextTick(callback, args);
            return undefined;
        }

        // --- fork IPC (only present when this process is a forked child) --------------------------
        //
        // `fork` gives the child fd 3 and the runtime attaches it before user code runs. The protocol
        // is length-prefixed JSON frames; `process.send`/`message`/`disconnect` are the Node surface.

        _ipcInstall() {
            if (host.ipcFd === null || host.ipcFd === undefined) return;
            this.connected = true;
            this.channel = {
                ref: () => host.ipc("ref", []),
                unref: () => host.ipc("unref", []),
            };
            this.send = (message, sendHandle, options, callback) => {
                let done = callback;
                if (typeof sendHandle === "function") done = sendHandle;
                else if (typeof options === "function") done = options;
                if (!this.connected) {
                    if (typeof done === "function") {
                        const error = new Error("Channel closed");
                        error.code = "ERR_IPC_CHANNEL_CLOSED";
                        scheduler.nextTick(done, error);
                    }
                    return false;
                }
                let text;
                try {
                    text = JSON.stringify(message);
                } catch (error) {
                    const failure = new TypeError("The message cannot be serialized as JSON");
                    failure.code = "ERR_INVALID_ARG_TYPE";
                    throw failure;
                }
                if (text === undefined) {
                    const failure = new TypeError("The message cannot be serialized as JSON");
                    failure.code = "ERR_INVALID_ARG_TYPE";
                    throw failure;
                }
                try {
                    host.ipc("send", [text]);
                } catch (error) {
                    if (typeof done === "function") scheduler.nextTick(done, error);
                    return false;
                }
                if (typeof done === "function") scheduler.nextTick(done, null);
                return true;
            };
            this.disconnect = () => {
                if (!this.connected) return;
                host.ipc("disconnect", []);
                this.connected = false;
                this.emit("disconnect");
            };
            // Attaching reads fd 3 and starts the reader; messages are dispatched to `_ipcEvent`.
            host.ipc("attach", []);
        }

        _ipcEvent(name, payload) {
            if (name === "message") {
                let value;
                try {
                    value = JSON.parse(payload);
                } catch (error) {
                    this.emit("messageerror", error);
                    return;
                }
                this.emit("message", value);
                return;
            }
            if (name === "disconnect") {
                this.connected = false;
                this.emit("disconnect");
                return;
            }
            if (name === "error") {
                this.connected = false;
                this.emit("error", payload);
            }
        }

        exit(code) {
            const value =
                code === undefined
                    ? exitCodeValue === undefined
                        ? 0
                        : exitCodeValue
                    : validateExitCode(code);
            exitWith(host, value);
        }

        reallyExit(code) {
            this.exit(code);
        }

        abort() {
            host.exit(134);
            const sentinel = new Error(EXIT_MESSAGE);
            host.setUncatchable(sentinel);
            throw sentinel;
        }

        hrtime(previous) {
            let nanos = BigInt(host.hrtimeNs());
            if (previous !== undefined) {
                if (!Array.isArray(previous) || previous.length !== 2) {
                    const error = new TypeError(
                        'The "time" argument must be an instance of Array. Received ' +
                            String(previous),
                    );
                    error.code = "ERR_INVALID_ARG_TYPE";
                    throw error;
                }
                nanos -= BigInt(previous[0]) * 1000000000n + BigInt(previous[1]);
            }
            return [Number(nanos / 1000000000n), Number(nanos % 1000000000n)];
        }

        uptime() {
            return Number(BigInt(host.hrtimeNs()) - startNanos) / 1e9;
        }

        memoryUsage() {
            return host.memoryUsage();
        }

        cpuUsage(previous) {
            const current = host.cpuUsage();
            if (previous === undefined) return current;
            if (
                previous === null ||
                typeof previous !== "object" ||
                typeof previous.user !== "number" ||
                typeof previous.system !== "number"
            ) {
                const error = new TypeError(
                    'The "previousValue" argument must be an instance of Object',
                );
                error.code = "ERR_INVALID_ARG_TYPE";
                throw error;
            }
            return {
                user: current.user - previous.user,
                system: current.system - previous.system,
            };
        }

        kill(pid, signal) {
            return host.kill(pid, signal === undefined ? "SIGTERM" : signal);
        }

        // Signals are process-wide, so a listener is registered with the host when the first one for a
        // name appears and released when the last one goes (ADR-0008 §2.7). Every EventEmitter entry
        // point that can change the listener count must run `_updateSignal`.
        // `once` listeners are removed by EventEmitter itself, after `emit`; this hook notices that
        // and releases the host subscription (otherwise a second signal would be swallowed).
        emit(event, ...args) {
            const result = super.emit(event, ...args);
            if (typeof event === "string" && event.startsWith("SIG")) this._updateSignal(event);
            return result;
        }

        _updateSignal(event) {
            if (typeof event !== "string" || !event.startsWith("SIG")) return;
            const number = host.signalNumber(event);
            if (typeof number !== "number") return;
            const listening = this.listenerCount(event) > 0;
            const registered = this._signals.has(event);
            if (listening && !registered) {
                this._signals.set(event, number);
                host.signal(number, true);
            } else if (!listening && registered) {
                this._signals.delete(event);
                host.signal(number, false);
            }
        }

        on(event, listener) {
            super.on(event, listener);
            this._updateSignal(event);
            return this;
        }

        addListener(event, listener) {
            return this.on(event, listener);
        }

        prependListener(event, listener) {
            super.prependListener(event, listener);
            this._updateSignal(event);
            return this;
        }

        once(event, listener) {
            super.once(event, listener);
            this._updateSignal(event);
            return this;
        }

        prependOnceListener(event, listener) {
            super.prependOnceListener(event, listener);
            this._updateSignal(event);
            return this;
        }

        removeListener(event, listener) {
            super.removeListener(event, listener);
            this._updateSignal(event);
            return this;
        }

        off(event, listener) {
            return this.removeListener(event, listener);
        }

        removeAllListeners(event) {
            super.removeAllListeners(event);
            if (event === undefined) {
                for (const [, number] of this._signals) host.signal(number, false);
                this._signals.clear();
            } else {
                this._updateSignal(event);
            }
            return this;
        }

        getuid() {
            return info.uid;
        }

        getgid() {
            return info.gid;
        }

        geteuid() {
            return info.uid;
        }

        getegid() {
            return info.gid;
        }

        umask() {
            return 0;
        }

        emitWarning(warning, options) {
            let type = "Warning";
            let code;
            let detail;
            if (typeof options === "string") {
                type = options;
            } else if (options !== undefined && options !== null) {
                type = options.type || type;
                code = options.code;
                detail = options.detail;
            }
            const error = warning instanceof Error ? warning : new Error(String(warning));
            if (error.name === "Error") error.name = type;
            if (code !== undefined) error.code = code;
            if (detail !== undefined) error.detail = detail;
            if (this.listenerCount("warning") === 0) {
                host.write(`(onde:${this.pid}) ${error.name}: ${error.message}\n`, true);
            } else {
                this.emit("warning", error);
            }
        }
    }

    const process = new Process();
    process._ipcInstall();

    // Lazy stdio. The slots are writable so tests and embedders can substitute a stream (Node's
    // properties are getter-only; being permissive here keeps the console test seam working).
    const stdio = { stdin: undefined, stdout: undefined, stderr: undefined };

    function lazyStream(slot, create) {
        return {
            enumerable: true,
            configurable: true,
            get() {
                if (stdio[slot] === undefined) stdio[slot] = create();
                return stdio[slot];
            },
            set(value) {
                stdio[slot] = value;
            },
        };
    }

    Object.defineProperty(
        process,
        "stdout",
        lazyStream("stdout", () => createOutput(host, 1)),
    );
    Object.defineProperty(
        process,
        "stderr",
        lazyStream("stderr", () => createOutput(host, 2)),
    );
    Object.defineProperty(
        process,
        "stdin",
        lazyStream("stdin", () => createInput(host, 0)),
    );

    Object.defineProperty(process, "exitCode", {
        enumerable: true,
        configurable: true,
        get() {
            return exitCodeValue;
        },
        set(value) {
            exitCodeValue = validateExitCode(value);
            host.setExitCode(exitCodeValue);
        },
    });

    Object.defineProperty(process, "title", {
        enumerable: true,
        configurable: true,
        get() {
            return title;
        },
        set(value) {
            title = String(value);
        },
    });

    process.hrtime.bigint = function bigint() {
        return BigInt(host.hrtimeNs());
    };

    return process;
};
