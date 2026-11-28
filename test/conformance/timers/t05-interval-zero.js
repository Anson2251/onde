let n = 0;
const iv = setInterval(() => {
    console.log("iv", ++n);
    if (n === 3) clearInterval(iv);
}, 0);
