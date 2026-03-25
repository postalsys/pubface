'use strict';

const fetchUrl = require('nodemailer/lib/fetch');
const packageData = require('./package.json');
const dns = require('dns').promises;
const os = require('os');
const net = require('net');
const ipaddr = require('ipaddr.js');

const RESOLV_URL = process.env.RESOLV_URL || 'https://api.nodemailer.com/';
const RESOLV_TIMEOUT = Number(process.env.RESOLV_TIMEOUT) || 5;

const RESOLV_TIMEOUT_SEC = RESOLV_TIMEOUT * 1000;
const DNS_TTL = 10 * 60 * 1000;
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

    let shouldCheckIPv4 = !DNS_CACHE.A || !DNS_CACHE.A.expires || !DNS_CACHE.A.expires < now;
    let shouldCheckIPv6 = !DNS_CACHE.AAAA || !DNS_CACHE.AAAA.expires || !DNS_CACHE.AAAA.expires < now;

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
        setTimeout(() => {
            let err = new Error('Resolving requested resource timed out');
            if (localAddress) {
                err._source = localAddress;
            }
            reject(err);
        }, timeout).unref();
        prom.then(resolve).catch(reject);
    });
}

async function resolveIP(localAddress, family) {
    let resolvHostname = new URL(RESOLV_URL).hostname;
    let data = await new Promise((resolve, reject) => {
        let req = fetchUrl(RESOLV_URL, {
            userAgent: `${packageData.name}/${packageData.version}`,
            tls: {
                host: DNS_CACHE[family] && DNS_CACHE[family].host,
                servername: resolvHostname,
                hostname: resolvHostname,
                rejectUnauthorized: false,
                localAddress
            }
        });

        let buf = [];
        req.on('readable', () => {
            let chunk;
            while ((chunk = req.read()) !== null) {
                buf.push(chunk);
            }
        });

        req.on('error', reject);

        req.on('end', () => {
            try {
                let data = JSON.parse(Buffer.concat(buf).toString());
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    });

    if (!data || !data.ip) {
        throw new Error('No response from IP server');
    }

    try {
        let name = await resolvePtr(data.ip);
        if (name && name.length) {
            data.name = name[0];
        }
    } catch (_err) {
        // can ignore this
    }

    return { localAddress, ...data };
}

async function resolvePublicInterfaces() {
    let interfaces = getPublicInterfaces();
    let promises = [];

    await updateDns();

    if (DNS_CACHE.A && DNS_CACHE.A.host) {
        promises.push(timedFunction(resolveIP(false, 'A'), RESOLV_TIMEOUT_SEC, false));
        for (let iface of interfaces.IPv4) {
            promises.push(timedFunction(resolveIP(iface.address, 'A'), RESOLV_TIMEOUT_SEC, iface.address));
        }
    }

    if (DNS_CACHE.AAAA && DNS_CACHE.AAAA.host) {
        promises.push(timedFunction(resolveIP(false, 'AAAA'), RESOLV_TIMEOUT_SEC, false));
        for (let iface of interfaces.IPv6) {
            promises.push(timedFunction(resolveIP(iface.address, 'AAAA'), RESOLV_TIMEOUT_SEC, iface.address));
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
module.exports._internal = { getPtrAddr, getPublicInterfaces, timedFunction, resolvePtr, updateDns, resolveIP, DNS_CACHE, RESOLV_TIMEOUT_SEC };
