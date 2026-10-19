import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import dns from 'node:dns';

import pubface, { resolvePublicInterfaces, _internal } from '../src/index.js';
import type { ResolvedAddress } from '../src/index.js';
import { DNS_CACHE, resetDnsCache } from './fixtures/dns-cache.js';

const { getPtrAddr, getPublicInterfaces, timedFunction, resolvePtr, updateDns, combineResults, parseTimeout, RESOLV_TIMEOUT_MS } = _internal;

// os.networkInterfaces() stand-in, the entries only need the fields pubface reads
const interfaces = (map: Record<string, Array<Record<string, unknown>>>) => () => map as any;

// -- getPtrAddr ---------------------------------------------------------------

describe('getPtrAddr', () => {
    it('should convert IPv4 to reverse PTR format', () => {
        assert.equal(getPtrAddr('1.2.3.4'), '4.3.2.1.in-addr.arpa.');
    });

    it('should reverse octets for 192.168.1.1', () => {
        assert.equal(getPtrAddr('192.168.1.1'), '1.1.168.192.in-addr.arpa.');
    });

    it('should handle 0.0.0.0', () => {
        assert.equal(getPtrAddr('0.0.0.0'), '0.0.0.0.in-addr.arpa.');
    });

    it('should handle 255.255.255.255', () => {
        assert.equal(getPtrAddr('255.255.255.255'), '255.255.255.255.in-addr.arpa.');
    });

    it('should handle 10.0.0.1', () => {
        assert.equal(getPtrAddr('10.0.0.1'), '1.0.0.10.in-addr.arpa.');
    });

    it('should convert IPv6 loopback to PTR format', () => {
        // ::1 bytes are all 0x00 except the last which is 0x01
        // All bytes < 0x0a, so the padding bug does not affect this case
        const result = getPtrAddr('::1');
        assert.equal(result, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa.');
    });

    it('should convert IPv6 address with only sub-0x0a bytes', () => {
        // 2001:0002:0003:0004:0005:0006:0007:0008
        // All bytes are < 0x0a, so no padding bug
        const result = getPtrAddr('2001:2:3:4:5:6:7:8');
        assert.equal(result, '8.0.0.0.7.0.0.0.6.0.0.0.5.0.0.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.2.ip6.arpa.');
    });

    // Regression: bytes 0x0a - 0x0f used to lose their leading zero nibble (the padding check
    // compared against 0x0a instead of 0x10), so the name had 31 nibbles and no PTR could match
    it('should pad bytes 0x0a - 0x0f to two nibbles (2001:db8::1)', () => {
        const result = getPtrAddr('2001:db8::1');
        assert.equal(result, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.');
    });

    it('should produce 32 nibbles for a full IPv6 address', () => {
        const result = getPtrAddr('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
        assert.equal(result, '4.3.3.7.0.7.3.0.e.2.a.8.0.0.0.0.0.0.0.0.3.a.5.8.8.b.d.0.1.0.0.2.ip6.arpa.');
        assert.equal(result.split('.').length - 3, 32);
    });

    it('should pad every single-nibble byte value', () => {
        for (let byte = 0; byte < 0x10; byte++) {
            const hex = byte.toString(16);
            const result = getPtrAddr(`::${hex}`);
            assert.equal(result, `${hex}.0.${'0.'.repeat(30)}ip6.arpa.`, `byte 0x0${hex}`);
        }
    });

    it('should map an IPv4-mapped IPv6 address into ip6.arpa', () => {
        assert.equal(getPtrAddr('::ffff:1.2.3.4'), '4.0.3.0.2.0.1.0.f.f.f.f.' + '0.'.repeat(20) + 'ip6.arpa.');
    });

    it('should reject the shorthand IPv4 forms ipaddr.js would parse', () => {
        // ipaddr.parse() accepts these, net.isIP() does not, and neither do resolvers
        for (const address of ['127.1', '0x7f.0.0.1', '010.0.0.1', '4294967295']) {
            assert.throws(() => getPtrAddr(address), /Invalid IP address/, address);
        }
    });

    it('should throw for invalid address', () => {
        assert.throws(() => getPtrAddr('not-an-ip'));
    });

    it('should throw for empty string', () => {
        assert.throws(() => getPtrAddr(''));
    });

    it('should throw for a hostname', () => {
        assert.throws(() => getPtrAddr('abc'), /Invalid IP address/);
    });
});

// -- getPublicInterfaces ------------------------------------------------------

describe('getPublicInterfaces', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should filter out internal interfaces', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }],
                en0: [{ address: '192.168.1.100', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff' }]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 1);
        assert.equal(result.IPv4[0].address, '192.168.1.100');
        assert.equal(result.IPv4[0].iface, 'en0');
        assert.equal(result.IPv6.length, 0);
    });

    it('should group interfaces by IPv4 and IPv6', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                en0: [
                    { address: '192.168.1.100', family: 'IPv4', internal: false },
                    { address: 'fe80::1', family: 'IPv6', internal: false }
                ]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 1);
        assert.equal(result.IPv6.length, 1);
        assert.equal(result.IPv4[0].address, '192.168.1.100');
        assert.equal(result.IPv6[0].address, 'fe80::1');
    });

    it('should return empty arrays when no public interfaces', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 0);
        assert.equal(result.IPv6.length, 0);
    });

    it('should return empty arrays for empty interface map', () => {
        mock.method(os, 'networkInterfaces', interfaces({}));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 0);
        assert.equal(result.IPv6.length, 0);
    });

    it('should collect interfaces from multiple adapters', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                en0: [{ address: '192.168.1.100', family: 'IPv4', internal: false }],
                en1: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
                lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 2);
        const addresses = result.IPv4.map(i => i.address).sort();
        assert.deepEqual(addresses, ['10.0.0.1', '192.168.1.100']);
    });

    it('should attach iface name to each entry', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4[0].iface, 'eth0');
    });

    it('should not mutate original interface entries', () => {
        const original = { address: '192.168.1.100', family: 'IPv4', internal: false };
        mock.method(os, 'networkInterfaces', interfaces({ en0: [original] }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4[0]!.iface, 'en0');
        assert.deepEqual(original, { address: '192.168.1.100', family: 'IPv4', internal: false });
    });

    it('should ignore unknown family types', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                en0: [{ address: '192.168.1.100', family: 'IPX', internal: false }]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 0);
        assert.equal(result.IPv6.length, 0);
    });

    it('should handle adapter with mixed internal and external', () => {
        mock.method(
            os,
            'networkInterfaces',
            interfaces({
                en0: [
                    { address: '127.0.0.1', family: 'IPv4', internal: true },
                    { address: '192.168.1.100', family: 'IPv4', internal: false },
                    { address: '::1', family: 'IPv6', internal: true },
                    { address: 'fe80::1', family: 'IPv6', internal: false }
                ]
            })
        );

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 1);
        assert.equal(result.IPv6.length, 1);
    });
});

