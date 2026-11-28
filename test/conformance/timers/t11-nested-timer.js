setTimeout(() => {
    console.log("outer");
    setTimeout(() => console.log("inner"), 0);
    console.log("outer-end");
}, 0);
