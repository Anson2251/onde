// Divergence: literal timer ids are implementation-defined (Node starts at 2, we start at 1).
const t = setTimeout(() => {}, 0);
clearTimeout(t);
console.log('object', typeof t);