// -- timedFunction ------------------------------------------------------------

describe('timedFunction', () => {
    it('should resolve when promise resolves before timeout', async () => {
        const result = await timedFunction(Promise.resolve('ok'), 1000);
        assert.equal(result, 'ok');
    });

    it('should resolve with complex data', async () => {
        const data = { ip: '1.2.3.4', name: 'test.example.com' };
        const result = await timedFunction(Promise.resolve(data), 1000);
        assert.deepEqual(result, data);
    });

    it('should reject when promise rejects before timeout', async () => {
        await assert.rejects(() => timedFunction(Promise.reject(new Error('network error')), 1000), { message: 'network error' });
    });

    it('should reject with timeout error when promise does not settle', async () => {
        let cleanup!: (value?: unknown) => void;
        const slow = new Promise(resolve => {
            cleanup = resolve;
        });
        // ref'd timer keeps event loop alive while the .unref()'d timer in timedFunction fires
        const keepAlive = setTimeout(() => {}, 5000);
        try {
            await assert.rejects(() => timedFunction(slow, 50), { message: 'Resolving requested resource timed out' });
        } finally {
            clearTimeout(keepAlive);
            cleanup();
        }
    });
});

// -- resolvePtr ---------------------------------------------------------------

describe('resolvePtr', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should call dns.resolvePtr with correct PTR address for IPv4', async () => {
        mock.method(dns.promises, 'resolvePtr', async (addr: string) => {
            assert.equal(addr, '4.3.2.1.in-addr.arpa.');
            return ['host.example.com'];
        });

        const result = await resolvePtr('1.2.3.4');
        assert.deepEqual(result, ['host.example.com']);
    });

    it('should return multiple PTR records', async () => {
        mock.method(dns.promises, 'resolvePtr', async () => ['a.example.com', 'b.example.com']);

        const result = await resolvePtr('1.2.3.4');
        assert.equal(result.length, 2);
    });

    it('should propagate DNS errors', async () => {
        mock.method(dns.promises, 'resolvePtr', async () => {
            throw new Error('ENOTFOUND');
        });

        await assert.rejects(() => resolvePtr('1.2.3.4'), { message: 'ENOTFOUND' });
    });
});

