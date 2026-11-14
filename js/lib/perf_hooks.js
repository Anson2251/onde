"use strict";

// `perf_hooks` — User Timing marks/measures plus the monotonic clock.
//
// The engine already owns a monotonic `performance.now()`; this module wraps it so the object
// also carries Node's User Timing surface. The wrapper is installed as `globalThis.performance`
// (Node's global `performance` is the same object as `require("perf_hooks").performance`), which
// also fixes two engine differences: the engine's `timeOrigin` is the monotonic clock's origin
// in milliseconds, not the Unix epoch, and the engine object has no `mark`/`measure`.
//
// Approximations (documented in docs/compat.md, Tier 1 `perf_hooks`):
//
//   * `eventLoopUtilization()` has no libuv loop statistics to read. `active` accumulates
//     wall-clock time between calls measured with the monotonic clock; `idle` stays 0, so a
//     utilization is 1 whenever any time has passed at all. Treat it as "time since start",
//     not as the scheduler's duty cycle.
//   * `PerformanceObserver` never delivers entries (`observe()` records the options and
//     `takeRecords()` returns an empty array): entries are produced synchronously by mark/
//     measure and lite has no observer notification queue in M3.
//   * `performance.nodeTiming`, `timerify`, `monitorEventLoopDelay` and histograms are absent.
//   * `performance.toJSON()` exposes `timeOrigin` and `eventLoopUtilization` only.
//
// `hrtime` is exported for old callers even though Node 26 removed it; it simply delegates to
// `process.hrtime`, so `hrtime.bigint()` agrees with `process.hrtime.bigint()`.

const EXPORTS_PROPERTY = "__ln_perf_hooks_exports__";

// The engine's performance object, captured before `globalThis.performance` is replaced.
let enginePerformance = null;

function monotonicNow() {
  const engine = enginePerformance;
  if (engine !== null && typeof engine.now === "function") {
    try {
      const value = engine.now();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch (_) {
      // Fall through to the process clock.
    }
  }
  const proc = globalThis.process;
  if (proc && proc.hrtime && typeof proc.hrtime.bigint === "function") {
    return Number(proc.hrtime.bigint()) / 1e6;
  }
  return Date.now();
}

function codedTypeError(name, expected, actual) {
  let received;
  try {
    received = typeof actual === "string" ? `'${actual}'` : String(actual);
  } catch (_) {
    received = "<unprintable>";
  }
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${received}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validateName(name) {
  if (typeof name !== "string") throw codedTypeError("name", "string", name);
}

class PerformanceEntry {
  constructor(name, entryType, startTime, duration) {
    this.name = name;
    this.entryType = entryType;
    this.startTime = startTime;
    this.duration = duration;
    this.detail = null;
  }

  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail,
    };
  }
}

class PerformanceMark extends PerformanceEntry {
  constructor(name, startTime, detail) {
    super(name, "mark", startTime, 0);
    this.detail = detail === undefined ? null : detail;
  }
}

class PerformanceMeasure extends PerformanceEntry {
  constructor(name, startTime, duration, detail) {
    super(name, "measure", startTime, duration);
    this.detail = detail === undefined ? null : detail;
  }
}

const SUPPORTED_ENTRY_TYPES = ["mark", "measure"];

class PerformanceObserver {
  constructor(callback) {
    if (typeof callback !== "function") throw codedTypeError("callback", "function", callback);
    this._callback = callback;
    this._observing = false;
  }

  observe(options) {
    // Accepted and remembered, never fired: M3 has no observer queue (module comment).
    this._observing = options !== undefined && options !== null;
  }

  disconnect() {
    this._observing = false;
  }

  takeRecords() {
    return [];
  }

  static get supportedEntryTypes() {
    return SUPPORTED_ENTRY_TYPES.slice();
  }
}

