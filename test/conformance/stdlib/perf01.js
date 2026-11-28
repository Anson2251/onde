"use strict";
// Deterministic User Timing surface: marks/measures with explicit timestamps, listing, clearing,
// observer shape, and the clock/timeOrigin types. No raw timing is printed, so the expectation is
// valid on any machine (recorded from node v26.10.0).
const {
    performance,
    Performance,
    PerformanceMark,
    PerformanceMeasure,
    PerformanceObserver,
} = require("perf_hooks");
const mark = performance.mark("conf-mark", { startTime: 10, detail: 3 });
console.log(mark.name, mark.entryType, mark.startTime, mark.duration, mark.detail);
console.log(mark instanceof PerformanceMark, mark instanceof PerformanceMeasure);
performance.mark("conf-end", { startTime: 25 });
const measure = performance.measure("conf-measure", "conf-mark", "conf-end");
console.log(measure.name, measure.entryType, measure.startTime, measure.duration, measure.detail);
console.log(measure instanceof PerformanceMeasure, performance instanceof Performance);
const options = performance.measure("conf-options", { start: 5, end: 12, detail: "d" });
console.log(options.startTime, options.duration, options.detail);
console.log(performance.getEntriesByName("conf-mark").length);
console.log(performance.getEntriesByName("conf-mark", "measure").length);
console.log(performance.getEntriesByType("mark").length);
console.log(performance.getEntriesByType("measure").length);
performance.clearMarks("conf-mark");
console.log(performance.getEntriesByName("conf-mark").length);
performance.clearMarks();
console.log(performance.getEntriesByType("mark").length);
performance.clearMeasures();
console.log(performance.getEntriesByType("measure").length);
const observer = new PerformanceObserver(() => {});
console.log(typeof observer.observe, typeof observer.disconnect, observer.takeRecords().length);
const types = PerformanceObserver.supportedEntryTypes;
console.log(types.includes("mark"), types.includes("measure"));
console.log(typeof performance.now(), performance.now() >= 0);
console.log(typeof performance.timeOrigin, performance.timeOrigin > 0);
const utilization = performance.eventLoopUtilization();
console.log(
    typeof utilization.idle,
    typeof utilization.active,
    utilization.utilization >= 0 && utilization.utilization <= 1,
);
