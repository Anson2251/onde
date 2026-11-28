"use strict";

// `readline/promises` — the Promise-flavoured facade over `readline`.
//
// The interface object *is* a core `readline.Interface` (same events, same
// `[Symbol.asyncIterator]`, same prompt/history behaviour); only `question()` differs: it
// returns a Promise and accepts `{ signal }` instead of a callback. Keeping the core class
// as the base means there is exactly one line parser and one close path.
//
// `AbortError` mirrors Node's DOMException-shaped rejection (`name: "AbortError"`,
// `code: "ABORT_ERR"`). The core interface drops the pending question and moves the cursor to
// a new line on abort; the Promise rejects on the same signal.

// Resolve the sibling source so behaviour and state are ours, not Node's own `readline`.
const readline = require("./readline.js");
const { abortError } = require("./internal/errors.js");

function signalOf(options) {
    if (options === null || options === undefined || typeof options !== "object") return undefined;
    return options.signal;
}

class Interface extends readline.Interface {
    question(query, options) {
        return new Promise((resolve, reject) => {
            const signal = signalOf(options);
            let onAbort = null;

            if (signal !== undefined && signal !== null) {
                if (signal.aborted === true) {
                    reject(abortError(signal.reason));
                    return;
                }
                onAbort = () => {
                    reject(abortError(signal.reason));
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }

            const cleanup = () => {
                if (onAbort !== null && typeof signal.removeEventListener === "function") {
                    signal.removeEventListener("abort", onAbort);
                }
            };

            try {
                // The core method validates `closed`, restores the prompt and owns the answer path.
                readline.Interface.prototype.question.call(this, query, options, (answer) => {
                    cleanup();
                    resolve(answer);
                });
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }
}

function createInterface(input, output, completer, terminal) {
    return new Interface(input, output, completer, terminal);
}

module.exports = {
    Interface,
    createInterface,
};
