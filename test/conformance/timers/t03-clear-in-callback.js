const b = setTimeout(() => console.log("b"), 0);
setTimeout(() => {
    console.log("a");
    clearTimeout(b);
}, 0);
