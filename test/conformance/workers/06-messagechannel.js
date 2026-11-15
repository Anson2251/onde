const { MessageChannel, receiveMessageOnPort } = require("worker_threads");
const { port1, port2 } = new MessageChannel();
const received = [];
port2.on("message", (value) => received.push(value));
port1.postMessage({ n: 1 });
const sync = receiveMessageOnPort(port2);
port1.postMessage("later");
setTimeout(() => {
  console.log("sync:" + (sync !== undefined));
  console.log("async:" + JSON.stringify(received));
  port1.close();
  port2.close();
}, 20);
