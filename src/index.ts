import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import os from 'node:os';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import * as packageInfo from './package-info.js';

/** A public-facing interface of the current machine */
export interface PublicInterface {
    /** The local address the request was bound to, false for the default route when no interface matched it */
    localAddress: string | false;
    /** The public IP address the resolver service saw the request arrive from */
    ip: string;
    /** The reverse DNS (PTR) name of `ip`, if it has one */
    name?: string | undefined;
    /** The address family of `ip` */
    family: 'IPv4' | 'IPv6';
    /** Set for the interface that connections use when no local address is specified */
    defaultInterface?: boolean | undefined;
}

interface DnsCacheEntry {
    host?: string;
    expires?: Date;
    error?: unknown;
}

interface DnsCache {
    A?: DnsCacheEntry | false;
    AAAA?: DnsCacheEntry | false;
}

type DnsFamily = 'A' | 'AAAA';

interface ResolveOptions {
    /** Map of ip to PTR lookup promise, shared between the interfaces of one resolvePublicInterfaces() call */
    ptrCache?: Map<string, Promise<string[]>>;
    /** The resolver URL, RESOLV_URL by default */
    url?: string;
    /** Whole-lookup deadline in ms */
    timeout?: number;
    /** Test hook, trusted CA certificates for the resolver */
    ca?: string | Buffer | Array<string | Buffer>;
}

/** @internal */
export interface ResolvedAddress {
    localAddress: string | false;
    ip: string;
    name?: string;
}

interface InterfaceEntry {
    address: string;
    family: 'IPv4' | 'IPv6';
    internal: boolean;
    iface: string;
}

interface PublicInterfaceGroups {
    IPv4: InterfaceEntry[];
    IPv6: InterfaceEntry[];
}

const RESOLV_URL = process.env.RESOLV_URL || 'https://api.nodemailer.com/';

// setTimeout() fires immediately for a delay that does not fit in 32 bits
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Converts RESOLV_TIMEOUT (seconds) to ms. Anything that is not a positive number falls back to
 * the default instead of producing a timeout that throws or fires at once.
 */
function parseTimeout(value: string | undefined, defaultSeconds = 5): number {
    let seconds = Number(value);
    if (!value || !Number.isFinite(seconds) || seconds <= 0) {
        seconds = defaultSeconds;
    }
    return Math.min(Math.ceil(seconds * 1000), MAX_TIMEOUT);
}

const RESOLV_TIMEOUT_MS = parseTimeout(process.env.RESOLV_TIMEOUT);

const DNS_TTL = 10 * 60 * 1000;
// The resolver answers with a tiny JSON document, anything larger is not a valid response
const MAX_RESPONSE_SIZE = 8 * 1024;
const DNS_CACHE: DnsCache = {};

// URL.hostname keeps the brackets of an IPv6 literal
function stripBrackets(hostname: string): string {
    return hostname.replace(/^\[|\]$/g, '');
}

function getPtrAddr(address: string): string {
    if (!net.isIP(address)) {
        throw new Error(`Invalid IP address ${JSON.stringify(address)}`);
    }
    let bytes = ipaddr.parse(address).toByteArray();
    if (bytes.length === 4) {
        return bytes.reverse().join('.') + '.in-addr.arpa.';
    }
    // every byte is two nibbles, a leading zero included
    return (
        bytes
            .map(nr => nr.toString(16).padStart(2, '0'))
            .join('')
            .split('')
            .reverse()
            .join('.') + '.ip6.arpa.'
    );
}

function resolvePtr(address: string): Promise<string[]> {
    return dns.promises.resolvePtr(getPtrAddr(address));
}

async function lookupFamily(family: DnsFamily, hostname: string): Promise<void> {
    let now = new Date();
    let cached = DNS_CACHE[family];
    if (cached && cached.expires && cached.expires >= now) {
        return;
    }

    try {
        let results = family === 'A' ? await dns.promises.resolve4(hostname) : await dns.promises.resolve6(hostname);
        if (results && results.length) {
            DNS_CACHE[family] = {
                host: results[0],
                expires: new Date(Date.now() + DNS_TTL)
            };
        }
    } catch (err) {
        // a stale address stays usable, the next call tries again
        let entry = DNS_CACHE[family] || {};
        entry.error = err;
        DNS_CACHE[family] = entry;
    }
}

