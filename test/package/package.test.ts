import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// These tests exercise the compiled output in dist/ (built by the pretest script) through the
// package.json exports map, the same way an installed copy of the package is loaded. Node
// resolves the package name to the package itself when the specifier is used from inside it.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// A non-literal specifier keeps TypeScript from resolving the built types at type-check time,
// when dist/ may not exist yet
const packageName: string = 'pubface';

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'index.js')) && fs.existsSync(path.join(root, 'dist', 'esm', 'index.js'));

describe('Built package', { timeout: 120 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            for (const file of ['index.js', 'index.d.ts', 'cli.js', 'package-info.js']) {
                assert.ok(fs.existsSync(path.join(root, 'dist', format, file)), `${format}/${file}`);
            }
        }
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'esm', 'package.json'), 'utf8')), { type: 'module' });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('points every package.json entry at an existing file', () => {
        assert.equal(pkg.exports['.'].import, './dist/esm/index.js');
        assert.equal(pkg.exports['.'].require, './dist/cjs/index.js');
        assert.equal(pkg.main, './dist/cjs/index.js');
        assert.ok(fs.existsSync(path.join(root, pkg.types)), 'types entry exists');
        for (const target of [pkg.main, pkg.types, pkg.exports['.'].import, pkg.exports['.'].require, ...Object.values(pkg.bin as Record<string, string>)]) {
            assert.ok(fs.existsSync(path.join(root, target)), target);
        }
    });

    it('builds the command from the CommonJS output, the format pkg can bundle', () => {
        assert.deepEqual(pkg.bin, { pubface: 'dist/cjs/cli.js' });
        const cli = fs.readFileSync(path.join(root, pkg.bin.pubface), 'utf8');
        assert.ok(cli.startsWith('#!/usr/bin/env node\n'), 'keeps the shebang');
        assert.match(cli, /require\("\.\/index\.js"\)/);
        // the owner execute bit
        assert.ok(Math.floor(fs.statSync(path.join(root, pkg.bin.pubface)).mode / 0o100) % 2 === 1, 'is executable');
    });

    it('packs the build and leaves the sources and tests out', () => {
        // --ignore-scripts: prepare would rebuild dist/ under the running suite
        const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const files: string[] = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
        for (const required of [
            'package.json',
            'dist/cjs/index.js',
            'dist/cjs/index.d.ts',
            'dist/cjs/cli.js',
            'dist/cjs/package.json',
            'dist/esm/index.js',
            'dist/esm/package.json'
        ]) {
            assert.ok(files.includes(required), `${required} is packed`);
        }
        for (const file of files) {
            assert.ok(!/^(src|test|scripts|ee-dist|coverage)\//.test(file), `${file} must not be packed`);
        }
    });

    describe('CommonJS build', () => {
        it('resolves require() to the CommonJS entry point', () => {
            assert.equal(require.resolve(packageName), path.join(root, 'dist', 'cjs', 'index.js'));
        });

        it('keeps the shape of the pre-TypeScript module', () => {
            const pubface = require(packageName);
            assert.equal(typeof pubface.resolvePublicInterfaces, 'function');
            assert.equal(pubface.default.resolvePublicInterfaces, pubface.resolvePublicInterfaces);
            assert.equal(typeof pubface._internal.getPtrAddr, 'function');
            // destructuring, the way EmailEngine loads it
            const { resolvePublicInterfaces } = require(packageName);
            assert.equal(resolvePublicInterfaces, pubface.resolvePublicInterfaces);
        });

        it('keeps resolvePublicInterfaces writable on the module object', () => {
            // EmailEngine's tests replace it with a stub
            const descriptor = Object.getOwnPropertyDescriptor(require(packageName), 'resolvePublicInterfaces');
            assert.ok(descriptor && descriptor.writable && descriptor.enumerable, JSON.stringify(descriptor));
        });
    });

    describe('ES module build', () => {
        it('resolves import to the ES module entry point', async () => {
            const direct = await import(new URL('../../dist/esm/index.js', import.meta.url).href);
            const byName = await import(packageName);
            assert.equal(byName.resolvePublicInterfaces, direct.resolvePublicInterfaces);
        });

        it('exposes named and default exports', async () => {
            const pubface = await import(packageName);
            assert.equal(typeof pubface.resolvePublicInterfaces, 'function');
            assert.equal(pubface.default.resolvePublicInterfaces, pubface.resolvePublicInterfaces);
        });
    });

    // each tsc run has its own temporary project, so they run side by side
    describe('type declarations', { concurrency: true }, () => {
        it('keep the internals out', () => {
            for (const format of ['esm', 'cjs']) {
                const declaration = fs.readFileSync(path.join(root, 'dist', format, 'index.d.ts'), 'utf8');
                assert.ok(!declaration.includes('_internal'), `${format} declares _internal`);
                assert.ok(!declaration.includes('DnsCache'), `${format} declares DnsCache`);
            }
        });

        const esmConsumer = `
import { resolvePublicInterfaces } from 'pubface';
import pubface from 'pubface';
import type { PublicInterface } from 'pubface';

export async function run(): Promise<string[]> {
    const list: PublicInterface[] = await resolvePublicInterfaces();
    const other = await pubface.resolvePublicInterfaces();
    const local: string | false = list[0]!.localAddress;
    const family: 'IPv4' | 'IPv6' = other[0]!.family;
    const name: string | undefined = list[0]!.name;
    const isDefault: boolean | undefined = list[0]!.defaultInterface;
    void [local, family, name, isDefault];
    return list.map(entry => entry.ip);
}
`;

        const cjsConsumer = `
import pubface = require('pubface');

export async function run(): Promise<number> {
    const list = await pubface.resolvePublicInterfaces();
    return list.length;
}
`;

        const internalConsumer = `
import { _internal } from 'pubface';
void _internal;
`;

        // Type-checks a consumer against the built declarations the way an installed copy is
        // resolved: the package is linked into a temporary project, so the specifier goes
        // through the package.json exports map
        const typeCheck = async (source: string, compilerOptions: Record<string, unknown>, type?: string): Promise<{ status: number; output: string }> => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubface-types-'));
            try {
                fs.mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
                fs.symlinkSync(root, path.join(dir, 'node_modules', 'pubface'), 'dir');
                fs.symlinkSync(path.join(root, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'dir');
                fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
                fs.writeFileSync(path.join(dir, 'consumer.ts'), source);
                fs.writeFileSync(
                    path.join(dir, 'tsconfig.json'),
                    JSON.stringify({
                        compilerOptions: {
                            target: 'ES2022',
                            lib: ['ES2023'],
                            types: ['node'],
                            strict: true,
                            exactOptionalPropertyTypes: true,
                            noEmit: true,
                            ...compilerOptions
                        },
                        include: ['consumer.ts']
                    })
                );
                return await new Promise(resolve => {
                    execFile(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], (err, stdout, stderr) =>
                        resolve({ status: err ? Number(err.code) || 1 : 0, output: stdout + stderr })
                    );
                });
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        };

        const node16 = { module: 'node16', moduleResolution: 'node16' };

        for (const [label, options, type] of [
            ['a node16 ES module project', node16, 'module'],
            ['a node16 CommonJS project', node16, undefined],
            ['bundler resolution', { module: 'esnext', moduleResolution: 'bundler' }, 'module']
        ] as const) {
            it(`type-check an ES module style consumer in ${label}`, async () => {
                const { status, output } = await typeCheck(esmConsumer, { ...options, esModuleInterop: true }, type);
                assert.equal(status, 0, output);
            });
        }

        it('type-check a CommonJS consumer', async () => {
            const { status, output } = await typeCheck(cjsConsumer, node16);
            assert.equal(status, 0, output);
        });

        it('do not let a consumer reach the internals', async () => {
            const { status, output } = await typeCheck(internalConsumer, node16, 'module');
            assert.notEqual(status, 0);
            assert.match(output, /has no exported member '_internal'/);
        });
    });
});
