'use strict';

// CommonJS smoke test for the built package, run by `npm run test:cjs` as plain Node with
// NODE_OPTIONS=--no-experimental-require-module. pubface ships its own @yao-pkg/pkg binaries and
// EmailEngine bundles it into another one, and pkg can only load a CommonJS module graph. Node 22+
// enables require(esm) by default, which would hide an ES-module-only dependency. With the flag
// set, any ES module reached through require() throws ERR_REQUIRE_ESM here instead of in a binary.
// Kept as plain JavaScript on purpose: running it through tsx would let its loader transpile an
// ES module dependency to CommonJS and mask exactly the failure this guards against.

const assert = require('node:assert/strict');
const path = require('node:path');
const dns = require('node:dns');

const root = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
const entry = path.join(root, pkg.exports['.'].require);
const { ca, startResolver } = require('../fixtures/resolver-server.cjs');

async function run() {
    const pubface = require(entry);
    assert.strictEqual(require.resolve('pubface'), entry);
    assert.strictEqual(typeof pubface.resolvePublicInterfaces, 'function');
    assert.strictEqual(pubface.default.resolvePublicInterfaces, pubface.resolvePublicInterfaces);

    // EmailEngine's tests replace the export on the module object, it must stay writable
    const original = pubface.resolvePublicInterfaces;
    pubface.resolvePublicInterfaces = async () => [];
    assert.deepStrictEqual(await require('pubface').resolvePublicInterfaces(), []);
    pubface.resolvePublicInterfaces = original;

    // A lookup through the whole runtime path, ipaddr.js included, against an in-process resolver
    const resolver = await startResolver('2001:db8::7');
    dns.promises.resolvePtr = async name => {
        // the reverse name of 2001:db8::7, 32 nibbles
        assert.strictEqual(name, '7.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.');
        return ['smoke.example'];
    };
    try {
        const result = await pubface._internal.resolveIP(false, 'A', { url: resolver.url, ca });
        assert.deepStrictEqual(result, { localAddress: false, ip: '2001:db8::7', name: 'smoke.example' });
    } finally {
        await resolver.close();
    }

    console.log('CommonJS smoke test passed (' + process.version + ', ' + (process.env.NODE_OPTIONS || 'no NODE_OPTIONS') + ')');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
