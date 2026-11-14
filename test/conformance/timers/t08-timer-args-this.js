setTimeout(function (a, b) { console.log('args', a, b, typeof this.hasRef); }, 20, 'x', 'y');
setImmediate(function (a) { console.log('immargs', a, typeof this.hasRef); }, 'z');
