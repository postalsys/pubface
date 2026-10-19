import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';

import { _internal } from '../src/index.js';
import type { ResolvedAddress } from '../src/index.js';
import { pin, resetDnsCache } from './fixtures/dns-cache.js';
import { ca, key } from './fixtures/resolver-server.cjs';
import { FUZZ_ITERATIONS, FUZZ_SEED, Rng, formatIpv6, ipv6Groups, jsonValue } from './fixtures/fuzz.js';

// Seeded property tests. Each input comes with what the code must make of it, computed
// independently of the implementation, so the checks go beyond "did not throw".
// Reproduce a failure with FUZZ_SEED=<seed>, using the seed in the message.

const { getPtrAddr, combineResults, extractIp, parseTimeout, resolveIP } = _internal;

const seedNote = `FUZZ_SEED=${FUZZ_SEED}`;

describe(`property tests (${seedNote})`, () => {
    it('reverses every IPv4 address into in-addr.arpa', () => {
        const rng = new Rng(FUZZ_SEED);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const octets = rng.bytes(4);
            const address = octets.join('.');
            assert.equal(getPtrAddr(address), `${octets.slice().reverse().join('.')}.in-addr.arpa.`, `${seedNote} ${address}`);
        }
    });

    it('turns every textual form of an IPv6 address into the same 32 nibble ip6.arpa name', () => {
        const rng = new Rng(FUZZ_SEED);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const groups = ipv6Groups(rng);
            const nibbles = groups.map(group => group.toString(16).padStart(4, '0')).join('');
            const expected = nibbles.split('').reverse().join('.') + '.ip6.arpa.';
            for (let form = 0; form < 3; form++) {
                const address = formatIpv6(groups, rng);
                assert.ok(net.isIPv6(address), `${seedNote} generator produced ${address}`);
                const result = getPtrAddr(address);
                assert.equal(result, expected, `${seedNote} ${address}`);
                assert.match(result, /^([0-9a-f]\.){32}ip6\.arpa\.$/, `${seedNote} ${address}`);
            }
        }
    });

    it('rejects anything net.isIP() does not accept, with a plain Error', () => {
        const rng = new Rng(FUZZ_SEED);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const value = rng.string(16, '0123456789abcdefx.:%[]');
            if (net.isIP(value)) {
                continue;
            }
            assert.throws(
                () => getPtrAddr(value),
                (err: unknown) => err instanceof Error && !(err instanceof TypeError) && !(err instanceof RangeError),
                `${seedNote} ${JSON.stringify(value)}`
            );
        }
    });

    it('takes only a valid IP address from any JSON body', () => {
        const rng = new Rng(FUZZ_SEED);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const body = jsonValue(rng);
            // the same parse the response goes through, so __proto__ keys are own properties
            const data = JSON.parse(JSON.stringify(body) ?? 'null');
            const ip = extractIp(data);
            const candidate = data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'ip') ? data.ip : undefined;
            const expected = typeof candidate === 'string' && net.isIP(candidate) ? candidate : null;
            assert.equal(ip, expected, `${seedNote} ${JSON.stringify(body)}`);
        }
    });

    it('ignores an ip that only comes from the prototype', () => {
        // only an own property of the parsed body counts, a polluted Object.prototype must not supply one
        assert.equal(extractIp(Object.create({ ip: '1.2.3.4' })), null);
        assert.equal(extractIp(JSON.parse('{"__proto__": {"ip": "1.2.3.4"}}')), null);
    });

    it('turns any RESOLV_TIMEOUT value into a usable timeout', () => {
        const rng = new Rng(FUZZ_SEED);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const value = rng.pick([rng.string(8, '0123456789.-+eE xa'), String(rng.next() * 10 ** rng.int(15)), String(-rng.int(100))]);
            const timeout = parseTimeout(value);
            assert.ok(Number.isInteger(timeout) && timeout >= 1 && timeout <= 2 ** 31 - 1, `${seedNote} ${JSON.stringify(value)} gave ${timeout}`);
        }
    });

    it('keeps the result invariants for any set of resolved addresses', () => {
        const rng = new Rng(FUZZ_SEED);
        const ips = ['198.51.100.1', '198.51.100.2', '203.0.113.5', '2001:db8::1', '2001:db8::2'];
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const input: ResolvedAddress[] = [];
            for (let i = rng.int(7); i > 0; i--) {
                const entry: ResolvedAddress = { localAddress: rng.next() < 0.3 ? false : `10.0.0.${rng.int(255)}`, ip: rng.pick(ips) };
                if (rng.bool()) {
                    entry.name = rng.pick(['a.example', 'b.example', 'z.example']);
                }
                input.push(entry);
            }
            const context = `${seedNote} ${JSON.stringify(input)}`;
            const result = combineResults(input);

            // each family's default route is the last one seen, as the lookups settle in order
            const defaults = new Map<string, ResolvedAddress>();
            for (const entry of input.filter(entry => !entry.localAddress)) {
                defaults.set(net.isIPv6(entry.ip) ? 'IPv6' : 'IPv4', entry);
            }
            const interfaces = input.filter(entry => entry.localAddress);

            // every interface is kept, the default route only when no interface has its IP
            const merged = [...defaults.values()].filter(entry =>
                interfaces.some(item => item.ip === entry.ip && net.isIPv6(item.ip) === net.isIPv6(entry.ip))
            );
            assert.equal(result.length, interfaces.length + defaults.size - merged.length, context);

            for (const family of ['IPv4', 'IPv6'] as const) {
                const items = result.filter(item => item.family === family);
                const marked = items.filter(item => item.defaultInterface);
                assert.equal(marked.length, defaults.has(family) ? 1 : 0, context);
                if (marked.length) {
                    assert.equal(items[0], marked[0], `${context}: the default interface comes first`);
                    assert.equal(marked[0]!.ip, defaults.get(family)!.ip, context);
                }
                for (let i = 2; i < items.length; i++) {
                    const a = items[i - 1]!;
                    const b = items[i]!;
                    assert.ok((a.name || a.ip).localeCompare(b.name || b.ip) <= 0, `${context}: sorted by name or IP`);
                }
            }
            // IPv4 before IPv6
            const firstV6 = result.findIndex(item => item.family === 'IPv6');
            assert.ok(firstV6 === -1 || result.slice(firstV6).every(item => item.family === 'IPv6'), context);
            for (const item of result) {
                assert.equal(item.family, net.isIPv6(item.ip) ? 'IPv6' : 'IPv4', context);
            }
        }
    });
});

