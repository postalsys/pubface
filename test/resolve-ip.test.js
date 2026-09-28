'use strict';

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns');

const { _internal } = require('../index.js');
const { resolveIP, updateDns, DNS_CACHE, MAX_RESPONSE_SIZE } = _internal;

const ca = fs.readFileSync(path.join(__dirname, 'fixtures', 'resolver.crt'));
const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'resolver.key'));

// Resolver hostname that does not resolve in DNS, so a request only succeeds through the pinned IP
const RESOLVER_HOST = 'resolver.test';

function resetDnsCache() {
    delete DNS_CACHE.A;
    delete DNS_CACHE.AAAA;
}

function pin(host) {
    DNS_CACHE.A = { host, expires: new Date(Date.now() + 60 * 1000) };
}

// Checks whether this host can bind an extra loopback address (Linux can, macOS cannot by default)
function canBind(address) {
    return new Promise(resolve => {
        let server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(0, address, () => server.close(() => resolve(true)));
    });
}

describe('resolveIP', () => {
    let server;
    let port;
    let handler;
    let seen;

    before(async () => {
        server = https.createServer({ key, cert: ca }, (req, res) => {
            seen.push({
                remoteAddress: req.socket.remoteAddress,
                servername: req.socket.servername,
                host: req.headers.host,
                userAgent: req.headers['user-agent'],
                url: req.url
            });
            handler(req, res);
        });
        await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
        port = server.address().port;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    let json = body => (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    let url = () => `https://${RESOLVER_HOST}:${port}/check?x=1`;

    afterEach(() => {
        mock.restoreAll();
        resetDnsCache();
    });

    let setup = body => {
        seen = [];
        handler = json(body);
        pin('127.0.0.1');
        mock.method(dns.promises, 'resolvePtr', async () => ['ptr.example.com']);
    };

    it('connects to the pinned IP with the real hostname in Host and SNI', async () => {
        setup({ ip: '198.51.100.7' });

        let result = await resolveIP(false, 'A', { url: url(), ca });

        assert.deepEqual(result, { localAddress: false, ip: '198.51.100.7', name: 'ptr.example.com' });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].servername, RESOLVER_HOST);
        assert.equal(seen[0].host, `${RESOLVER_HOST}:${port}`);
        assert.equal(seen[0].url, '/check?x=1');
        assert.match(seen[0].userAgent, /^pubface\//);
    });

    it('binds the request to the given local address', async () => {
        setup({ ip: '198.51.100.7' });

        let result = await resolveIP('127.0.0.1', 'A', { url: url(), ca });
        assert.equal(result.localAddress, '127.0.0.1');
        assert.equal(seen[0].remoteAddress.replace(/^::ffff:/, ''), '127.0.0.1');

        // An address this host does not own fails to bind. nodemailer's fetch dropped
        // localAddress, so this used to succeed through the default route.
        await assert.rejects(() => resolveIP('192.0.2.123', 'A', { url: url(), ca }), { code: 'EADDRNOTAVAIL', _source: '192.0.2.123' });
    });

    it('uses a second loopback address as the source when the host has one', async t => {
        if (!(await canBind('127.0.0.2'))) {
            t.skip('127.0.0.2 is not configured on this host');
            return;
        }
        setup({ ip: '198.51.100.7' });

        await resolveIP('127.0.0.2', 'A', { url: url(), ca });
        assert.equal(seen[0].remoteAddress.replace(/^::ffff:/, ''), '127.0.0.2');
    });

    it('verifies the certificate', async () => {
        setup({ ip: '198.51.100.7' });

        // self-signed and not trusted
        await assert.rejects(
            () => resolveIP(false, 'A', { url: url() }),
            err => /self.signed|SELF_SIGNED/i.test(err.code || err.message)
        );

        // trusted, but issued for another name
        await assert.rejects(() => resolveIP(false, 'A', { url: `https://other.test:${port}/`, ca }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });

    it('copies only a valid ip from the response', async () => {
        setup({ ip: '198.51.100.7', name: 'attacker.example', localAddress: '10.9.9.9', defaultInterface: true, extra: 'x' });
        mock.method(dns.promises, 'resolvePtr', async () => {
            throw new Error('ENOTFOUND');
        });

        let result = await resolveIP('127.0.0.1', 'A', { url: url(), ca });
        // the name must come from PTR only, never from the response
        assert.deepEqual(result, { localAddress: '127.0.0.1', ip: '198.51.100.7' });

        for (let body of [{ ip: 'mail.example.com' }, { ip: '1.2.3.4 evil' }, { ip: ['1.2.3.4'] }, {}, 'null']) {
            handler = json(body);
            await assert.rejects(() => resolveIP(false, 'A', { url: url(), ca }), { message: 'No response from IP server' });
        }
    });

    it('rejects an oversized or non-2xx response', async () => {
        setup({});
        handler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ip: '198.51.100.7', pad: 'x'.repeat(MAX_RESPONSE_SIZE) }));
        };
        await assert.rejects(() => resolveIP(false, 'A', { url: url(), ca }), { message: 'Response from IP server is too large' });

        handler = (req, res) => {
            res.writeHead(500);
            res.end(JSON.stringify({ ip: '198.51.100.7' }));
        };
        await assert.rejects(() => resolveIP(false, 'A', { url: url(), ca }), { message: /Invalid status code 500/ });
    });

    it('aborts a request that runs past the timeout', async () => {
        setup({});
        let closed;
        let socketClosed = new Promise(resolve => {
            closed = resolve;
        });
        handler = (req, res) => {
            res.on('close', closed);
            // send headers and a slow trickle that keeps the socket from ever idling out
            res.writeHead(200, { 'Content-Type': 'application/json' });
            let timer;
            let trickle = () => {
                res.write(' ');
                timer = setTimeout(trickle, 20);
            };
            trickle();
            res.on('close', () => clearTimeout(timer));
        };

        let start = Date.now();
        await assert.rejects(() => resolveIP(false, 'A', { url: url(), ca, timeout: 300 }), { message: 'Resolving requested resource timed out' });
        assert.ok(Date.now() - start < 2000);

        // the request is really torn down, not just abandoned
        await socketClosed;
    });

    it('bounds the request and the PTR lookup by one deadline', async () => {
        setup({ ip: '198.51.100.7' });
        // the response arrives most of the way into the budget and the PTR lookup never answers
        let base = handler;
        handler = (req, res) => setTimeout(() => base(req, res), 250);
        mock.method(dns.promises, 'resolvePtr', () => new Promise(() => {}));

        let start = Date.now();
        let result = await resolveIP(false, 'A', { url: url(), ca, timeout: 400 });
        let elapsed = Date.now() - start;

        assert.deepEqual(result, { localAddress: false, ip: '198.51.100.7' });
        // separate budgets took about 250 + 400 ms
        assert.ok(elapsed < 600, `took ${elapsed} ms`);
    });

    it('shares one PTR lookup between interfaces that resolve to the same IP', async () => {
        setup({ ip: '198.51.100.7' });
        let resolvePtr = mock.method(dns.promises, 'resolvePtr', async () => ['ptr.example.com']);

        let ptrCache = new Map();
        let results = await Promise.all([resolveIP(false, 'A', { url: url(), ca, ptrCache }), resolveIP('127.0.0.1', 'A', { url: url(), ca, ptrCache })]);

        assert.equal(resolvePtr.mock.callCount(), 1);
        assert.deepEqual(
            results.map(r => r.name),
            ['ptr.example.com', 'ptr.example.com']
        );
    });
});

describe('updateDns cache', () => {
    afterEach(() => {
        mock.restoreAll();
        resetDnsCache();
    });

    it('does not query DNS again while the cached entries are fresh', async () => {
        let resolve4 = mock.method(dns.promises, 'resolve4', async () => ['192.0.2.10']);
        let resolve6 = mock.method(dns.promises, 'resolve6', async () => ['2001:db8::10']);

        await updateDns();
        await updateDns();
        assert.equal(resolve4.mock.callCount(), 1);
        assert.equal(resolve6.mock.callCount(), 1);

        DNS_CACHE.A.expires = new Date(Date.now() - 1000);
        await updateDns();
        assert.equal(resolve4.mock.callCount(), 2);
        assert.equal(resolve6.mock.callCount(), 1);
    });

    it('retries after a failed lookup', async () => {
        let resolve4 = mock.method(dns.promises, 'resolve4', async () => {
            throw new Error('ENOTFOUND');
        });
        mock.method(dns.promises, 'resolve6', async () => ['2001:db8::10']);

        await updateDns();
        await updateDns();
        assert.equal(resolve4.mock.callCount(), 2);
    });
});