// -- updateDns ----------------------------------------------------------------

describe('updateDns', () => {
    afterEach(() => {
        mock.restoreAll();
        resetDnsCache();
    });

    it('should populate A cache on successful IPv4 resolution', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });

        await updateDns();

        assert.ok(DNS_CACHE.A);
        assert.equal(DNS_CACHE.A.host, '93.184.216.34');
        assert.ok(DNS_CACHE.A.expires instanceof Date);
        assert.ok(DNS_CACHE.A.expires > new Date());
    });

    it('should populate AAAA cache on successful IPv6 resolution', async () => {
        mock.method(dns.promises, 'resolve4', async () => {
            throw new Error('ENODATA');
        });
        mock.method(dns.promises, 'resolve6', async () => ['2606:2800:220:1:248:1893:25c8:1946']);

        await updateDns();

        assert.ok(DNS_CACHE.AAAA);
        assert.equal(DNS_CACHE.AAAA.host, '2606:2800:220:1:248:1893:25c8:1946');
    });

    it('should populate both A and AAAA when both resolve', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34']);
        mock.method(dns.promises, 'resolve6', async () => ['2606:2800:220:1:248:1893:25c8:1946']);

        await updateDns();

        assert.equal(DNS_CACHE.A.host, '93.184.216.34');
        assert.equal(DNS_CACHE.AAAA.host, '2606:2800:220:1:248:1893:25c8:1946');
    });

    it('should store error when IPv4 resolution fails', async () => {
        const err = new Error('ENOTFOUND');
        mock.method(dns.promises, 'resolve4', async () => {
            throw err;
        });
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });

        await updateDns();

        assert.ok(DNS_CACHE.A);
        assert.equal(DNS_CACHE.A.error, err);
        assert.equal(DNS_CACHE.A.host, undefined);
    });

    it('should store error when IPv6 resolution fails', async () => {
        const err = new Error('ENOTFOUND');
        mock.method(dns.promises, 'resolve4', async () => {
            throw new Error('ENODATA');
        });
        mock.method(dns.promises, 'resolve6', async () => {
            throw err;
        });

        await updateDns();

        assert.ok(DNS_CACHE.AAAA);
        assert.equal(DNS_CACHE.AAAA.error, err);
    });

    it('should use first result when DNS returns multiple addresses', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['1.1.1.1', '2.2.2.2']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });

        await updateDns();

        assert.equal(DNS_CACHE.A.host, '1.1.1.1');
    });

    it('should set expiry 10 minutes in the future', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['1.1.1.1']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });

        const before = Date.now();
        await updateDns();
        const after = Date.now();

        const expiryMs = DNS_CACHE.A.expires.getTime();
        // Should be ~10 minutes (600000ms) from now
        assert.ok(expiryMs >= before + 9 * 60 * 1000);
        assert.ok(expiryMs <= after + 11 * 60 * 1000);
    });
});

// -- RESOLV_TIMEOUT_SEC -------------------------------------------------------

