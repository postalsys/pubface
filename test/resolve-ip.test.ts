import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { _internal } from '../src/index.js';
import { DNS_CACHE, pin, resetDnsCache } from './fixtures/dns-cache.js';
import { ca, key } from './fixtures/resolver-server.cjs';

const { resolveIP, resolveInterfaces, updateDns, MAX_RESPONSE_SIZE } = _internal;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Resolver hostname that does not resolve in DNS, so a request only succeeds through the pinned IP
const RESOLVER_HOST = 'resolver.test';

// Checks whether this host can bind an extra loopback address (Linux can, macOS cannot by default)
function canBind(address: string): Promise<boolean> {
    return new Promise(resolve => {
        let server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(0, address, () => server.close(() => resolve(true)));
    });
}

describe('resolveIP', () => {
    let server: https.Server;
    let port: number;
    let handler: Handler;
    let seen: Array<Record<string, unknown>>;

    before(async () => {
        server = https.createServer({ key, cert: ca }, (req, res) => {
            seen.push({
                remoteAddress: req.socket.remoteAddress,
                servername: (req.socket as any).servername,
                host: req.headers.host,
                userAgent: req.headers['user-agent'],
                url: req.url
            });
            handler(req, res);
        });
        await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
        port = (server.address() as AddressInfo).port;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    let json =
        (body: unknown): Handler =>
        (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };

    let url = () => `https://${RESOLVER_HOST}:${port}/check?x=1`;

    afterEach(() => {
        mock.restoreAll();
        resetDnsCache();
    });

    let setup = (body: unknown) => {
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
        assert.equal(seen[0]!.servername, RESOLVER_HOST);
        assert.equal(seen[0]!.host, `${RESOLVER_HOST}:${port}`);
        assert.equal(seen[0]!.url, '/check?x=1');
        assert.match(seen[0]!.userAgent as string, /^pubface\/\d+\.\d+\.\d+/);
    });

    it('binds the request to the given local address', async () => {
        setup({ ip: '198.51.100.7' });

        let result = await resolveIP('127.0.0.1', 'A', { url: url(), ca });
        assert.equal(result.localAddress, '127.0.0.1');
        assert.equal((seen[0]!.remoteAddress as string).replace(/^::ffff:/, ''), '127.0.0.1');

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
        assert.equal((seen[0]!.remoteAddress as string).replace(/^::ffff:/, ''), '127.0.0.2');
    });

    it('verifies the certificate', async () => {
        setup({ ip: '198.51.100.7' });

        // self-signed and not trusted
        await assert.rejects(
            () => resolveIP(false, 'A', { url: url() }),
            (err: any) => /self.signed|SELF_SIGNED/i.test(err.code || err.message)
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
            // sequential on purpose: each iteration swaps the shared server handler
            // eslint-disable-next-line no-await-in-loop
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
        let closed!: () => void;
        let socketClosed = new Promise<void>(resolve => {
            closed = resolve;
        });
        handler = (req, res) => {
            res.on('close', closed);
            // send headers and a slow trickle that keeps the socket from ever idling out
            res.writeHead(200, { 'Content-Type': 'application/json' });
            let timer: NodeJS.Timeout;
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

    it('connects to the URL host itself when no address is pinned', async () => {
        setup({ ip: '198.51.100.7' });
        resetDnsCache();
        let result = await resolveIP(false, 'A', { url: `https://127.0.0.1:${port}/`, ca });
        assert.equal(result.ip, '198.51.100.7');
        // no SNI for an IP literal, the certificate is checked against its IP address entry
        assert.equal(seen[0]!.servername, false);
    });

    it('skips the PTR lookup when the request used up the whole deadline', async () => {
        setup({ ip: '198.51.100.7' });
        let resolvePtr = mock.method(dns.promises, 'resolvePtr', async () => ['ptr.example.com']);
        // the first reading sets the deadline, every later one is exactly at it
        let base = Date.now();
        let readings = 0;
        mock.method(Date, 'now', () => (readings++ === 0 ? base : base + 1000));

        let result = await resolveIP(false, 'A', { url: url(), ca, timeout: 1000 });
        assert.deepEqual(result, { localAddress: false, ip: '198.51.100.7' });
        assert.equal(resolvePtr.mock.callCount(), 0);
    });

    it('accepts a response of exactly the size limit', async () => {
        let body = JSON.stringify({ ip: '198.51.100.7', pad: '' });
        setup(JSON.stringify({ ip: '198.51.100.7', pad: 'x'.repeat(MAX_RESPONSE_SIZE - body.length) }));
        let result = await resolveIP(false, 'A', { url: url(), ca });
        assert.equal(result.ip, '198.51.100.7');
    });

    it('rejects any status outside 2xx, 300 included', async () => {
        setup({});
        for (let status of [300, 404]) {
            handler = (req, res) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ip: '198.51.100.7' }));
            };
            // sequential on purpose: each iteration swaps the shared server handler
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(() => resolveIP(false, 'A', { url: url(), ca }), { message: `Invalid status code ${status} from IP server` });
        }
        handler = (req, res) => {
            res.writeHead(299, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ip: '198.51.100.7' }));
        };
        assert.equal((await resolveIP(false, 'A', { url: url(), ca })).ip, '198.51.100.7');
    });

    it('tags a failure with the local address only when one was given', async () => {
        setup({});
        handler = (req, res) => {
            res.writeHead(500);
            res.end();
        };
        let failure: any = await resolveIP(false, 'A', { url: url(), ca }).catch(err => err);
        assert.equal(failure.message, 'Invalid status code 500 from IP server');
        assert.ok(!('_source' in failure));
        failure = await resolveIP('127.0.0.1', 'A', { url: url(), ca }).catch(err => err);
        assert.equal(failure._source, '127.0.0.1');
    });

    it('looks up the address family it was asked for when no address is pinned', async () => {
        setup({ ip: '198.51.100.7' });
        resetDnsCache();
        // the server only listens on IPv4, an IPv6 lookup of localhost could not reach it
        let result = await resolveIP(false, 'A', { url: `https://localhost:${port}/`, ca, timeout: 2000 }).catch(err => err);
        // the certificate does not cover "localhost", reaching the TLS check proves the connection was made
        assert.equal(result.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    });

    it('rejects a body that is not JSON', async () => {
        setup('not json');
        await assert.rejects(() => resolveIP(false, 'A', { url: url(), ca }), SyntaxError);
    });

    // A response cut short must fail at once instead of waiting for the deadline
    it('rejects a response that ends before its body is complete', async () => {
        setup({});
        handler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
            res.write('{"ip":');
            setTimeout(() => res.socket?.destroy(), 20);
        };
        let start = Date.now();
        await assert.rejects(() => resolveIP('127.0.0.1', 'A', { url: url(), ca, timeout: 3000 }), { _source: '127.0.0.1' });
        assert.ok(Date.now() - start < 2000);
    });

    it('accepts an IPv6 address in the response', async () => {
        setup({ ip: '2001:db8::7' });
        let result = await resolveIP(false, 'A', { url: url(), ca });
        assert.equal(result.ip, '2001:db8::7');
    });

    it('ignores a PTR answer that is not a string list', async () => {
        setup({ ip: '198.51.100.7' });
        mock.method(dns.promises, 'resolvePtr', async () => [] as string[]);
        assert.deepEqual(await resolveIP(false, 'A', { url: url(), ca }), { localAddress: false, ip: '198.51.100.7' });
    });

    it('talks plain HTTP for an http: resolver URL', async () => {
        let plain = http.createServer(json({ ip: '198.51.100.8' }));
        await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve));
        try {
            setup({});
            let result = await resolveIP(false, 'A', { url: `http://resolver.test:${(plain.address() as AddressInfo).port}/` });
            assert.equal(result.ip, '198.51.100.8');
        } finally {
            plain.closeAllConnections();
            plain.close();
        }
    });

    it('resolves every interface end to end and merges the default route', async () => {
        setup({ ip: '198.51.100.7' });
        resetDnsCache();
        mock.method(dns.promises, 'resolve4', async () => ['127.0.0.1']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });
        mock.method(
            os,
            'networkInterfaces',
            () =>
                ({
                    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: false }],
                    // not an address of this host, the bind fails and the interface is left out
                    en9: [{ address: '192.0.2.123', family: 'IPv4', internal: false }]
                }) as any
        );

        let result = await resolveInterfaces({ url: url(), ca });
        assert.deepEqual(result, [{ localAddress: '127.0.0.1', ip: '198.51.100.7', name: 'ptr.example.com', family: 'IPv4', defaultInterface: true }]);
        // the default route and 127.0.0.1 reached the server, 192.0.2.123 never connected
        assert.equal(seen.length, 2);
    });

    // Node 22 and older compare an IPv6 literal with the certificate's IP entries as text, and
    // "::1" never equals the expanded "0:0:0:0:0:0:0:1" the certificate lists
    let matchesIPv6Certificates = tls.checkServerIdentity('::1', { subjectaltname: 'IP Address:0:0:0:0:0:0:0:1' } as any) === undefined;

    for (let protocol of ['http', 'https'] as const) {
        it(`connects to a bracketed IPv6 literal resolver URL over ${protocol}`, async t => {
            if (!(await canBind('::1'))) {
                t.skip('::1 is not configured on this host');
                return;
            }
            if (protocol === 'https' && !matchesIPv6Certificates) {
                t.skip(`Node ${process.version} can not match an IPv6 literal with the certificate`);
                return;
            }
            let server6 =
                protocol === 'https' ? https.createServer({ key, cert: ca }, json({ ip: '2001:db8::5' })) : http.createServer(json({ ip: '2001:db8::5' }));
            await new Promise<void>(resolve => server6.listen(0, '::1', resolve));
            try {
                resetDnsCache();
                // an IP literal must never reach DNS, these fail the test if it does
                let resolve4 = mock.method(dns.promises, 'resolve4', async () => ['192.0.2.1']);
                let resolve6 = mock.method(dns.promises, 'resolve6', async () => ['2001:db8::99']);
                mock.method(dns.promises, 'resolvePtr', async () => {
                    throw new Error('ENOTFOUND');
                });
                mock.method(os, 'networkInterfaces', () => ({}));
                let result = await resolveInterfaces({ url: `${protocol}://[::1]:${(server6.address() as AddressInfo).port}/`, ca });
                assert.deepEqual(result, [{ localAddress: false, ip: '2001:db8::5', family: 'IPv6', defaultInterface: true }]);
                assert.equal(resolve4.mock.callCount() + resolve6.mock.callCount(), 0);
            } finally {
                server6.closeAllConnections();
                server6.close();
            }
        });
    }
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