describe(`resolver response fuzzing (${seedNote})`, () => {
    let server: tls.Server;
    let respond: (socket: net.Socket) => void;

    before(async () => {
        // raw responses straight onto the TLS socket, so the framing can be broken too
        server = tls.createServer({ key, cert: ca }, socket => {
            socket.once('data', () => respond(socket));
            socket.on('error', () => false);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        pin('127.0.0.1', 60 * 60 * 1000);
    });

    after(async () => {
        resetDnsCache();
        await new Promise(resolve => server.close(resolve));
    });

    afterEach(() => {
        mock.restoreAll();
    });

    it('settles every lookup with a valid IP or an Error, never hangs and never leaks', async () => {
        mock.method(dns.promises, 'resolvePtr', async () => ['ptr.example']);
        const rng = new Rng(FUZZ_SEED);
        const url = `https://resolver.test:${(server.address() as AddressInfo).port}/`;
        // each case opens a TLS connection, a tenth of the iterations keeps the suite fast
        const cases = Math.max(20, Math.floor(FUZZ_ITERATIONS / 10));
        for (let n = 0; n < cases; n++) {
            const body = rng.next() < 0.7 ? (JSON.stringify(jsonValue(rng)) ?? '') : rng.string(64);
            const status = rng.pick([200, 200, 200, 204, 301, 404, 500, 99]);
            const shape = rng.int(5);
            const head = (length: number) => `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`;
            respond = socket => {
                switch (shape) {
                    case 0:
                        // a body shorter than announced
                        socket.end(head(body.length + 10) + body);
                        break;
                    case 1:
                        // chunked in random pieces
                        socket.write(`HTTP/1.1 ${status} X\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
                        for (let pos = 0; pos < body.length;) {
                            const size = 1 + rng.int(8);
                            const piece = Buffer.from(body.slice(pos, pos + size));
                            socket.write(piece.length.toString(16) + '\r\n' + piece.toString() + '\r\n');
                            pos += size;
                        }
                        socket.end('0\r\n\r\n');
                        break;
                    case 2:
                        // garbage instead of HTTP
                        socket.end(rng.string(40));
                        break;
                    case 3:
                        socket.destroy();
                        break;
                    default:
                        socket.end(head(Buffer.byteLength(body)) + body);
                }
            };

            const context = `${seedNote} case ${n} status ${status} shape ${shape} body ${JSON.stringify(body)}`;
            let outcome: unknown;
            try {
                // sequential on purpose: each case swaps the shared responder
                // eslint-disable-next-line no-await-in-loop
                outcome = await resolveIP(false, 'A', { url, ca, timeout: 2000 });
            } catch (err) {
                outcome = err;
            }
            if (outcome instanceof Error) {
                assert.ok(!(outcome instanceof TypeError) && !(outcome instanceof RangeError), `${context}: ${outcome.stack}`);
                assert.notEqual(outcome.message, 'Resolving requested resource timed out', `${context}: hung until the deadline`);
            } else {
                const result = outcome as ResolvedAddress;
                assert.ok(status >= 200 && status < 300, context);
                assert.ok(net.isIP(result.ip), context);
                assert.deepEqual(Object.keys(result).sort(), ['ip', 'localAddress', 'name'], context);
            }
        }
    });
});
