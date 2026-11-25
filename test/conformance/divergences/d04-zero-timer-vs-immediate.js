// Divergence D1: a clamped 0 ms timer and a `setImmediate` in the same turn race on whether the
// timer is already due when the loop starts — in Node and in onde. Lite's due-time rule makes the
// *order* deterministic only when the timer is not already due at phase entry, so this case
// asserts the set, not the order. The deterministic ordering rule itself is covered by the
// non-racing cases in `loop/`; this marker keeps the Node self-test and the differential run out
// of a wall-clock race they cannot reproduce.
const seen = [];
setTimeout(() => seen.push('timer'), 0);
setImmediate(() => seen.push('immediate'));
process.on('exit', () => console.log(seen.sort().join(',')));
