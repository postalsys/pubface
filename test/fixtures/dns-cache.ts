import { _internal } from '../../src/index.js';

// loosely typed so the tests can read and plant entries freely
export const DNS_CACHE = _internal.DNS_CACHE as any;

export function resetDnsCache(): void {
    delete DNS_CACHE.A;
    delete DNS_CACHE.AAAA;
}

// Pins the resolver to an IPv4 address, the way a successful DNS lookup does
export function pin(host: string, ttl = 60 * 1000): void {
    DNS_CACHE.A = { host, expires: new Date(Date.now() + ttl) };
}
