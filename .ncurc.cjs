'use strict';

module.exports = {
    upgrade: true,
    // pubface is bundled into standalone binaries with @yao-pkg/pkg, which only
    // supports CommonJS. Any dependency that ships as pure ESM (no CommonJS
    // entry point) breaks the pkg build, so such upgrades must be rejected here
    // and the dependency kept on its last CommonJS-compatible release.
    reject: [
        // Add pure-ESM upgrades here as they appear, e.g.:
        // 'some-package'
    ],
    target: name => {
        // @types/node stays on the 20.x line so the compiler rejects APIs that do
        // not exist on Node 20, the oldest supported version
        if (name === '@types/node') {
            return 'minor';
        }
        // typescript-eslint declares a peer range that excludes TypeScript 7
        if (name === 'typescript') {
            return 'minor';
        }
        return 'latest';
    }
};
