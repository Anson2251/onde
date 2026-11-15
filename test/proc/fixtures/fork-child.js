process.on("message", (message) => {
  process.send({ echo: message });
  if (message === "bye") process.disconnect();
});
process.send({ ready: true });
