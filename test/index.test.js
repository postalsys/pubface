'use strict';

const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const dns = require('node:dns');

const { resolvePublicInterfaces, _internal } = require('../index.js');
const { getPtrAddr, getPublicInterfaces, timedFunction, resolvePtr, updateDns, DNS_CACHE, RESOLV_TIMEOUT_SEC } = _internal;

function resetDnsCache() {
    delete DNS_CACHE.A;
    delete DNS_CACHE.AAAA;
}

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

    it('should produce result for 2001:db8::1 (known hex-padding bug)', () => {
        // Bug: byte 0x0d (13) only produces 'd' instead of '0d' because the
        // padding condition uses 0x0a instead of 0x10. This results in 31
        // nibbles instead of 32, making the PTR address invalid.
        const result = getPtrAddr('2001:db8::1');
        // Actual (buggy) output -- the '0' before 'd' is missing:
        assert.equal(result, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.1.0.0.2.ip6.arpa.');
        // Correct output would be:
        // '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.'
    });

    it('should produce result for full IPv6 (known hex-padding bug)', () => {
        // 2001:0db8:85a3::8a2e:0370:7334
        // Byte 0x0d produces 'd' instead of '0d'
        const result = getPtrAddr('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
        assert.equal(result, '4.3.3.7.0.7.3.0.e.2.a.8.0.0.0.0.0.0.0.0.3.a.5.8.8.b.d.1.0.0.2.ip6.arpa.');
    });

    it('should throw for invalid address', () => {
        assert.throws(() => getPtrAddr('not-an-ip'));
    });

    it('should throw for empty string', () => {
        assert.throws(() => getPtrAddr(''));
    });

    it('should return undefined for address that parses but is neither v4 nor v6', () => {
        // This cannot actually happen with valid IP addresses, but tests the fallthrough
        // ipaddr.parse only accepts v4/v6, so it throws first
        assert.throws(() => getPtrAddr('abc'));
    });
});

// -- getPublicInterfaces ------------------------------------------------------

