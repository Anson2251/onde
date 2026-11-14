const t = setTimeout(() => console.log('nope'), 0);
clearTimeout(t);
console.log('cleared', typeof t, t.hasRef());
