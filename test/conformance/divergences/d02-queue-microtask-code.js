// Divergence: the engine's own queueMicrotask TypeError has no ERR_INVALID_ARG_TYPE code.
try { queueMicrotask(1); } catch (e) { console.log(e.name, e.code); }