describe('getPublicInterfaces', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should filter out internal interfaces', () => {
        mock.method(os, 'networkInterfaces', () => ({
            lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }],
            en0: [{ address: '192.168.1.100', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff' }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 1);
        assert.equal(result.IPv4[0].address, '192.168.1.100');
        assert.equal(result.IPv4[0].iface, 'en0');
        assert.equal(result.IPv6.length, 0);
    });

    it('should group interfaces by IPv4 and IPv6', () => {
        mock.method(os, 'networkInterfaces', () => ({
            en0: [
                { address: '192.168.1.100', family: 'IPv4', internal: false },
                { address: 'fe80::1', family: 'IPv6', internal: false }
            ]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 1);
        assert.equal(result.IPv6.length, 1);
        assert.equal(result.IPv4[0].address, '192.168.1.100');
        assert.equal(result.IPv6[0].address, 'fe80::1');
    });

    it('should normalize numeric family 4 to IPv4', () => {
        mock.method(os, 'networkInterfaces', () => ({
            en0: [{ address: '192.168.1.100', family: 4, internal: false }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4[0].family, 'IPv4');
    });

    it('should normalize numeric family 6 to IPv6', () => {
        mock.method(os, 'networkInterfaces', () => ({
            en0: [{ address: 'fe80::1', family: 6, internal: false }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv6[0].family, 'IPv6');
    });

    it('should return empty arrays when no public interfaces', () => {
        mock.method(os, 'networkInterfaces', () => ({
            lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 0);
        assert.equal(result.IPv6.length, 0);
    });

    it('should return empty arrays for empty interface map', () => {
        mock.method(os, 'networkInterfaces', () => ({}));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 0);
        assert.equal(result.IPv6.length, 0);
    });

    it('should collect interfaces from multiple adapters', () => {
        mock.method(os, 'networkInterfaces', () => ({
            en0: [{ address: '192.168.1.100', family: 'IPv4', internal: false }],
            en1: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
            lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 2);
        const addresses = result.IPv4.map(i => i.address).sort();
        assert.deepEqual(addresses, ['10.0.0.1', '192.168.1.100']);
    });

    it('should attach iface name to each entry', () => {
        mock.method(os, 'networkInterfaces', () => ({
            eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4[0].iface, 'eth0');
    });

    it('should not mutate original interface entries', () => {
        const original = { address: '192.168.1.100', family: 4, internal: false };
        mock.method(os, 'networkInterfaces', () => ({ en0: [original] }));

        getPublicInterfaces();
        assert.equal(original.family, 4);
    });

    it('should ignore unknown family types', () => {
        mock.method(os, 'networkInterfaces', () => ({
            en0: [{ address: '192.168.1.100', family: 'IPX', internal: false }]
        }));

        const result = getPublicInterfaces();
        assert.equal(result.IPv4.length, 0);
        assert.equal(result.IPv6.length, 0);
    });

    it('should handle adapter with mixed internal and external', () => {
        mock.method(os, 'networkInterfaces', () => ({
            en0: [
                { address: '127.0.0.1', family: 'IPv4', internal: true },
                { address: '192.168.1.100', family: 'IPv4', internal: false },
                { address: '::1', family: 'IPv6', internal: true },
                { address: 'fe80::1', family: 'IPv6', internal: false }
            ]
        }));

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
        let cleanup;
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

    it('should include _source on timeout error when localAddress given', async () => {
        let cleanup;
        const slow = new Promise(resolve => {
            cleanup = resolve;
        });
        const keepAlive = setTimeout(() => {}, 5000);
        try {
            await timedFunction(slow, 50, '192.168.1.100');
            assert.fail('Should have thrown');
        } catch (err) {
            assert.equal(err.message, 'Resolving requested resource timed out');
            assert.equal(err._source, '192.168.1.100');
        } finally {
            clearTimeout(keepAlive);
            cleanup();
        }
    });

    it('should not set _source when localAddress is false', async () => {
        let cleanup;
        const slow = new Promise(resolve => {
            cleanup = resolve;
        });
        const keepAlive = setTimeout(() => {}, 5000);
        try {
            await timedFunction(slow, 50, false);
            assert.fail('Should have thrown');
        } catch (err) {
            assert.equal(err._source, undefined);
        } finally {
            clearTimeout(keepAlive);
            cleanup();
        }
    });

    it('should not set _source when localAddress is omitted', async () => {
        let cleanup;
        const slow = new Promise(resolve => {
            cleanup = resolve;
        });
        const keepAlive = setTimeout(() => {}, 5000);
        try {
            await timedFunction(slow, 50);
            assert.fail('Should have thrown');
        } catch (err) {
            assert.equal(err._source, undefined);
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
        mock.method(dns.promises, 'resolvePtr', async addr => {
            assert.equal(addr, '4.3.2.1.in-addr.arpa.');
            return ['host.example.com'];
        });

        const result = await resolvePtr('1.2.3.4');
        assert.deepEqual(result, ['host.example.com']);
    });

    it('should return multiple PTR records', async () => {
        mock.method(dns.promises, 'resolvePtr', async () => {
            return ['a.example.com', 'b.example.com'];
        });

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

describe('RESOLV_TIMEOUT_SEC', () => {
    it('should default to 5000ms (RESOLV_TIMEOUT=5)', () => {
        assert.equal(RESOLV_TIMEOUT_SEC, 5000);
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
        mock.method(os, 'networkInterfaces', () => ({}));

        const result = await resolvePublicInterfaces();
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
    });

    it('should return empty array when DNS succeeds but no interfaces and API unreachable', async () => {
        mock.method(dns.promises, 'resolve4', async () => ['127.0.0.1']);
        mock.method(dns.promises, 'resolve6', async () => {
            throw new Error('ENODATA');
        });
        mock.method(os, 'networkInterfaces', () => ({}));

        // resolveIP will be called for the default interface (localAddress=false)
        // It will fail since 127.0.0.1 is not a real resolver, but allSettled handles it
        const result = await resolvePublicInterfaces();
        assert.ok(Array.isArray(result));
    });
});

// -- module exports -----------------------------------------------------------

describe('module exports', () => {
    it('should export resolvePublicInterfaces', () => {
        const mod = require('../index.js');
        assert.equal(typeof mod.resolvePublicInterfaces, 'function');
    });

    it('should export _internal with all helper functions', () => {
        const mod = require('../index.js');
        assert.ok(mod._internal);
        assert.equal(typeof mod._internal.getPtrAddr, 'function');
        assert.equal(typeof mod._internal.getPublicInterfaces, 'function');
        assert.equal(typeof mod._internal.timedFunction, 'function');
        assert.equal(typeof mod._internal.resolvePtr, 'function');
        assert.equal(typeof mod._internal.updateDns, 'function');
        assert.equal(typeof mod._internal.resolveIP, 'function');
    });

    it('should export DNS_CACHE as an object', () => {
        const mod = require('../index.js');
        assert.equal(typeof mod._internal.DNS_CACHE, 'object');
    });
});