async function updateDns(resolvUrl = RESOLV_URL): Promise<void> {
    let hostname = stripBrackets(new URL(resolvUrl).hostname);

    // an IP literal is pinned as is, and the other family is not used
    let ipVersion = net.isIP(hostname);
    if (ipVersion) {
        let family: DnsFamily = ipVersion === 4 ? 'A' : 'AAAA';
        DNS_CACHE[family === 'A' ? 'AAAA' : 'A'] = false;
        DNS_CACHE[family] = {
            host: hostname,
            expires: new Date(Date.now() + DNS_TTL)
        };
        return;
    }

    await Promise.all([lookupFamily('A', hostname), lookupFamily('AAAA', hostname)]);
}

function getPublicInterfaces(): PublicInterfaceGroups {
    let interfaces = os.networkInterfaces();
    let publicInterfaces: PublicInterfaceGroups = { IPv4: [], IPv6: [] };

    for (let [name, entries] of Object.entries(interfaces)) {
        for (let entry of entries || []) {
            if (entry.internal) {
                continue;
            }
            // the typings promise one of the two, the runtime is not held to that
            if (entry.family === 'IPv4' || entry.family === 'IPv6') {
                publicInterfaces[entry.family].push({ ...entry, iface: name });
            }
        }
    }

    return publicInterfaces;
}

function timedFunction<T>(prom: Promise<T>, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
        let timer = setTimeout(() => reject(new Error('Resolving requested resource timed out')), timeout);
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
 * @param localAddress Local address to bind to, false for the default route
 * @param family Which DNS_CACHE entry holds the resolver IP to connect to
 * @param options `url` and `timeout` in ms (required), test hook `ca`
 */
function fetchPublicIP(localAddress: string | false, family: DnsFamily, options: ResolveOptions & { url: string; timeout: number }): Promise<unknown> {
    let url = new URL(options.url);
    let hostname = stripBrackets(url.hostname);
    let cached = DNS_CACHE[family];
    let pinnedHost = (cached && cached.host) || hostname;
    let client = url.protocol === 'http:' ? http : https;

    let requestOptions: https.RequestOptions = {
        host: pinnedHost,
        path: url.pathname + url.search,
        family: family === 'AAAA' ? 6 : 4,
        // a whole-request deadline, so a slow trickle cannot keep it open either
        signal: AbortSignal.timeout(options.timeout),
        agent: false,
        headers: {
            // the connection goes to a pinned IP, so name the real host explicitly
            Host: url.host,
            'User-Agent': `${packageInfo.name}/${packageInfo.version}`,
            Accept: 'application/json'
        },
        rejectUnauthorized: true
    };
    if (url.port) {
        requestOptions.port = url.port;
    }
    if (localAddress) {
        requestOptions.localAddress = localAddress;
    }
    if (client === https) {
        // SNI and certificate verification use the hostname, not the pinned IP. Left unset, Node
        // derives the name from the Host header, and Node 22 turns an IPv6 literal there into
        // "::1." that no certificate matches. An empty name sends no SNI (an IP address can not
        // be one) and verifies the certificate against the address itself
        requestOptions.servername = net.isIP(hostname) ? '' : hostname;
    }
    if (options.ca) {
        requestOptions.ca = options.ca;
    }

    return new Promise((resolve, reject) => {
        let req = client.request(requestOptions);

        // A promise settles once, and a destroyed request emits no further 'end'
        let fail = (err: Error & { _source?: string }) => {
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
            let statusCode = Number(res.statusCode);
            if (!(statusCode >= 200 && statusCode < 300)) {
                res.resume();
                return fail(new Error(`Invalid status code ${statusCode} from IP server`));
            }

            let chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_SIZE) {
                    return fail(new Error('Response from IP server is too large'));
                }
                chunks.push(chunk);
            });
            res.on('error', fail);
            res.on('end', () => {
                let data: unknown;
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString());
                } catch (err) {
                    return fail(err as Error);
                }
                resolve(data);
            });
        });

        req.end();
    });
}

// Only a well-formed address is taken from the response, nothing else it may carry
function extractIp(data: unknown): string | null {
    // an own property only, a polluted prototype must not supply one
    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'ip')) {
        let ip = (data as { ip?: unknown }).ip;
        if (typeof ip === 'string' && net.isIP(ip)) {
            return ip;
        }
    }
    return null;
}

