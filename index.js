'use strict';

const http = require('http');
const https = require('https');
const packageData = require('./package.json');
const dns = require('dns').promises;
const os = require('os');
const net = require('net');
const ipaddr = require('ipaddr.js');

const RESOLV_URL = process.env.RESOLV_URL || 'https://api.nodemailer.com/';
const RESOLV_TIMEOUT = Number(process.env.RESOLV_TIMEOUT) || 5;

const RESOLV_TIMEOUT_SEC = RESOLV_TIMEOUT * 1000;
const DNS_TTL = 10 * 60 * 1000;
// The resolver answers with a tiny JSON document, anything larger is not a valid response
const MAX_RESPONSE_SIZE = 8 * 1024;
const DNS_CACHE = {};

function getPtrAddr(address) {
    let parsed = ipaddr.parse(address);
    if (net.isIPv4(address)) {
        return parsed.toByteArray().reverse().join('.') + '.in-addr.arpa.';
    }
    if (net.isIPv6(address)) {
        return (
            parsed
                .toByteArray()
                .map(nr => (nr < 0x0a ? '0' : '') + nr.toString(16))
                .join('')
                .split('')
                .reverse()
                .join('.') + '.ip6.arpa.'
        );
    }
}

async function resolvePtr(address) {
    let ptrAddress = getPtrAddr(address);
    return dns.resolvePtr(ptrAddress);
}

async function updateDns() {
    let now = new Date();

    let url = new URL(RESOLV_URL);
    if (net.isIPv4(url.hostname)) {
        DNS_CACHE.AAAA = false;
        DNS_CACHE.A = {
            host: url.hostname,
            expires: new Date(Date.now() + DNS_TTL)
        };
        return;
    }

    if (net.isIPv6(url.hostname)) {
        DNS_CACHE.A = false;
        DNS_CACHE.AAAA = {
            host: url.hostname,
            expires: new Date(Date.now() + DNS_TTL)
        };
        return;
    }

    let shouldCheckIPv4 = !DNS_CACHE.A || !DNS_CACHE.A.expires || DNS_CACHE.A.expires < now;
    let shouldCheckIPv6 = !DNS_CACHE.AAAA || !DNS_CACHE.AAAA.expires || DNS_CACHE.AAAA.expires < now;

    if (shouldCheckIPv4) {
        try {
            let results = await dns.resolve4(url.hostname);
            if (results && results.length) {
                DNS_CACHE.A = {
                    host: results[0],
                    expires: new Date(Date.now() + DNS_TTL)
                };
            }
        } catch (err) {
            if (!DNS_CACHE.A) {
                DNS_CACHE.A = {};
            }
            DNS_CACHE.A.error = err;
        }
    }

    if (shouldCheckIPv6) {
        try {
            let results = await dns.resolve6(url.hostname);
            if (results && results.length) {
                DNS_CACHE.AAAA = {
                    host: results[0],
                    expires: new Date(Date.now() + DNS_TTL)
                };
            }
        } catch (err) {
            if (!DNS_CACHE.AAAA) {
                DNS_CACHE.AAAA = {};
            }
            DNS_CACHE.AAAA.error = err;
        }
    }
}

function getPublicInterfaces() {
    let interfaces = os.networkInterfaces();
    let publicInterfaces = { IPv4: [], IPv6: [] };

    for (let [name, entries] of Object.entries(interfaces)) {
        for (let entry of entries) {
            if (entry.internal) {
                continue;
            }
            let family = typeof entry.family === 'number' ? `IPv${entry.family}` : entry.family;
            if (Array.isArray(publicInterfaces[family])) {
                publicInterfaces[family].push({ ...entry, iface: name, family });
            }
        }
    }

    return publicInterfaces;
}

function timedFunction(prom, timeout, localAddress) {
    return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
            let err = new Error('Resolving requested resource timed out');
            if (localAddress) {
                err._source = localAddress;
            }
            reject(err);
        }, timeout);
        timer.unref();
        prom.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

/**
 * Asks the resolver service which public IP address a request from `localAddress` arrives from.
 *
 * The request is made with node:https directly so that the local address and the pinned resolver
 * IP actually reach the socket (nodemailer's fetch dropped both, so every interface was resolved
 * through the default route). The certificate is verified against the resolver's hostname.
 *
 * @param {string|false} localAddress Local address to bind to, false for the default route
 * @param {'A'|'AAAA'} family Which DNS_CACHE entry holds the resolver IP to connect to
 * @param {Object} options `timeout` in ms (required), test hooks `url` and `ca`
 */
