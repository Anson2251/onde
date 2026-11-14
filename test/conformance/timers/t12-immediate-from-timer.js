setTimeout(() => { console.log('timer'); setImmediate(() => console.log('imm-from-timer')); setTimeout(() => console.log('timer-from-timer'), 0); }, 20);
setImmediate(() => console.log('imm-top'));