function buildPerformance(timeOrigin, now) {
  const entries = [];
  const marks = () => entries.filter((entry) => entry.entryType === "mark");
  const findMark = (name) => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.entryType === "mark" && entry.name === name) return entry;
    }
    return null;
  };

  function resolveTime(value, argument) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        const error = new TypeError(`The "${argument}" argument must be a finite number`);
        error.code = "ERR_INVALID_ARG_TYPE";
        throw error;
      }
      return value;
    }
    if (typeof value === "string") {
      const mark = findMark(value);
      if (mark === null) {
        const error = new SyntaxError(`The "${value}" performance mark has not been set`);
        error.code = "ERR_PERF_MARK_NOT_FOUND";
        throw error;
      }
      return mark.startTime;
    }
    throw codedTypeError(argument, "number or string", value);
  }

  // `active` accumulates wall clock between samples; see the module comment.
  let active = 0;
  let idle = 0;
  let last = now();

  function sample() {
    const current = now();
    if (current > last) active += current - last;
    last = current;
    return utilizationFrom(idle, active);
  }

  function utilizationFrom(idleTime, activeTime) {
    const total = idleTime + activeTime;
    return {
      idle: idleTime,
      active: activeTime,
      utilization: total > 0 ? activeTime / total : 0,
    };
  }

  return class Performance {
    get timeOrigin() {
      return timeOrigin;
    }

    now() {
      return now();
    }

    mark(name, options) {
      validateName(name);
      let startTime = now();
      let detail = null;
      if (options !== undefined && options !== null && typeof options === "object") {
        if (options.startTime !== undefined) startTime = resolveTime(options.startTime, "startTime");
        if (options.detail !== undefined) detail = options.detail;
      }
      const entry = new PerformanceMark(name, startTime, detail);
      entries.push(entry);
      return entry;
    }

    measure(name, startOrOptions, endMark) {
      validateName(name);
      let startTime = 0;
      let endTime = now();
      let detail = null;

      if (typeof startOrOptions === "string") {
        startTime = resolveTime(startOrOptions, "startOrOptions");
        if (endMark !== undefined) endTime = resolveTime(endMark, "endMark");
      } else if (typeof startOrOptions === "number") {
        startTime = resolveTime(startOrOptions, "startOrOptions");
        if (endMark !== undefined) endTime = resolveTime(endMark, "endMark");
      } else if (startOrOptions !== undefined && startOrOptions !== null) {
        if (typeof startOrOptions !== "object") {
          throw codedTypeError("startOrOptions", "string or object", startOrOptions);
        }
        if (startOrOptions.detail !== undefined) detail = startOrOptions.detail;
        if (startOrOptions.start !== undefined) {
          startTime = resolveTime(startOrOptions.start, "start");
        }
        if (startOrOptions.duration !== undefined) {
          const duration = resolveTime(startOrOptions.duration, "duration");
          endTime = startTime + duration;
        } else if (startOrOptions.end !== undefined) {
          endTime = resolveTime(startOrOptions.end, "end");
        } else {
          endTime = now();
        }
      }

      const entry = new PerformanceMeasure(name, startTime, endTime - startTime, detail);
      entries.push(entry);
      return entry;
    }

    getEntries() {
      return entries.slice();
    }

    getEntriesByType(type) {
      if (typeof type !== "string") return [];
      return entries.filter((entry) => entry.entryType === type);
    }

    getEntriesByName(name, type) {
      if (typeof name !== "string") return [];
      return entries.filter(
        (entry) => entry.name === name && (type === undefined || entry.entryType === type),
      );
    }

    clearMarks(name) {
      if (name === undefined) {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index].entryType === "mark") entries.splice(index, 1);
        }
        return;
      }
      validateName(name);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.entryType === "mark" && entry.name === name) entries.splice(index, 1);
      }
    }

    clearMeasures(name) {
      if (name === undefined) {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index].entryType === "measure") entries.splice(index, 1);
        }
        return;
      }
      validateName(name);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.entryType === "measure" && entry.name === name) entries.splice(index, 1);
      }
    }

    clearResourceTimings() {
      // No resource entries exist; present so callers that clear unconditionally keep working.
    }

    setResourceTimingBufferSize() {
      // No resource entries exist.
    }

    eventLoopUtilization(utilization1, utilization2) {
      const current = sample();
      if (utilization1 !== undefined && utilization2 !== undefined) {
        return utilizationFrom(
          utilization2.idle - utilization1.idle,
          utilization2.active - utilization1.active,
        );
      }
      if (utilization1 !== undefined) {
        return utilizationFrom(
          current.idle - utilization1.idle,
          current.active - utilization1.active,
        );
      }
      return current;
    }

    toJSON() {
      return {
        timeOrigin,
        eventLoopUtilization: this.eventLoopUtilization(),
      };
    }
  };
}

// --- module evaluation ------------------------------------------------------------------------
//
// If another copy of this module already installed a performance object, re-export that module
// instead of replacing the global again: `require("perf_hooks")` and `globalThis.performance`
// must agree even when one was loaded as a builtin and the other from a file.

const previousGlobal =
  globalThis.performance !== undefined && globalThis.performance !== null
    ? globalThis.performance
    : null;

const alreadyInstalled =
  previousGlobal !== null &&
  Object.prototype.hasOwnProperty.call(previousGlobal, EXPORTS_PROPERTY);

if (alreadyInstalled) {
  module.exports = previousGlobal[EXPORTS_PROPERTY];
} else {
  // Capture the engine clock before the global is replaced. `previousGlobal` is the engine object
  // under lite; under a bare Node process it is Node's native Performance instance.
  enginePerformance = previousGlobal;
  const startMono = monotonicNow();
  const timeOrigin = Date.now() - startMono;

  const Performance = buildPerformance(timeOrigin, monotonicNow);
  const performance = new Performance();

  function eventLoopUtilization(utilization1, utilization2) {
    return performance.eventLoopUtilization(utilization1, utilization2);
  }

  function hrtime(previous) {
    const proc = globalThis.process;
    if (proc && typeof proc.hrtime === "function") return proc.hrtime(previous);
    const nanos = Math.round(monotonicNow() * 1e6);
    const delta =
      previous === undefined ? nanos : nanos - (previous[0] * 1e9 + previous[1]);
    return [Math.floor(delta / 1e9), delta % 1e9];
  }

  hrtime.bigint = function bigint() {
    const proc = globalThis.process;
    if (proc && proc.hrtime && typeof proc.hrtime.bigint === "function") {
      return proc.hrtime.bigint();
    }
    return BigInt(Math.round(monotonicNow() * 1e6));
  };

  const exported = {
    performance,
    Performance,
    PerformanceEntry,
    PerformanceMark,
    PerformanceMeasure,
    PerformanceObserver,
    eventLoopUtilization,
    hrtime,
  };

  Object.defineProperty(performance, EXPORTS_PROPERTY, {
    value: exported,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  try {
    globalThis.performance = performance;
  } catch (_) {
    // A frozen global object is not worth failing the module over; `perf_hooks.performance`
    // still exposes the wrapper.
  }

  module.exports = exported;
}
