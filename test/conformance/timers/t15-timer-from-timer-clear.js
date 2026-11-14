setTimeout(() => { console.log('a'); clearTimeout(b); }, 0);
const b = setTimeout(() => console.log('b'), 0);
