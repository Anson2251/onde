const t = setTimeout(() => console.log("nope"), 50);
t.unref();
console.log("unref", t.hasRef());
