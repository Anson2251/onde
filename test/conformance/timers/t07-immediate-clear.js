const imm = setImmediate(() => console.log('nope'));
clearImmediate(imm);
console.log('cleared');
