// Divergence D41: TLS is rustls and no X.509 parser is linked in, so `getPeerCertificate()`
// returns an empty object (Node returns subject/issuer/SANs/fingerprints). The connection itself
// is verified by rustls; only the certificate *inspection* API is absent.
const https = require("https");
const fs = require("fs");
const path = require("path");

const fixtures = path.join(__dirname, "../../fixtures/tls");
const key = fs.readFileSync(path.join(fixtures, "server-key.pem"));
const cert = fs.readFileSync(path.join(fixtures, "server-cert.pem"));
const ca = fs.readFileSync(path.join(fixtures, "ca-cert.pem"));

const server = https.createServer({ key, cert }, (req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
    const req = https.get({ host: "127.0.0.1", port: server.address().port, ca }, (res) => {
        const parsed = res.socket.getPeerCertificate();
        console.log("type:" + typeof parsed);
        console.log("keys:" + Object.keys(parsed).length);
        console.log("subject:" + String(parsed.subject));
        console.log("authorized:" + res.socket.authorized);
        res.resume();
        res.on("end", () => server.close());
    });
    req.on("error", (error) => {
        console.log("error:" + error.code);
        server.close();
    });
});