describe('RESOLV_TIMEOUT', () => {
    it('should default to 5000ms (RESOLV_TIMEOUT=5)', () => {
        assert.equal(RESOLV_TIMEOUT_MS, 5000);
    });

    it('should convert seconds to ms', () => {
        assert.equal(parseTimeout('1'), 1000);
        assert.equal(parseTimeout('0.5'), 500);
        assert.equal(parseTimeout(' 2 '), 2000);
    });

    // Regression: a negative value made AbortSignal.timeout() throw, so every lookup failed and
    // resolvePublicInterfaces() silently returned an empty list
    it('should fall back to the default for values that are not a positive number', () => {
        for (const value of [undefined, '', '0', '-5', 'abc', 'NaN', 'Infinity', '-Infinity']) {
            assert.equal(parseTimeout(value), 5000, String(value));
        }
    });

    it('should cap the timeout at what setTimeout() can hold', () => {
        assert.equal(parseTimeout('1e12'), 2 ** 31 - 1);
        // AbortSignal.timeout() accepts the cap
        assert.ok(AbortSignal.timeout(parseTimeout('1e12')));
    });
});

// -- resolvePublicInterfaces (no-network) -------------------------------------

describe('resolvePublicInterfaces', () => {
    afterEach(() => {
        mock.restoreAll();
        resetDnsCache();
    });

    it('should be a function', () => {
        assert.equal(typeof resolvePublicInterfaces, 'function');
    });

    it('should return empty array when all DNS resolution fails', async () => {
        mock.method(dns.promises, 'resolve4', async () => {
            throw new Error('ENODATA');
        });
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });
        mock.method(os, 'networkInterfaces', interfaces({}));

        const result = await resolvePublicInterfaces();
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
    });

    it('should return empty array when DNS succeeds but no interfaces and API unreachable', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['127.0.0.1']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });
        mock.method(os, 'networkInterfaces', interfaces({}));

        // the lookup for the default route fails (nothing listens on port 1), allSettled drops it
        const result = await _internal.resolveInterfaces({ url: 'https://resolver.test:1/' });
        assert.deepEqual(result, []);
    });
});

// -- updateDns with an IP literal ---------------------------------------------

describe('updateDns with an IP literal resolver URL', () => {
    afterEach(() => {
        mock.restoreAll();
        resetDnsCache();
    });

    it('should pin an IPv4 literal without a DNS query', async () => {
        const resolve4 = mock.method(dns.promises, 'resolve4', async () => ['192.0.2.1']);
        await updateDns('https://198.51.100.1:8443/');
        assert.equal(resolve4.mock.callCount(), 0);
        assert.equal(DNS_CACHE.A.host, '198.51.100.1');
        assert.equal(DNS_CACHE.AAAA, false);
    });

    // Regression: URL.hostname keeps the brackets of an IPv6 literal, so net.isIPv6() failed and
    // the literal went to DNS, which could not resolve it
    it('should pin a bracketed IPv6 literal without a DNS query', async () => {
        const resolve6 = mock.method(dns.promises, 'resolve6', async () => ['2001:db8::99']);
        await updateDns('https://[2001:db8::1]/');
        assert.equal(resolve6.mock.callCount(), 0);
        assert.equal(DNS_CACHE.AAAA.host, '2001:db8::1');
        assert.equal(DNS_CACHE.A, false);
    });

    it('should keep a stale address when a refresh fails', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['192.0.2.10']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });
        await updateDns('https://resolver.test/');
        DNS_CACHE.A.expires = new Date(Date.now() - 1000);

        const failure = new Error('ETIMEOUT');
        mock.method(dns.promises, 'resolve4', async () => {
            throw failure;
        });
        await updateDns('https://resolver.test/');
        assert.equal(DNS_CACHE.A.host, '192.0.2.10');
        assert.equal(DNS_CACHE.A.error, failure);
    });

    it('should leave the cache alone when DNS answers with no addresses', async () => {
        mock.method(dns.promises, 'resolve4', async () => []);
        mock.method(dns.promises, 'resolve6', async () => []);
        await updateDns('https://resolver.test/');
        assert.equal(DNS_CACHE.A, undefined);
        assert.equal(DNS_CACHE.AAAA, undefined);
    });
});

// -- getPublicInterfaces edge cases -------------------------------------------

