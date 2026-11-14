const t = setTimeout(() => console.log('fired'), 0);
t.unref();
t.ref();
console.log('ref', t.hasRef());
