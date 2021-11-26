'use strict';

const fetch = require('nodemailer/lib/fetch');
const packageData = require('./package.json');
const dns = require('dns').promises;
const os = require('os');
const net = require('net');
const ipaddr = require('ipaddr.js');

const RESOLV_URL = process.env.RESOLV_URL || 'https://api.nodemailer.com/';
const RESOLV_TIMEOUT = Number(process.env.RESOLV_TIMEOUT) || 5;

const RESOLV_TIMEOUT_SEC = RESOLV_TIMEOUT * 1000;
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
    return await dns.resolvePtr(ptrAddress);
}

async function updateDns() {
    let now = new Date();

    let url = new URL(RESOLV_URL);
    if (net.isIPv4(url.hostname)) {
        DNS_CACHE.AAAA = false;
        DNS_CACHE.A = {
            host: url.hostname,
            expires: new Date(Date.now() + 10 * 60 * 1000)
        };
        return;
    }

    if (net.isIPv6(url.hostname)) {
        DNS_CACHE.A = false;
        DNS_CACHE.AAAA = {
            host: url.hostname,
            expires: new Date(Date.now() + 10 * 60 * 1000)
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
                    expires: new Date(Date.now() + 10 * 60 * 1000)
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
                    expires: new Date(Date.now() + 10 * 60 * 1000)
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
    Object.keys(interfaces)
        .flatMap(iface => interfaces[iface].filter(entry => !entry.internal).map(entry => Object.assign({ iface }, entry)))
        .forEach(entry => {
            if (Array.isArray(publicInterfaces[entry.family])) {
                publicInterfaces[entry.family].push(entry);
            }
        });
    return publicInterfaces;
}

async function timedFunction(prom, timeout, localAddress) {
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
    let data = await new Promise((resolve, reject) => {
        let req = fetch(RESOLV_URL, {
            userAgent: `${packageData.name}/${packageData.version}`,
            tls: {
                host: DNS_CACHE[family] && DNS_CACHE[family].host,
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

        req.on('error', err => {
            reject(err);
        });

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
    } catch (err) {
        // can ignore this
    }

    return Object.assign({ localAddress }, data);
}

async function resolvePublicInterfaces() {
    let interfaces = getPublicInterfaces();
    let promises = [];

    // update resolver IP4/6 addresses
    await updateDns();

    if (DNS_CACHE.A && DNS_CACHE.A.host) {
        // default
        promises.push(timedFunction(resolveIP(false, 'A'), RESOLV_TIMEOUT_SEC, false));
        interfaces.IPv4.forEach(iface => {
            promises.push(timedFunction(resolveIP(iface.address, 'A'), RESOLV_TIMEOUT_SEC, iface.address));
        });
    }

    if (DNS_CACHE.AAAA && DNS_CACHE.AAAA.host) {
        promises.push(timedFunction(resolveIP(false, 'AAAA'), RESOLV_TIMEOUT_SEC, false));
        interfaces.IPv6.forEach(iface => {
            promises.push(timedFunction(resolveIP(iface.address, 'AAAA'), RESOLV_TIMEOUT_SEC, iface.address));
        });
    }

    let defaults = {};
    let results = (await Promise.allSettled(promises))
        .filter(entry => entry.status === 'fulfilled')
        .map(entry => Object.assign(entry.value, { family: net.isIPv6(entry.value.ip || entry.value.localAddress) ? 'IPv6' : 'IPv4' }))
        .filter(entry => {
            if (!entry.localAddress) {
                defaults[entry.family] = entry;
                return false;
            }
            return true;
        });

    results.forEach(entry => {
        if (defaults[entry.family] && defaults[entry.family].ip === entry.ip) {
            entry.defaultInterface = true;
            defaults[entry.family] = false;
        }
    });

    if (defaults.IPv4) {
        results.push(Object.assign(defaults.IPv4, { defaultInterface: true }));
    }

    if (defaults.IPv6) {
        results.push(Object.assign(defaults.IPv6, { defaultInterface: true }));
    }

    results = results.sort((a, b) => {
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
