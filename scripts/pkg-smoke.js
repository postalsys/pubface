/* eslint no-console: 0 */

// Builds a @yao-pkg/pkg binary of the CLI for the current platform and runs it against an
// in-process resolver. pkg snapshots a CommonJS module graph, so this is the end to end check
// that the CommonJS build and its dependencies still bundle and run the way the released
// binaries (and EmailEngine's, which bundle pubface as a dependency) do.
//
// Usage: npm run test:pkg (builds dist/ first). Needs network access the first time, pkg
// downloads its Node.js base binary into ~/.pkg-cache.

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { caPath, startResolver } = createRequire(import.meta.url)('../test/fixtures/resolver-server.cjs');
const platform = { darwin: 'macos', win32: 'win', linux: 'linux' }[process.platform];
const target = `node24-${platform}-${process.arch}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubface-pkg-'));
const binary = path.join(dir, process.platform === 'win32' ? 'pubface.exe' : 'pubface');

try {
    console.log(`building ${target} binary`);
    const pkg = path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
    const build = spawnSync(process.execPath, [pkg, '--targets', target, '--output', binary, path.join(root, 'package.json')], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) {
        throw new Error(`pkg failed with status ${build.status}`);
    }

    const resolver = await startResolver('198.51.100.7');

    try {
        const stdout = await new Promise((resolve, reject) => {
            execFile(
                binary,
                {
                    timeout: 60 * 1000,
                    env: {
                        ...process.env,
                        RESOLV_URL: resolver.url,
                        RESOLV_TIMEOUT: '3',
                        NODE_EXTRA_CA_CERTS: caPath
                    }
                },
                (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(out))
            );
        });
        const results = JSON.parse(stdout);
        if (!Array.isArray(results) || !results.some(entry => entry.defaultInterface && entry.ip === '198.51.100.7')) {
            throw new Error(`unexpected output from the binary:\n${stdout}`);
        }
        console.log(`pkg smoke test passed (${target}, ${results.length} interface(s))`);
    } finally {
        await resolver.close();
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
