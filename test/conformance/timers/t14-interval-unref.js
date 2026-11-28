const iv = setInterval(() => console.log("nope"), 20);
iv.unref();
console.log("unref-interval", iv.hasRef());
