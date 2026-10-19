import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { caPath, startResolver } from './fixtures/resolver-server.cjs';

// Runs the built CLI as a child process against an in-process resolver: RESOLV_URL points it at
// the server, NODE_EXTRA_CA_CERTS trusts the fixture certificate and stub-dns.cjs answers the
// PTR lookup, so nothing leaves the host. A short RESOLV_TIMEOUT drops the host interfaces that
// cannot reach the loopback server (VPN tunnels and the like) sooner.

const root = fileURLToPath(new URL('..', import.meta.url));
const stubDns = fileURLToPath(new URL('./fixtures/stub-dns.cjs', import.meta.url));
const hasDist = fs.existsSync(`${root}dist/cjs/cli.js`) && fs.existsSync(`${root}dist/esm/cli.js`);

function runCli(cli: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        execFile(
            process.execPath,
            ['--require', stubDns, cli],
            {
                cwd: root,
                timeout: 20 * 1000,
                env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath, NODE_OPTIONS: '', ...env }
            },
            (err, stdout, stderr) => resolve({ code: err ? Number(err.code) || 1 : 0, stdout, stderr })
        );
    });
}

// the children are independent, so they run side by side
describe('CLI', { concurrency: true, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    let resolver: Awaited<ReturnType<typeof startResolver>>;

    before(async () => {
        resolver = await startResolver('198.51.100.7');
    });

    after(async () => {
        await resolver.close();
    });

    for (const format of ['cjs', 'esm']) {
        it(`prints the resolved interfaces as JSON (${format} build)`, async () => {
            const { code, stdout, stderr } = await runCli(`dist/${format}/cli.js`, { RESOLV_URL: resolver.url, RESOLV_TIMEOUT: '0.5' });
            assert.equal(code, 0, stderr);
            const results = JSON.parse(stdout);
            assert.ok(Array.isArray(results));
            // the host's own interfaces may reach the loopback server too, all see the same address
            assert.ok(results.length >= 1, stdout);
            assert.equal(results.filter((entry: any) => entry.defaultInterface).length, 1, stdout);
            for (const entry of results) {
                assert.equal(entry.ip, '198.51.100.7');
                assert.equal(entry.name, 'cli.example');
                assert.equal(entry.family, 'IPv4');
            }
            // pretty printed with two spaces
            assert.match(stdout, /^\[\n {2}\{\n {4}"localAddress"/);
        });
    }

    it('prints an empty list when the resolver is unreachable', async () => {
        const { code, stdout } = await runCli('dist/cjs/cli.js', { RESOLV_URL: 'https://127.0.0.1:1/', RESOLV_TIMEOUT: '0.5' });
        assert.equal(code, 0);
        assert.deepEqual(JSON.parse(stdout), []);
    });
});
