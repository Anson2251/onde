for (const v of ['5', 1.5, -1, 999, true]) {
  try { process.exitCode = v; console.log('set', v, '->', process.exitCode); } catch (e) { console.log('threw', v, e.code); }
}
process.exitCode = 0;