function fetchPublicIP(localAddress, family, options) {
    let url = new URL(options.url || RESOLV_URL);
    let hostname = url.hostname.replace(/^\[|\]$/g, '');
    let pinnedHost = (DNS_CACHE[family] && DNS_CACHE[family].host) || hostname;
    let client = url.protocol === 'http:' ? http : https;

    let requestOptions = {
        host: pinnedHost,
        port: url.port || undefined,
        path: url.pathname + url.search,
        family: family === 'AAAA' ? 6 : 4,
        // a whole-request deadline, so a slow trickle cannot keep it open either
        signal: AbortSignal.timeout(options.timeout),
        agent: false,
        headers: {
            // the connection goes to a pinned IP, so name the real host explicitly
            Host: url.host,
            'User-Agent': `${packageData.name}/${packageData.version}`,
            Accept: 'application/json'
        },
        rejectUnauthorized: true
    };
    if (localAddress) {
        requestOptions.localAddress = localAddress;
    }
    if (client === https && !net.isIP(hostname)) {
        // SNI and certificate verification use the hostname, not the pinned IP
        requestOptions.servername = hostname;
    }
    if (options.ca) {
        requestOptions.ca = options.ca;
    }

    return new Promise((resolve, reject) => {
        let req = client.request(requestOptions);

        // A promise settles once, and a destroyed request emits no further 'end'
        let fail = err => {
            if (err.name === 'AbortError') {
                err = new Error('Resolving requested resource timed out');
            }
            if (localAddress && !err._source) {
                err._source = localAddress;
            }
            reject(err);
            req.destroy();
        };

        req.on('error', fail);

        req.on('response', res => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return fail(new Error(`Invalid status code ${res.statusCode} from IP server`));
            }

            let chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_RESPONSE_SIZE) {
                    return fail(new Error('Response from IP server is too large'));
                }
                chunks.push(chunk);
            });
            res.on('error', fail);
            res.on('end', () => {
                let data;
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString());
                } catch (err) {
                    return fail(err);
                }
                resolve(data);
            });
        });

        req.end();
    });
}

/**
 * @param {string|false} localAddress Local address to bind to, false for the default route
 * @param {'A'|'AAAA'} family Which DNS_CACHE entry holds the resolver IP to connect to
 * @param {Object} [options] `ptrCache` (Map of ip to PTR lookup promise, shared between the
 *   interfaces of one resolvePublicInterfaces() call), test hooks `url`, `timeout`, `ca`
 */
async function resolveIP(localAddress, family, options = {}) {
    let timeout = options.timeout || RESOLV_TIMEOUT_SEC;
    // one deadline covers both the request and the PTR lookup
    let deadline = Date.now() + timeout;

    let data = await fetchPublicIP(localAddress, family, { ...options, timeout });

    // Only a well-formed address is taken from the response, nothing else it may carry
    let ip = data && typeof data.ip === 'string' && net.isIP(data.ip) ? data.ip : null;
    if (!ip) {
        throw new Error('No response from IP server');
    }

    let result = { localAddress, ip };

    let remaining = deadline - Date.now();
    if (remaining <= 0) {
        return result;
    }

    try {
        let lookup = options.ptrCache && options.ptrCache.get(ip);
        if (!lookup) {
            lookup = resolvePtr(ip);
            if (options.ptrCache) {
                options.ptrCache.set(ip, lookup);
            }
        }
        // A hung DNS query cannot be aborted, so stop waiting for it instead
        let name = await timedFunction(lookup, remaining);
        if (name && name.length) {
            result.name = name[0];
        }
    } catch (_err) {
        // can ignore this
    }

    return result;
}

async function resolvePublicInterfaces() {
    let interfaces = getPublicInterfaces();
    let promises = [];
    // interfaces behind the same NAT share a public IP, so they share its PTR lookup
    let options = { ptrCache: new Map() };

    await updateDns();

    if (DNS_CACHE.A && DNS_CACHE.A.host) {
        promises.push(resolveIP(false, 'A', options));
        for (let iface of interfaces.IPv4) {
            promises.push(resolveIP(iface.address, 'A', options));
        }
    }

    if (DNS_CACHE.AAAA && DNS_CACHE.AAAA.host) {
        promises.push(resolveIP(false, 'AAAA', options));
        for (let iface of interfaces.IPv6) {
            promises.push(resolveIP(iface.address, 'AAAA', options));
        }
    }

    let defaults = {};
    let results = (await Promise.allSettled(promises))
        .filter(entry => entry.status === 'fulfilled')
        .map(entry => {
            let value = entry.value;
            value.family = net.isIPv6(value.ip || value.localAddress) ? 'IPv6' : 'IPv4';
            return value;
        })
        .filter(entry => {
            if (!entry.localAddress) {
                defaults[entry.family] = entry;
                return false;
            }
            return true;
        });

    for (let entry of results) {
        if (defaults[entry.family] && defaults[entry.family].ip === entry.ip) {
            entry.defaultInterface = true;
            defaults[entry.family] = false;
        }
    }

    if (defaults.IPv4) {
        defaults.IPv4.defaultInterface = true;
        results.push(defaults.IPv4);
    }

    if (defaults.IPv6) {
        defaults.IPv6.defaultInterface = true;
        results.push(defaults.IPv6);
    }

    results.sort((a, b) => {
        if (a.family !== b.family) {
            return a.family.localeCompare(b.family);
        }
        if (a.defaultInterface) {
            return -1;
        }
        if (b.defaultInterface) {
            return 1;
        }
        return (a.name || a.ip).localeCompare(b.name || b.ip);
    });

    return results;
}

module.exports = { resolvePublicInterfaces };

// exported for testing
module.exports._internal = {
    getPtrAddr,
    getPublicInterfaces,
    timedFunction,
    resolvePtr,
    updateDns,
    resolveIP,
    DNS_CACHE,
    RESOLV_TIMEOUT_SEC,
    MAX_RESPONSE_SIZE
};
