// Seeded random input for the property tests. A failure message names the seed, reproduce it
// with FUZZ_SEED=<seed>, and raise FUZZ_ITERATIONS for a longer soak run.

export const FUZZ_SEED = Number(process.env.FUZZ_SEED) || Math.floor(Math.random() * 2 ** 31);
export const FUZZ_ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 500;

// mulberry32, small and good enough to spread test input
export class Rng {
    private state: number;

    constructor(seed: number) {
        this.state = seed % 2 ** 32;
    }

    next(): number {
        /* eslint-disable no-bitwise */
        let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        /* eslint-enable no-bitwise */
    }

    int(max: number): number {
        return Math.floor(this.next() * max);
    }

    bool(): boolean {
        return this.next() < 0.5;
    }

    pick<T>(items: readonly T[]): T {
        return items[this.int(items.length)]!;
    }

    bytes(length: number): number[] {
        return Array.from({ length }, () => this.int(256));
    }

    // a non-ASCII letter, a NUL and a lone surrogate are in the default alphabet
    string(maxLength: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789.:-[]{}" \\/%' + String.fromCharCode(0xe4, 0, 0xd83d)): string {
        return Array.from({ length: this.int(maxLength + 1) }, () => this.pick(alphabet.split(''))).join('');
    }
}

// The 8 groups of an IPv6 address, biased towards zero runs so that every compression shape shows up
export function ipv6Groups(rng: Rng): number[] {
    return Array.from({ length: 8 }, () => (rng.next() < 0.4 ? 0 : rng.pick([rng.int(0x10), rng.int(0x100), rng.int(0x10000)])));
}

// One of the textual forms the same IPv6 address can take
export function formatIpv6(groups: number[], rng: Rng): string {
    let hex = groups.map(group => group.toString(16));
    switch (rng.int(4)) {
        case 0:
            // fully expanded
            return groups.map(group => group.toString(16).padStart(4, '0')).join(':');
        case 1: {
            // the longest zero run compressed
            let best = -1;
            let bestLength = 0;
            for (let i = 0; i < 8; i++) {
                let length = 0;
                while (i + length < 8 && groups[i + length] === 0) {
                    length++;
                }
                if (length > bestLength) {
                    best = i;
                    bestLength = length;
                }
            }
            if (bestLength < 2) {
                return hex.join(':');
            }
            return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLength).join(':');
        }
        case 2:
            return hex.join(':').toUpperCase();
        default:
            return hex.join(':');
    }
}

// Generates a JSON value of any shape, the kind of body a broken or hostile resolver may send
export function jsonValue(rng: Rng, depth = 0): unknown {
    switch (rng.int(depth > 2 ? 5 : 7)) {
        case 0:
            return null;
        case 1:
            return rng.bool();
        case 2:
            return rng.pick([0, -1, 1.5, 1e308, Number.MAX_SAFE_INTEGER, rng.int(1000)]);
        case 3:
            return rng.string(20);
        case 4:
            return rng.pick(['1.2.3.4', '::1', '2001:db8::1', '1.2.3', '1.2.3.4.5', '::ffff:1.2.3.4', 'fe80::1%en0', '256.1.1.1', ' 1.2.3.4', '01.2.3.4']);
        case 5:
            return Array.from({ length: rng.int(4) }, () => jsonValue(rng, depth + 1));
        default: {
            let value: Record<string, unknown> = {};
            for (let i = rng.int(4); i > 0; i--) {
                value[rng.pick(['ip', 'name', 'localAddress', '__proto__', 'constructor', rng.string(5)])] = jsonValue(rng, depth + 1);
            }
            return value;
        }
    }
}
