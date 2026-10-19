'use strict';

// The resolver stand-in shared by the TypeScript tests, the CommonJS smoke test and the pkg
// smoke script. Plain CommonJS so that all of them can load it, the smoke test without tsx.
// The fixture certificate covers resolver.test, 127.0.0.1 and ::1.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const caPath = path.join(__dirname, 'resolver.crt');
const ca = fs.readFileSync(caPath);
const key = fs.readFileSync(path.join(__dirname, 'resolver.key'));

// Starts an HTTPS server on a loopback address that answers every request with `ip`
async function startResolver(ip, host = '127.0.0.1') {
    const server = https.createServer({ key, cert: ca }, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ip }));
    });
    await new Promise(resolve => server.listen(0, host, resolve));
    const { port } = server.address();
    return {
        url: `https://${host.includes(':') ? `[${host}]` : host}:${port}/`,
        close: async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    };
}

module.exports = { caPath, ca, key, startResolver };