/**
 * @param localAddress Local address to bind to, false for the default route
 * @param family Which DNS_CACHE entry holds the resolver IP to connect to
 */
async function resolveIP(localAddress: string | false, family: DnsFamily, options: ResolveOptions & { url: string }): Promise<ResolvedAddress> {
    let timeout = options.timeout || RESOLV_TIMEOUT_MS;
    // one deadline covers both the request and the PTR lookup
    let deadline = Date.now() + timeout;

    let ip = extractIp(await fetchPublicIP(localAddress, family, { ...options, timeout }));
    if (!ip) {
        throw new Error('No response from IP server');
    }

    let result: ResolvedAddress = { localAddress, ip };

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
        let [name] = await timedFunction(lookup, remaining);
        if (name) {
            result.name = name;
        }
    } catch (_err) {
        // can ignore this
    }

    return result;
}

/**
 * Turns the resolved addresses into the public result: the default route entry is merged into
 * the first interface of its family with the same public IP, or kept as an entry of its own, and
 * the entries are sorted by family, the default interface first and then by name or IP.
 */
function combineResults(resolved: ResolvedAddress[]): PublicInterface[] {
    let defaults: { IPv4?: PublicInterface | false; IPv6?: PublicInterface | false } = {};
    let results: PublicInterface[] = [];

    for (let value of resolved) {
        let entry: PublicInterface = { ...value, family: net.isIPv6(value.ip) ? 'IPv6' : 'IPv4' };
        if (!entry.localAddress) {
            defaults[entry.family] = entry;
        } else {
            results.push(entry);
        }
    }

    for (let entry of results) {
        let defaultEntry = defaults[entry.family];
        if (defaultEntry && defaultEntry.ip === entry.ip) {
            entry.defaultInterface = true;
            defaults[entry.family] = false;
        }
    }

    for (let defaultEntry of [defaults.IPv4, defaults.IPv6]) {
        if (defaultEntry) {
            defaultEntry.defaultInterface = true;
            results.push(defaultEntry);
        }
    }

    results.sort((a, b) => {
        if (a.family !== b.family) {
            return a.family.localeCompare(b.family);
        }
        if (!a.defaultInterface !== !b.defaultInterface) {
            return a.defaultInterface ? -1 : 1;
        }
        return (a.name || a.ip).localeCompare(b.name || b.ip);
    });

    return results;
}

async function resolveInterfaces(options: ResolveOptions = {}): Promise<PublicInterface[]> {
    let interfaces = getPublicInterfaces();
    let promises: Promise<ResolvedAddress>[] = [];
    // interfaces behind the same NAT share a public IP, so they share its PTR lookup
    let url = options.url || RESOLV_URL;
    let resolveOptions = { ...options, url, ptrCache: new Map<string, Promise<string[]>>() };

    await updateDns(url);

    let lookups: Array<[DnsFamily, InterfaceEntry[]]> = [
        ['A', interfaces.IPv4],
        ['AAAA', interfaces.IPv6]
    ];
    for (let [family, entries] of lookups) {
        let cached = DNS_CACHE[family];
        if (cached && cached.host) {
            promises.push(resolveIP(false, family, resolveOptions));
            for (let iface of entries) {
                promises.push(resolveIP(iface.address, family, resolveOptions));
            }
        }
    }

    let resolved = (await Promise.allSettled(promises)).flatMap(entry => (entry.status === 'fulfilled' ? [entry.value] : []));
    return combineResults(resolved);
}

/**
 * Resolves the public-facing network interfaces of the current machine. For every non-internal
 * local interface (and the default route) it asks the resolver service which public IP address
 * the request arrives from, then looks up the reverse DNS name of that address.
 */
export async function resolvePublicInterfaces(): Promise<PublicInterface[]> {
    return resolveInterfaces();
}

/**
 * Helpers exported for the test suite only, not part of the public API
 * @internal
 */
export const _internal = {
    getPtrAddr,
    getPublicInterfaces,
    timedFunction,
    resolvePtr,
    updateDns,
    resolveIP,
    combineResults,
    extractIp,
    resolveInterfaces,
    parseTimeout,
    DNS_CACHE,
    RESOLV_TIMEOUT_MS,
    MAX_RESPONSE_SIZE
};

export default { resolvePublicInterfaces };