describe('getPublicInterfaces edge cases', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should skip an adapter without entries', () => {
        // the typings allow undefined for an adapter
        mock.method(os, 'networkInterfaces', () => ({ en0: undefined, en1: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] }) as any);
        const result = getPublicInterfaces();
        assert.deepEqual(
            result.IPv4.map(entry => entry.address),
            ['10.0.0.1']
        );
    });
});

// -- combineResults -----------------------------------------------------------

describe('combineResults', () => {
    const entry = (localAddress: string | false, ip: string, name?: string): ResolvedAddress => (name ? { localAddress, ip, name } : { localAddress, ip });

    it('should merge the default route into the interface with the same public IP', () => {
        const result = combineResults([entry(false, '198.51.100.1'), entry('10.0.0.1', '198.51.100.1'), entry('10.0.0.2', '198.51.100.2')]);
        assert.deepEqual(result, [
            { localAddress: '10.0.0.1', ip: '198.51.100.1', family: 'IPv4', defaultInterface: true },
            { localAddress: '10.0.0.2', ip: '198.51.100.2', family: 'IPv4' }
        ]);
    });

    it('should mark only the first of several interfaces sharing the default IP', () => {
        const result = combineResults([entry(false, '198.51.100.1'), entry('10.0.0.1', '198.51.100.1'), entry('10.0.0.2', '198.51.100.1')]);
        assert.equal(result.filter(item => item.defaultInterface).length, 1);
        assert.equal(result[0]!.localAddress, '10.0.0.1');
    });

    it('should keep the default route as its own entry when no interface matches it', () => {
        const result = combineResults([entry('10.0.0.1', '198.51.100.1'), entry(false, '203.0.113.9')]);
        assert.deepEqual(result, [
            { localAddress: false, ip: '203.0.113.9', family: 'IPv4', defaultInterface: true },
            { localAddress: '10.0.0.1', ip: '198.51.100.1', family: 'IPv4' }
        ]);
    });

    it('should handle the families independently, IPv4 first', () => {
        const result = combineResults([
            entry(false, '2001:db8::1'),
            entry('fe80::1', '2001:db8::1'),
            entry(false, '198.51.100.1'),
            entry('10.0.0.1', '198.51.100.2')
        ]);
        assert.deepEqual(
            result.map(item => [item.family, item.ip, !!item.defaultInterface]),
            [
                ['IPv4', '198.51.100.1', true],
                ['IPv4', '198.51.100.2', false],
                ['IPv6', '2001:db8::1', true]
            ]
        );
    });

    it('should sort the other interfaces by PTR name, falling back to the IP', () => {
        const result = combineResults([
            entry('10.0.0.1', '198.51.100.3'),
            entry('10.0.0.2', '198.51.100.1', 'zeta.example'),
            entry('10.0.0.3', '198.51.100.2', 'alpha.example')
        ]);
        assert.deepEqual(
            result.map(item => item.name || item.ip),
            ['198.51.100.3', 'alpha.example', 'zeta.example']
        );
    });

    it('should not mutate its input', () => {
        const input = [entry(false, '198.51.100.1'), entry('10.0.0.1', '198.51.100.1')];
        const copy = structuredClone(input);
        combineResults(input);
        assert.deepEqual(input, copy);
    });

    it('should return an empty list for no input', () => {
        assert.deepEqual(combineResults([]), []);
    });
});

// -- module exports -----------------------------------------------------------

describe('module exports', () => {
    it('should export resolvePublicInterfaces', () => {
        assert.equal(typeof resolvePublicInterfaces, 'function');
    });

    it('should expose resolvePublicInterfaces on the default export', () => {
        assert.equal(pubface.resolvePublicInterfaces, resolvePublicInterfaces);
    });

    it('should export _internal with all helper functions', () => {
        assert.ok(_internal);
        for (const name of [
            'getPtrAddr',
            'getPublicInterfaces',
            'timedFunction',
            'resolvePtr',
            'updateDns',
            'resolveIP',
            'combineResults',
            'resolveInterfaces'
        ]) {
            assert.equal(typeof (_internal as any)[name], 'function', name);
        }
    });

    it('should export DNS_CACHE as an object', () => {
        assert.equal(typeof _internal.DNS_CACHE, 'object');
    });
});
